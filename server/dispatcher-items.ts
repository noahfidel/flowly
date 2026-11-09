import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  chatItemLimit,
  resolvedAskMs,
  seenIdLimit,
  storedChatItemsSchema,
  whatNextText,
  type ChangedCard,
  type ChatItem,
  type DispatcherNote,
  type StoredChatItem as Stored,
} from "../shared/dispatcher";
import type { Board } from "../shared/model";
import { logFailure } from "./error-report";
import type { DispatcherRecord } from "./dispatcher";

/** The dispatcher chat's own items (DISPATCHER-SPEC §9.1) and its "Changed since you looked" line (§9.2). */

/** Drops answered or dismissed asks older than 7 days, then keeps the newest `chatItemLimit` items, oldest first. */
export function pruneItems(items: readonly Stored[], now: number): Stored[] {
  const live = items.filter((item) => {
    if (item.kind !== "ask" || (item.state !== "answered" && item.state !== "dismissed")) return true;
    const resolved = Date.parse(item.resolvedAt ?? item.at);
    return !(now - resolved > resolvedAskMs);
  });
  const sorted = live.map((item, index) => ({ item, index })).sort((a, b) => a.item.at.localeCompare(b.item.at) || a.index - b.index);
  return sorted.slice(-chatItemLimit).map((x) => x.item);
}

/** One note row per note the dispatcher received in one batch (§9.1). */
export function noteItems(notes: readonly DispatcherNote[], at: string): Stored[] {
  return notes.map((note) => ({ id: `note-${randomUUID()}`, at, kind: "note", note }));
}

/** The mark the change line counts from: the user's Mark seen, else the dispatcher's start, else none (§9.2). */
/** Where "Changed since you looked" starts: a millisecond, and the events at exactly that ms already seen. */
export type SeenMark = { revision: number; ids: readonly string[] };

export function seenMark(record: Pick<DispatcherRecord, "seenRevision" | "seenIds" | "startedAt">): SeenMark | null {
  if (typeof record.seenRevision === "number") return { revision: record.seenRevision, ids: record.seenIds ?? [] };
  const started = record.startedAt ? Date.parse(record.startedAt) : NaN;
  return Number.isFinite(started) ? { revision: started, ids: [] } : null;
}

/**
 * "Changed since you looked" (§9.2): cards with an agent's or the system's event after `mark` (event revision =
 * its time in ms; at the mark's own ms, an event whose id was not seen), on live cards of live projects; newest
 * first. The user's own changes and the dispatcher's own actions are left out. Null when nothing changed.
 */
export function changeLine(board: Board, mark: SeenMark | null, dispatcherAgentId: string | null = null): ChatItem | null {
  if (mark === null) return null;
  const seenAtMark = new Set(mark.ids);
  const live = new Set(board.projects.filter((p) => !p.archivedAt).map((p) => p.id));
  const tasks = new Map(board.tasks.filter((t) => !t.archivedAt && live.has(t.projectId)).map((t) => [t.id, t]));
  const changed = new Map<string, { card: ChangedCard; newest: number }>();
  let newest = -Infinity;
  let newestIds: string[] = [];
  for (const event of board.events) {
    if (event.actor === "human" || (dispatcherAgentId && event.agentId === dispatcherAgentId)) continue;
    const revision = Date.parse(event.at);
    if (!(revision > mark.revision || (revision === mark.revision && !seenAtMark.has(event.id)))) continue;
    const task = tasks.get(event.taskId);
    if (!task) continue;
    if (revision > newest) [newest, newestIds] = [revision, [event.id]];
    else if (revision === newest) newestIds.push(event.id);
    const seen = changed.get(task.id);
    if (seen) {
      seen.card.events++;
      seen.newest = Math.max(seen.newest, revision);
    } else changed.set(task.id, { card: { taskId: task.id, projectId: task.projectId, title: task.title, status: task.status, events: 1 }, newest: revision });
  }
  if (!changed.size) return null;
  const cards = [...changed.values()].sort((a, b) => b.newest - a.newest);
  return { id: "change", at: new Date(newest).toISOString(), kind: "change", revision: newest, ids: newestIds.slice(-seenIdLimit), cards: cards.map((c) => c.card) };
}

/**
 * The change line for each open panel's poll without a board scan while nothing moved: one cached result,
 * keyed on the board's revision and last event, the mark and the dispatcher session (§9.2).
 */
export class ChangeLineCache {
  private last: { key: string; value: ChatItem | null } | null = null;
  constructor(private readonly scan: typeof changeLine = changeLine) {}
  get(board: Board, mark: SeenMark | null, dispatcherAgentId: string | null): ChatItem | null {
    const key = JSON.stringify([board.revision, board.events.length, board.events.at(-1)?.id ?? null, mark, dispatcherAgentId]);
    if (this.last?.key !== key) this.last = { key, value: this.scan(board, mark, dispatcherAgentId) };
    return this.last.value;
  }
}

/** The "What should I do?" message: the question, then the changed cards (§9.2). Agent-facing, English. */
export function whatNextMessage(change: ChatItem | null): string {
  if (!change || change.kind !== "change" || !change.cards.length) return whatNextText;
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  return [
    whatNextText,
    "",
    "Changed since I last looked:",
    ...change.cards.map((c) => `- "${oneLine(c.title)}" [${c.taskId}] in project ${c.projectId}: ${c.status}`),
  ].join("\n");
}

/** `<dataDir>/dispatcher-items.json`: atomic, serialized, pruned on write; a corrupt file is kept aside (§9.1). */
export class DispatcherItems {
  private cached: Stored[] | null = null;
  /** One first read at a time, so a corrupt file is kept aside once (and a fresh write is never moved). */
  private loading: Promise<Stored[]> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    readonly directory: string,
    private readonly deps: { now?: () => number } = {},
  ) {}
  get path() {
    return join(this.directory, "dispatcher-items.json");
  }

  async list(): Promise<Stored[]> {
    await this.writes;
    return [...(await this.load())];
  }

  /** Adds items, replacing any with the same id, then prunes and stores the list. */
  put(items: readonly Stored[]): Promise<void> {
    const job = this.writes.then(async () => {
      const current = await this.load();
      const incoming = new Map(items.map((item) => [item.id, item]));
      const merged = [...current.filter((item) => !incoming.has(item.id)), ...incoming.values()];
      const next = pruneItems(merged, this.now());
      const value = storedChatItemsSchema.parse({ version: 1, items: next });
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
        await rename(temporary, this.path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      this.cached = value.items as Stored[];
    });
    this.writes = job.catch(() => undefined);
    return job;
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private load(): Promise<Stored[]> {
    if (this.cached) return Promise.resolve(this.cached);
    this.loading ??= this.readFile().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async readFile(): Promise<Stored[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return (this.cached = []);
      throw e;
    }
    try {
      const parsed = storedChatItemsSchema.parse(JSON.parse(text));
      return (this.cached = parsed.items.filter((item): item is Stored => item.kind !== "change"));
    } catch (e) {
      const kept = `${this.path}.invalid-${this.now()}`;
      await rename(this.path, kept).catch((error) => logFailure("Flowly dispatcher chat items not preserved:", error));
      logFailure("Flowly dispatcher chat items are invalid; starting empty:", e, kept);
      return (this.cached = []);
    }
  }
}
