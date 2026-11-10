import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BackgroundJobs } from "./background-jobs";
import type { PaseoApi } from "@getpaseo/client";
import type { BoardStore } from "./store";
import { composerStateSchema, type ComposerState, type OutgoingImage } from "../shared/composer";

type QueuedImage = { file: string; mimeType: OutgoingImage["mimeType"] };
const extension: Record<OutgoingImage["mimeType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const empty = (): ComposerState => ({ version: 1, sessions: {} });

/**
 * Unsent drafts and queued follow-ups per session, persisted on the daemon so a
 * plugin reload or app refresh keeps them. Serialized writes, atomic replace,
 * invalid files are preserved (never reset).
 */
export class ComposerStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "composer.json");
  }
  /** Queued messages' images live beside composer.json until sent or removed. */
  get imageDirectory() {
    return join(this.directory, "composer-images");
  }
  async writeImages(itemId: string, images: readonly OutgoingImage[]): Promise<QueuedImage[]> {
    if (!images.length) return [];
    await mkdir(this.imageDirectory, { recursive: true, mode: 0o700 });
    return Promise.all(
      images.map(async (image, index) => {
        const file = `${itemId}-${index}.${extension[image.mimeType]}`;
        await writeFile(join(this.imageDirectory, file), Buffer.from(image.data, "base64"), { mode: 0o600 });
        return { file, mimeType: image.mimeType };
      }),
    );
  }
  async readImages(images: readonly QueuedImage[] = []): Promise<OutgoingImage[]> {
    return Promise.all(
      images.map(async (image) => {
        try {
          return { data: (await readFile(join(this.imageDirectory, image.file))).toString("base64"), mimeType: image.mimeType };
        } catch {
          throw new Error("An image attached to this queued message is missing.");
        }
      }),
    );
  }
  async removeImages(images: readonly QueuedImage[] = []) {
    await Promise.all(images.map((image) => rm(join(this.imageDirectory, image.file), { force: true })));
  }
  private async load(): Promise<ComposerState> {
    try {
      return composerStateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw new Error(`Composer data is invalid; preserved at ${this.path}. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async read() {
    await this.tail;
    return this.load();
  }
  mutate<T>(operation: (state: ComposerState) => T): Promise<T> {
    const job = this.tail.then(async () => {
      const state = await this.load();
      const value = operation(state);
      for (const [id, entry] of Object.entries(state.sessions))
        if (!entry.draft && !entry.queue.length && !entry.lastError) delete state.sessions[id];
      const next = composerStateSchema.parse(state);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, this.path);
      return value;
    });
    this.tail = job.then(() => undefined, () => undefined);
    return job;
  }
}

type Send = (paseo: PaseoApi, agentId: string, text: string, steer: boolean, images?: OutgoingImage[], messageId?: string) => Promise<void>;
const defaultSend: Send = async (paseo, agentId, text, steer, images, messageId) => {
  // The queued item's ID becomes the message ID, so the sending client can match its images.
  await paseo.agents.ref(agentId).send(text, {
    ...(steer ? { activeTurnBehavior: "steer" as const } : {}),
    ...(images?.length ? { images } : {}),
    ...(messageId ? { messageId } : {}),
  });
};

export class ComposerService {
  private draining = new Set<string>();
  private jobs = new BackgroundJobs();
  /** Resolves once no background drain check is left. */
  idle() {
    return this.jobs.idle();
  }
  private lastDrain = new Map<string, number>();
  constructor(
    readonly store: ComposerStore,
    readonly board: BoardStore,
    readonly send: Send = defaultSend,
    readonly clock = () => Date.now(),
  ) {}

  private entry(state: ComposerState, agentId: string, taskId: string) {
    return (state.sessions[agentId] ??= { taskId, draft: "", draftAt: null, queue: [], lastError: null });
  }

  /** The session must exist, belong to the card's workspace, and the card must be live. */
  private async verify(taskId: string, agentId: string, paseo: PaseoApi) {
    const board = await this.board.read();
    const task = board.tasks.find((t) => t.id === taskId);
    const project = task && board.projects.find((p) => p.id === task.projectId);
    if (!task || !project || task.archivedAt || project.archivedAt)
      throw new Error("Task is unavailable or archived.");
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent || agent.workspaceId !== task.workspaceId)
      throw new Error("Session is unavailable or belongs to a different workspace.");
    return agent;
  }

  read() {
    return this.store.read();
  }

  saveDraft(input: { taskId: string; agentId: string; text: string }) {
    return this.store.mutate((state) => {
      const entry = this.entry(state, input.agentId, input.taskId);
      entry.draft = input.text;
      entry.draftAt = new Date(this.clock()).toISOString();
      return { ok: true };
    });
  }

  async push(input: { taskId: string; agentId: string; text: string; images?: OutgoingImage[] }, paseo: PaseoApi) {
    await this.verify(input.taskId, input.agentId, paseo);
    const id = randomUUID();
    const images = await this.store.writeImages(id, input.images || []);
    const item = { id, text: input.text, at: new Date(this.clock()).toISOString(), ...(images.length ? { images } : {}) };
    try {
      await this.store.mutate((state) => {
        const entry = this.entry(state, input.agentId, input.taskId);
        if (entry.queue.length >= 50) throw new Error("Queue is full (50 messages).");
        entry.queue.push(item);
        entry.lastError = null;
      });
    } catch (error) {
      await this.store.removeImages(images);
      throw error;
    }
    // The turn may already have ended between the client's check and now.
    this.jobs.track(this.drain(input.agentId, paseo));
    return item;
  }

  async remove(input: { agentId: string; id: string }) {
    const removed = await this.store.mutate((state) => {
      const entry = state.sessions[input.agentId];
      const found = entry?.queue.find((m) => m.id === input.id);
      if (entry) entry.queue = entry.queue.filter((m) => m.id !== input.id);
      return found;
    });
    await this.store.removeImages(removed?.images);
    return { ok: true };
  }

  /** "Send now": steer the running turn with a queued message (Paseo parity). */
  async sendNow(input: { taskId: string; agentId: string; id: string }, paseo: PaseoApi) {
    const agent = await this.verify(input.taskId, input.agentId, paseo);
    const item = await this.store.mutate((state) => {
      const entry = state.sessions[input.agentId];
      const found = entry?.queue.find((m) => m.id === input.id);
      if (!entry || !found) throw new Error("That queued message was already sent or removed.");
      entry.queue = entry.queue.filter((m) => m.id !== input.id);
      return found;
    });
    const running = agent.status === "running" || agent.status === "initializing";
    try {
      await this.send(paseo, input.agentId, item.text, running, await this.store.readImages(item.images), item.id);
      await this.store.removeImages(item.images);
    } catch (error) {
      await this.store.mutate((state) => {
        const entry = this.entry(state, input.agentId, input.taskId);
        entry.queue.unshift(item);
      });
      throw error;
    }
    return { sent: true };
  }

  /**
   * Sends the oldest queued message once the session is idle. Called on
   * turn end, after a push, and opportunistically on reads; one message per
   * turn (a short cooldown prevents a stale "idle" snapshot double-sending).
   */
  async drain(agentId: string, paseo: PaseoApi) {
    if (this.draining.has(agentId)) return false;
    if (this.clock() - (this.lastDrain.get(agentId) || 0) < 8000) return false;
    this.draining.add(agentId);
    try {
      const state = await this.store.read();
      const entry = state.sessions[agentId];
      if (!entry?.queue.length) return false;
      const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
      if (!agent || agent.status === "running" || agent.status === "initializing") return false;
      if (agent.pendingPermissions?.length) return false;
      const board = await this.board.read();
      const task = board.tasks.find((t) => t.id === entry.taskId);
      if (!task || task.archivedAt || agent.workspaceId !== task.workspaceId) return false;
      const item = await this.store.mutate((s) => {
        const e = s.sessions[agentId];
        return e?.queue.shift() ?? null;
      });
      if (!item) return false;
      this.lastDrain.set(agentId, this.clock());
      try {
        await this.send(paseo, agentId, item.text, false, await this.store.readImages(item.images), item.id);
        await this.store.removeImages(item.images);
        await this.store.mutate((s) => {
          const e = s.sessions[agentId];
          if (e) e.lastError = null;
        });
        return true;
      } catch (error) {
        await this.store.mutate((s) => {
          const e = this.entry(s, agentId, entry.taskId);
          e.queue.unshift(item);
          e.lastError = error instanceof Error ? error.message : String(error);
        });
        return false;
      }
    } finally {
      this.draining.delete(agentId);
    }
  }

  async drainAll(paseo: PaseoApi) {
    // Drafts/queues of wrapped-up (archived) or deleted cards are dropped.
    const board = await this.board.read();
    const live = new Set(board.tasks.filter((t) => !t.archivedAt).map((t) => t.id));
    const before = await this.store.read();
    if (Object.values(before.sessions).some((e) => !live.has(e.taskId))) {
      const dropped = await this.store.mutate((s) => {
        const images: QueuedImage[] = [];
        for (const [id, e] of Object.entries(s.sessions))
          if (!live.has(e.taskId)) {
            for (const m of e.queue) images.push(...(m.images || []));
            delete s.sessions[id];
          }
        return images;
      });
      await this.store.removeImages(dropped);
    }
    const state = await this.store.read();
    for (const [agentId, entry] of Object.entries(state.sessions))
      if (entry.queue.length) this.jobs.track(this.drain(agentId, paseo));
  }
}
