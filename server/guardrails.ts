import { mkdir, readFile, writeFile, rename, copyFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { guardrailLearnedAction, guardrailRetiredAction, type ChangeSize, type GuardrailChange, type Project, type ReviewItem, type Task } from "../shared/model";
import { memoryStateSchema, titleKey } from "../shared/memory";
import {
  archivedOverflow,
  catchUpLimits,
  caughtIds,
  caughtInWindow,
  commandRoom,
  countCaught,
  countReview,
  countMisfire,
  countMissed,
  emptyCounts,
  emptyGuardrailsState,
  guardrailLimits,
  guardrailsSection,
  guardrailsStateSchema,
  guardrailsMaterial,
  guidelineToDisplace,
  hasSecret,
  inScope,
  liveEntry,
  mergeInto,
  mergePair,
  migrateToGuardrails,
  noteToDisplace,
  openItemOverflow,
  promotedGuideline,
  resolveShortId,
  retirement,
  setState,
  textKey,
  widenScope,
  type CardItem,
  type CardShape,
  type Correction,
  type GuardrailEntry,
  type GuardrailScope,
  type GuardrailState,
  type GuardrailsState,
  type GuardrailsView,
} from "../shared/guardrails";
import type { MemoryKind } from "../shared/memory";
import type { BoardStore } from "./store";
import { detectProjectCommands, readRepoFiles, scriptNamesOf, whitelistCommands, type DetectedCommand, type RepoFiles } from "./review-detect";
import { classify, type CommandRecord } from "../shared/workflow-insights";
import { logFailure } from "./error-report";

/** Settings → AI features → Guardrails (`features.memory`, GUARDRAILS-SPEC §8); kept current by the plugin's settings subscription. */
let guardrailsEverywhere = true;
export function setMemoryEverywhere(on: boolean) {
  guardrailsEverywhere = on;
}
/** Host and project switch both on (B4): learn, inject, retro, and judge guidelines and card items. */
export const memoryOn = (project: Pick<Project, "memory"> | undefined) => guardrailsEverywhere && !!project && project.memory !== false;

/** A refusal of a guardrails RPC; `code` is what a client or tool reads. */
export class GuardrailError extends Error {
  constructor(
    readonly code: "GUARDRAIL_CONFLICT" | "GUARDRAIL_LIMIT" | "NOT_FOUND" | "INVALID_INPUT" | "MEMORY_SECRET" | "MEMORY_DUPLICATE",
    message: string,
  ) {
    super(message);
  }
}

export type MigrationResult = "present" | "migrated" | "failed";

/** `guardrails.json` (GUARDRAILS-SPEC §3.1): serialized writes, `.bak` backup, atomic replacement; invalid data is preserved. */
export class GuardrailsStore {
  private tail: Promise<unknown> = Promise.resolve();
  /** The memory.json a failed migration could not move: writes are refused until a migration succeeds (§3.6). */
  private migrationFailed: string | null = null;
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "guardrails.json");
  }
  private async load(): Promise<GuardrailsState> {
    try {
      return guardrailsStateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyGuardrailsState();
      throw new Error(`Guardrails data is invalid; preserved at ${this.path}. Restore a valid backup before continuing.`);
    }
  }
  async read() {
    await this.tail;
    return this.load();
  }
  private queue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  private async write(state: GuardrailsState) {
    guardrailsStateSchema.parse(state);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
      try {
        await copyFile(this.path, `${this.path}.bak`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  update<T>(operation: (state: GuardrailsState) => Promise<{ value: T; changed: boolean }> | { value: T; changed: boolean }): Promise<T> {
    return this.queue(async () => {
      // A write would create guardrails.json and the next start would never migrate.
      if (this.migrationFailed) throw new Error(`Guardrails migration from memory.json failed; nothing is saved until it is fixed (see ${this.migrationFailed})`);
      const state = await this.load();
      const { value, changed } = await operation(state);
      if (!changed) return value;
      state.revision++;
      await this.write(state);
      return value;
    });
  }
  /**
   * The one-time move (§3.6), queued ahead of every read and write: when guardrails.json does not exist, the
   * former memory.json (if any) and the projects' review rules become its first content and memory.json is
   * renamed to memory.json.migrated. On failure both files stay as they are, the store reads empty and refuses
   * writes until a later migration succeeds.
   */
  migrate(projects: () => Promise<readonly Project[]>, now = () => new Date().toISOString()): Promise<MigrationResult> {
    return this.queue(async () => {
      try {
        await readFile(this.path);
        this.migrationFailed = null;
        return "present";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const memoryPath = join(this.directory, "memory.json");
      try {
        let memory = null;
        try {
          memory = memoryStateSchema.parse(JSON.parse(await readFile(memoryPath, "utf8")));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const list = await projects();
        // Nothing to carry over: the file appears with the first write.
        if (!memory && !list.some((p) => p.autoReview)) {
          this.migrationFailed = null;
          return "present";
        }
        await this.write(migrateToGuardrails(memory, list, now(), randomUUID));
        this.migrationFailed = null;
        if (memory) await rename(memoryPath, `${memoryPath}.migrated`).catch((e) => logFailure("Flowly guardrails: memory.json not renamed:", e));
        return "migrated";
      } catch (error) {
        logFailure("Flowly guardrails migration failed:", error, memoryPath);
        this.migrationFailed = memoryPath;
        return "failed";
      }
    });
  }
}

/** One store per data directory, so every writer shares one queue. */
const stores = new Map<string, GuardrailsStore>();
export function guardrailsStore(directory: string) {
  let store = stores.get(directory);
  if (!store) stores.set(directory, (store = new GuardrailsStore(directory)));
  return store;
}

/** A JSON backup under `removed/` (written exclusively, never overwritten). */
export async function writeBackup(directory: string, name: string, content: object, at: string) {
  const folder = join(directory, "removed");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, `${name}-${at.replace(/[:.]/g, "-")}.json`);
  await writeFile(path, JSON.stringify({ removedAt: at, ...content }, null, 2), { mode: 0o600, flag: "wx" });
  return path;
}

/** Archived entries past the cap are deleted after a backup (§3.4). */
export async function pruneArchived(directory: string, state: GuardrailsState, projectId: string, at: string) {
  const drop = archivedOverflow(state.entries, projectId);
  if (!drop.length) return;
  await writeBackup(directory, `${projectId}-guardrails-pruned`, { entries: drop }, at);
  const gone = new Set(drop);
  state.entries = state.entries.filter((e) => !gone.has(e));
}

/** Card deleted (§3.5): its open and closed items, clues, errors and retro record go (backed up); promoted items and entries stay. */
export function removeTaskGuardrails(store: GuardrailsStore, taskId: string, at: string) {
  return store.update(async (state) => {
    const items = state.items.filter((i) => i.taskId === taskId && i.state !== "promoted");
    const clues = state.clues.filter((c) => c.taskId === taskId);
    const errors = state.errors.filter((e) => e.taskId === taskId);
    if (!items.length && !clues.length && !errors.length && !state.retros.some((r) => r.taskId === taskId)) return { value: null, changed: false };
    if (items.length || clues.length) await writeBackup(store.directory, `task-${taskId}-guardrails`, { items, clues }, at);
    const gone = new Set(items);
    state.items = state.items.filter((i) => !gone.has(i));
    state.clues = state.clues.filter((c) => c.taskId !== taskId);
    state.errors = state.errors.filter((e) => e.taskId !== taskId);
    state.retros = state.retros.filter((r) => r.taskId !== taskId);
    return { value: null, changed: true };
  });
}

/** Project Remove (§3.5): everything of the project, backed up to `removed/<projectId>-guardrails-<time>.json` first. */
export function removeProjectGuardrails(store: GuardrailsStore, projectId: string, taskIds: ReadonlySet<string>, at: string) {
  return store.update(async (state) => {
    const entries = state.entries.filter((e) => e.projectId === projectId);
    const items = state.items.filter((i) => i.projectId === projectId);
    const clues = state.clues.filter((c) => c.projectId === projectId);
    const errors = state.errors.filter((e) => e.projectId === projectId);
    const retros = state.retros.filter((r) => taskIds.has(r.taskId));
    if (!entries.length && !items.length && !clues.length && !errors.length && !retros.length && !state.recallStats[projectId]) return { value: null, changed: false };
    await writeBackup(store.directory, `${projectId}-guardrails`, { entries, items, clues, errors, retros }, at);
    state.entries = state.entries.filter((e) => e.projectId !== projectId);
    state.items = state.items.filter((i) => i.projectId !== projectId);
    state.clues = state.clues.filter((c) => c.projectId !== projectId);
    state.errors = state.errors.filter((e) => e.projectId !== projectId);
    state.retros = state.retros.filter((r) => !taskIds.has(r.taskId));
    delete state.recallStats[projectId];
    return { value: null, changed: true };
  });
}

type CardEvent = { taskId: string; action: string; note: string; guardrail: GuardrailChange };

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const bump = (entry: GuardrailEntry, at: string) => {
  entry.revision++;
  entry.updatedAt = at;
};
const addSource = (entry: GuardrailEntry, source: { taskId: string; at: string; quote?: string }) => {
  if (entry.sources.some((s) => s.taskId === source.taskId)) return;
  entry.sources = [...entry.sources, source].slice(-guardrailLimits.sources);
};

export type CommandInput = { projectId: string; kind: "command"; text: string; argv: string[]; timeoutSec?: number };
export type NoteInput = { projectId: string; kind: "note"; noteKind: MemoryKind; text: string; body?: string; tags?: string[]; keywords?: string[]; pinned?: boolean };
export type EntryEdit = {
  id: string;
  revision: number;
  text?: string;
  body?: string;
  argv?: string[];
  timeoutSec?: number;
  scope?: GuardrailScope;
  tags?: string[];
  keywords?: string[];
  pinned?: boolean;
  state?: GuardrailState;
  stateReason?: string;
};

/** get_task.guardrails (§5.2). */
export type TaskGuardrails = {
  enabled: boolean;
  maxRounds: number;
  commands: { id: string; name: string; argv: string[]; state: "active" | "observing" }[];
  guidelines: { id: string; text: string; scope: GuardrailScope }[];
  items: { id: string; text: string; count: number }[];
  lastReview?: Task["review"];
};

/** Learning, notes bookkeeping, the Guardrails page RPCs and the cascades (GUARDRAILS-SPEC §3–§5, §7.5). */
export class GuardrailsService {
  readonly store: GuardrailsStore;
  constructor(
    readonly board: BoardStore,
    private now = () => Date.now(),
    private detectCommands: (root: string) => Promise<DetectedCommand[]> = detectProjectCommands,
    /** Cards whose finished-card review is running (owned by the memory service). */
    private running: () => readonly string[] = () => [],
    private readFiles: (root: string) => Promise<RepoFiles> = readRepoFiles,
  ) {
    this.store = guardrailsStore(board.directory);
  }
  private iso() {
    return new Date(this.now()).toISOString();
  }

  // ---- Reads ----------------------------------------------------------------------

  async view(projectId: string): Promise<GuardrailsView> {
    const [state, board] = await Promise.all([this.store.read(), this.board.read()]);
    const project = board.projects.find((p) => p.id === projectId);
    if (!project) throw new GuardrailError("NOT_FOUND", "Project not found.");
    return {
      entries: state.entries.filter((e) => e.projectId === projectId),
      items: state.items.filter((i) => i.projectId === projectId),
      errors: state.errors.filter((e) => e.projectId === projectId),
      running: this.running().filter((id) => board.tasks.some((t) => t.id === id && t.projectId === projectId)),
      enabled: memoryOn(project),
    };
  }
  /** The overview chips (§7.4): observing commands and guidelines learned in the last 7 days, and memory added in them, per project. */
  async counts(): Promise<Record<string, { observing: number; added: number; notes: number }>> {
    const state = await this.store.read();
    const since = this.now() - 7 * 86_400_000;
    const out: Record<string, { observing: number; added: number; notes: number }> = {};
    for (const e of state.entries) {
      const observing = e.kind === "command" && e.state === "observing";
      const recent = Date.parse(e.createdAt) >= since;
      const added = e.kind === "guideline" && e.by === "learned" && recent;
      const note = e.kind === "note" && e.state !== "archived" && recent;
      if (!observing && !added && !note) continue;
      const c = (out[e.projectId] ||= { observing: 0, added: 0, notes: 0 });
      if (observing) c.observing++;
      if (added) c.added++;
      if (note) c.notes++;
    }
    return out;
  }
  /** get_task.guardrails (§5.2): commands always; guidelines and this card's items only while Guardrails is on (B4). */
  async taskContext(task: Task, project: Project, maxRounds: number): Promise<TaskGuardrails> {
    const state = await this.store.read();
    const own = state.entries.filter((e) => e.projectId === project.id);
    const on = memoryOn(project);
    const shape: CardShape = { type: task.type, size: task.review?.shape?.size };
    return {
      enabled: !!project.autoReview?.enabled,
      maxRounds,
      commands: own
        .filter((e): e is GuardrailEntry & { state: "active" | "observing" } => e.kind === "command" && (e.state === "active" || e.state === "observing"))
        .map((e) => ({ id: e.id, name: e.text, argv: e.argv || [], state: e.state })),
      guidelines: on ? own.filter((e) => e.kind === "guideline" && e.state === "active" && inScope(e, shape)).map((e) => ({ id: e.id, text: e.text, scope: e.scope || { types: "all", sizes: "all" } })) : [],
      items: on ? state.items.filter((i) => i.taskId === task.id && i.state === "open").map((i) => ({ id: i.id, text: i.text, count: i.count })) : [],
      ...(task.review ? { lastReview: task.review } : {}),
    };
  }

  // ---- The delivery review (§6) ----------------------------------------------------

  /**
   * What a delivery of this card is checked against (§6.3): the project's active and observing commands; while
   * Guardrails is on (B4) the active guidelines in scope for the card's type and this delivery's size, and the card's
   * open items. `words`: the user's own words for each guideline and item, for the review session and the rework message.
   */
  async reviewInput(task: Task, project: Project, size: ChangeSize | undefined) {
    const state = await this.store.read();
    const own = state.entries.filter((e) => e.projectId === project.id);
    const on = memoryOn(project);
    const commands = own.filter((e) => e.kind === "command" && (e.state === "active" || e.state === "observing"));
    const guidelines = on ? own.filter((e) => e.kind === "guideline" && e.state === "active" && inScope(e, { type: task.type, size })) : [];
    const items = on ? state.items.filter((i) => i.taskId === task.id && i.state === "open") : [];
    const words = new Map<string, string>();
    for (const g of guidelines) {
      const quote = [...g.sources].reverse().find((s) => s.quote)?.quote;
      if (quote) words.set(g.id, quote);
    }
    for (const i of items) if (i.quote) words.set(i.id, i.quote);
    return { commands, guidelines, items, words };
  }

  /**
   * The end of a review that judged something (§6.6, §6.7): each command and guideline it checked counts a review
   * (passed and na as passes); a command that could not run counts toward pausing it, an observing one toward its
   * promotion; what failed in the card's previous review and passed now counts as caught (not when disputed). Then
   * every entry of the project is checked for automatic retirement. Counts do not change an entry's revision; a state
   * change does, with a `guardrail_retired` event for pauses and archives.
   */
  async reviewed(input: { projectId: string; taskId: string; items: readonly ReviewItem[]; previous?: readonly ReviewItem[]; disputed: readonly string[] }): Promise<void> {
    const events = await this.store.update(async (state) => {
      const at = this.iso();
      const own = state.entries.filter((e) => e.projectId === input.projectId);
      const byId = new Map(own.map((e) => [e.id, e]));
      let changed = false;
      for (const item of input.items) {
        const entry = byId.get(item.id);
        if (!entry) continue;
        if (entry.kind === "command") {
          if (item.state === "unavailable") entry.counts.unavailableRun = (entry.counts.unavailableRun || 0) + 1;
          else if (item.state === "passed" || item.state === "failed") {
            entry.counts.unavailableRun = 0;
            countReview(entry.counts, item.state);
            if (entry.state === "observing") {
              const observe = entry.observe || { reviews: 0, passed: 0 };
              entry.observe = { reviews: observe.reviews + 1, passed: observe.passed + (item.state === "passed" ? 1 : 0) };
            }
          } else continue;
        } else if (entry.kind === "guideline") {
          if (item.state !== "passed" && item.state !== "failed" && item.state !== "na") continue;
          countReview(entry.counts, item.state);
        } else continue;
        changed = true;
      }
      for (const id of caughtIds(input.previous, input.items, input.disputed)) {
        const entry = byId.get(id);
        if (!entry) continue;
        countCaught(entry.counts, at);
        changed = true;
      }
      const retired = applyRetirement(state, input.projectId, this.now(), at);
      if (retired.length) await pruneArchived(this.store.directory, state, input.projectId, at);
      return { value: retired, changed: changed || retired.length > 0 };
    });
    await this.recordRetired(events, () => input.taskId);
  }

  // ---- The weekly run (§7.3) ----------------------------------------------------------

  /**
   * Step 1 of the weekly run, no model (§4.5, §6.7): with `commands` (Auto review on) a command whose script left the
   * repository pauses ("script missing"), and a whitelisted check agents ran on at least 3 cards in the last 30 days
   * (`records`, the project's command log) joins as observing; then every entry is checked for retirement.
   */
  async weekly(projectId: string, input: { records: readonly CommandRecord[]; commands: boolean }): Promise<{ added: GuardrailEntry[]; retired: GuardrailEntry[] }> {
    const project = (await this.board.read()).projects.find((p) => p.id === projectId);
    if (!project || project.archivedAt) return { added: [], retired: [] };
    const files = input.commands ? await this.readFiles(project.primaryPath).catch(() => null) : null;
    const result = await this.store.update(async (state) => {
      const at = this.iso();
      const added: GuardrailEntry[] = [];
      const retired: GuardrailEntry[] = [];
      if (files) {
        const names = scriptNamesOf(files);
        const since = this.now() - 30 * 86_400_000;
        const recent = input.records.filter((r) => Date.parse(r.at) >= since);
        for (const e of state.entries)
          if (e.projectId === projectId && e.kind === "command" && (e.state === "active" || e.state === "observing") && scriptMissing(e.argv || [], names)) {
            setState(e, "paused", "script missing", at);
            bump(e, at);
            retired.push(e);
          }
        for (const c of whitelistCommands(files)) {
          const own = state.entries.filter((e) => e.projectId === projectId && e.kind === "command");
          if (own.some((e) => textKey(e.text) === textKey(c.name) || (e.argv || []).join("\u0000") === c.argv.join("\u0000"))) continue;
          if (usageCards(c.argv, recent) < 3) continue;
          if (commandRoom(state.entries, projectId) <= 0) break;
          const entry: GuardrailEntry = {
            id: randomUUID(),
            projectId,
            kind: "command",
            text: clip(c.name, guardrailLimits.commandName),
            argv: [...c.argv],
            observe: { reviews: 0, passed: 0 },
            state: "observing",
            stateAt: at,
            counts: emptyCounts(),
            sources: [],
            by: "detect",
            revision: 1,
            createdAt: at,
            updatedAt: at,
          };
          state.entries.push(entry);
          added.push(entry);
        }
      }
      retired.push(...applyRetirement(state, projectId, this.now(), at));
      if (retired.length) await pruneArchived(this.store.directory, state, projectId, at);
      return { value: { added, retired }, changed: added.length > 0 || retired.length > 0 };
    });
    await this.recordRetired(result.retired, () => undefined);
    return result;
  }

  /**
   * The weekly catch-up's input (§7.3): for a project with Guardrails on, the `feedback` clues of the last 7 days not
   * learned from yet (at most 30, oldest first) and the project's guardrails as the summarizer sees them.
   */
  async catchUpInput(projectId: string): Promise<{ clues: { taskId: string; text: string; at: string }[]; section: string[] } | null> {
    const [board, state] = await Promise.all([this.board.read(), this.store.read()]);
    const project = board.projects.find((p) => p.id === projectId);
    if (!project || project.archivedAt || !memoryOn(project)) return null;
    const since = Math.max(this.now() - catchUpLimits.days * 86_400_000, Date.parse(state.learnedUntil?.[projectId] || "") || 0);
    const clues = state.clues
      .filter((c) => c.projectId === projectId && c.kind === "feedback" && Date.parse(c.at) > since && board.tasks.some((t) => t.id === c.taskId))
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-catchUpLimits.clues)
      .map((c) => ({ taskId: c.taskId, text: c.text, at: c.at }));
    if (!clues.length) return null;
    const section = guardrailsSection({ entries: state.entries, items: state.items, projectId, taskId: "", shape: {}, now: this.now() });
    return { clues, section };
  }
  /** Learns from the catch-up's answers, one clue at a time through the same bookkeeping as a rework turn, and marks them learned. */
  async catchUp(projectId: string, clues: readonly { taskId: string; text: string; at: string }[], corrections: readonly Correction[]) {
    for (const [i, clue] of clues.entries()) {
      const correction = corrections[i];
      if (correction && correction.kind !== "none")
        await this.learn({ taskId: clue.taskId, correction, quote: clue.text }).catch((e) => logFailure("Flowly guardrail not learned:", e, clue.taskId));
    }
    const until = clues.reduce((max, c) => (c.at > max ? c.at : max), "");
    if (!until) return;
    await this.store.update((state) => {
      state.learnedUntil = { ...(state.learnedUntil || {}), [projectId]: until };
      return { value: undefined, changed: true };
    });
  }

  /** The `# Guardrails` material of the weekly run (§7.3 step 2); "" while Guardrails is off for the project. */
  async material(projectId: string, flow: readonly { at: string; taskId: string; action: string; results?: readonly { id: string; state: string; kind?: string }[] }[]): Promise<string> {
    const [board, state] = await Promise.all([this.board.read(), this.store.read()]);
    const project = board.projects.find((p) => p.id === projectId);
    if (!project || !memoryOn(project)) return "";
    const from = this.now() - 30 * 86_400_000;
    const reviews = flow
      .filter((e) => e.action === "review_finished" && e.results?.length && Date.parse(e.at) >= from)
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((e) => ({ taskId: e.taskId, at: e.at, results: e.results! }));
    return guardrailsMaterial({
      entries: state.entries,
      items: state.items,
      projectId,
      reviews,
      caught30: caughtInWindow(flow, from),
      cardTitle: (id) => board.tasks.find((t) => t.id === id)?.title,
    });
  }

  /**
   * Merges the weekly run proposed (§7.3): at most 5; each needs two distinct active entries of the project of the
   * same kind, else it is dropped. `drop` is archived as merged into `keep`; a `guardrail_retired` event records it.
   */
  async merge(projectId: string, merges: readonly { keep: string; drop: string; why: string }[]): Promise<GuardrailEntry[]> {
    const project = (await this.board.read()).projects.find((p) => p.id === projectId);
    if (!project || project.archivedAt || !memoryOn(project) || !merges.length) return [];
    const dropped = await this.store.update(async (state) => {
      const at = this.iso();
      const out: GuardrailEntry[] = [];
      for (const m of merges.slice(0, 5)) {
        const pair = mergePair(state.entries, projectId, m);
        if (!pair) continue;
        mergeInto(pair.keep, pair.drop, at);
        bump(pair.keep, at);
        bump(pair.drop, at);
        out.push(pair.drop);
      }
      if (out.length) await pruneArchived(this.store.directory, state, projectId, at);
      return { value: out, changed: out.length > 0 };
    });
    await this.recordRetired(dropped, () => undefined);
    return dropped;
  }

  /** `guardrail_retired` events on a card of the project (the flow log is per card); none when it has no card. */
  private async recordRetired(retired: readonly GuardrailEntry[], taskFor: (entry: GuardrailEntry) => string | undefined) {
    if (!retired.length) return;
    await this.board
      .mutate((board) => {
        for (const entry of retired) {
          const wanted = taskFor(entry);
          const taskId =
            (wanted && board.tasks.some((t) => t.id === wanted) ? wanted : undefined) ??
            [...entry.sources].reverse().find((s) => board.tasks.some((t) => t.id === s.taskId))?.taskId ??
            board.tasks.filter((t) => t.projectId === entry.projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id;
          if (!taskId) continue;
          const change = entry.stateReason === "merged" ? "merged" : entry.state === "paused" ? "paused" : "archived";
          this.board.event(board, {
            taskId,
            actor: "system",
            action: guardrailRetiredAction,
            note: clip(`${entry.text} (${entry.stateReason || change})`, 1000),
            guardrail: { change, kind: entry.kind, id: entry.id },
          });
        }
      })
      .catch((e) => logFailure("Flowly guardrail event not recorded:", e));
  }

  // ---- Edits (§7.5) ---------------------------------------------------------------

  private async project(projectId: string) {
    const project = (await this.board.read()).projects.find((p) => p.id === projectId);
    if (!project) throw new GuardrailError("NOT_FOUND", "Project not found.");
    if (project.archivedAt) throw new GuardrailError("INVALID_INPUT", "This project is archived; its guardrails are read-only.");
    return project;
  }
  /** A person's command or note, active at once. */
  async create(input: CommandInput | NoteInput): Promise<GuardrailEntry> {
    await this.project(input.projectId);
    return this.store.update(async (state) => {
      const own = state.entries.filter((e) => e.projectId === input.projectId);
      const at = this.iso();
      const base = { id: randomUUID(), projectId: input.projectId, state: "active" as const, stateAt: at, counts: emptyCounts(), sources: [], by: "user" as const, revision: 1, createdAt: at, updatedAt: at };
      let entry: GuardrailEntry;
      if (input.kind === "command") {
        if (commandRoom(state.entries, input.projectId) <= 0) throw new GuardrailError("GUARDRAIL_LIMIT", `A project runs at most ${guardrailLimits.commandsLive} commands. Pause or delete one first.`);
        if (own.some((e) => e.kind === "command" && textKey(e.text) === textKey(input.text))) throw new GuardrailError("MEMORY_DUPLICATE", "This project already has a command with that name.");
        entry = { ...base, kind: "command", text: input.text.trim(), argv: input.argv, ...(input.timeoutSec ? { timeoutSec: input.timeoutSec } : {}) };
      } else {
        checkNote(input.text, input.body || "", input.keywords || []);
        if (own.some((e) => e.kind === "note" && e.state === "active" && titleKey(e.text) === titleKey(input.text))) throw new GuardrailError("MEMORY_DUPLICATE", "This project already has a note with that title.");
        if (input.pinned && pinnedCount(own) >= guardrailLimits.pinned) throw new GuardrailError("GUARDRAIL_LIMIT", `A project can pin at most ${guardrailLimits.pinned} memories. Unpin one first.`);
        entry = {
          ...base,
          kind: "note",
          noteKind: input.noteKind,
          text: input.text.trim(),
          ...(input.body?.trim() ? { body: input.body.trim() } : {}),
          tags: input.tags || [],
          keywords: input.keywords || [],
          ...(input.pinned ? { pinned: true } : {}),
        };
      }
      state.entries.push(entry);
      displaceNotes(state, input.projectId, entry.id, at);
      await pruneArchived(this.store.directory, state, input.projectId, at);
      return { value: entry, changed: true };
    });
  }
  /** Edit, pause, resume, archive or revive; a stale revision is GUARDRAIL_CONFLICT. */
  async update(input: EntryEdit): Promise<GuardrailEntry> {
    const before = (await this.store.read()).entries.find((e) => e.id === input.id);
    if (!before) throw new GuardrailError("NOT_FOUND", "This guardrail no longer exists. Reload to see the latest.");
    await this.project(before.projectId);
    return this.store.update(async (state) => {
      const entry = state.entries.find((e) => e.id === input.id);
      if (!entry) throw new GuardrailError("NOT_FOUND", "This guardrail no longer exists. Reload to see the latest.");
      if (entry.revision !== input.revision) throw new GuardrailError("GUARDRAIL_CONFLICT", "This guardrail changed elsewhere. Reload to see the latest.");
      const at = this.iso();
      const own = state.entries.filter((e) => e.projectId === entry.projectId && e.id !== entry.id);
      const next = { ...entry };
      if (input.text !== undefined) next.text = input.text.trim();
      if (input.body !== undefined) next.body = input.body.trim() || undefined;
      if (entry.kind === "command") {
        if (input.argv !== undefined) next.argv = input.argv;
        if (input.timeoutSec !== undefined) next.timeoutSec = input.timeoutSec;
      } else if (input.argv !== undefined || input.timeoutSec !== undefined) throw new GuardrailError("INVALID_INPUT", "Only commands have argv and a timeout.");
      if (input.scope !== undefined) {
        if (entry.kind !== "guideline") throw new GuardrailError("INVALID_INPUT", "Only guidelines have a scope.");
        next.scope = input.scope;
      }
      if (entry.kind === "note") {
        if (input.tags !== undefined) next.tags = input.tags;
        if (input.keywords !== undefined) next.keywords = input.keywords;
        if (input.pinned !== undefined) next.pinned = input.pinned;
        checkNote(next.text, next.body || "", next.keywords || []);
        if (titleKey(next.text) !== titleKey(entry.text) && own.some((e) => e.kind === "note" && e.state === "active" && titleKey(e.text) === titleKey(next.text)))
          throw new GuardrailError("MEMORY_DUPLICATE", "This project already has a note with that title.");
      } else if (input.tags !== undefined || input.keywords !== undefined || input.pinned !== undefined) throw new GuardrailError("INVALID_INPUT", "Only memories have tags, keywords and a pin.");
      else if (hasSecret(next.text, next.body)) throw new GuardrailError("MEMORY_SECRET", "This looks like it contains a secret (token, key or password). Guardrails never store credentials.");
      const state2 = input.state ?? entry.state;
      if (state2 === "observing" && entry.kind !== "command") throw new GuardrailError("INVALID_INPUT", "Only commands can be observing.");
      if (next.pinned && !entry.pinned && (state2 !== "active" || pinnedCount(own) >= guardrailLimits.pinned))
        throw new GuardrailError("GUARDRAIL_LIMIT", `Only active memories can be pinned, at most ${guardrailLimits.pinned} per project. Unpin one first.`);
      const live = (s: GuardrailState) => s === "active" || s === "observing";
      if (entry.kind === "command" && live(state2) && !live(entry.state) && commandRoom(state.entries, entry.projectId) <= 0)
        throw new GuardrailError("GUARDRAIL_LIMIT", `A project runs at most ${guardrailLimits.commandsLive} commands. Pause or delete one first.`);
      const stateChanged = state2 !== entry.state;
      const fields = (["text", "body", "argv", "timeoutSec", "scope", "tags", "keywords", "pinned"] as const).some((k) => JSON.stringify(next[k]) !== JSON.stringify(entry[k]));
      if (!stateChanged && !fields && (input.stateReason === undefined || input.stateReason === entry.stateReason)) return { value: entry, changed: false };
      Object.assign(entry, next);
      if (next.body === undefined) delete entry.body;
      if (stateChanged) setState(entry, state2, input.stateReason, at);
      else if (input.stateReason !== undefined) entry.stateReason = clip(input.stateReason, guardrailLimits.stateReason);
      bump(entry, at);
      // A guideline or note brought back into use may push another one out (§3.4).
      if (stateChanged && state2 === "active") {
        if (entry.kind === "guideline") {
          const out = guidelineToDisplace(state.entries, entry.projectId, entry.id);
          if (out) {
            setState(out, "archived", "displaced", at);
            bump(out, at);
          }
        }
        displaceNotes(state, entry.projectId, entry.id, at);
      }
      await pruneArchived(this.store.directory, state, entry.projectId, at);
      return { value: entry, changed: true };
    });
  }
  /** Permanent delete, backed up to `removed/` first. */
  async remove(input: { id: string; revision: number }): Promise<{ id: string }> {
    const before = (await this.store.read()).entries.find((e) => e.id === input.id);
    if (!before) throw new GuardrailError("NOT_FOUND", "This guardrail no longer exists. Reload to see the latest.");
    await this.project(before.projectId);
    return this.store.update(async (state) => {
      const entry = state.entries.find((e) => e.id === input.id);
      if (!entry) throw new GuardrailError("NOT_FOUND", "This guardrail no longer exists. Reload to see the latest.");
      if (entry.revision !== input.revision) throw new GuardrailError("GUARDRAIL_CONFLICT", "This guardrail changed elsewhere. Reload to see the latest.");
      await writeBackup(this.store.directory, `guardrail-${entry.id}`, { entries: [entry] }, this.iso());
      state.entries = state.entries.filter((e) => e !== entry);
      return { value: { id: entry.id }, changed: true };
    });
  }

  // ---- Commands found in the repository (§4.5, first bullet) --------------------------

  /**
   * Detection at project creation and when Auto review is switched on: the commands found in the project root are
   * added as observing (`by: "detect"`); a name or argv the project already has is skipped, and nothing is added
   * past the cap. Never runs anything. `found` is every detected name, for the one-line result in the form.
   */
  async detect(projectId: string): Promise<{ found: string[]; added: GuardrailEntry[] }> {
    const project = await this.project(projectId);
    const detected = (await this.detectCommands(project.primaryPath)).filter((c) => c.checked);
    if (!detected.length) return { found: [], added: [] };
    const added = await this.store.update((state) => {
      const at = this.iso();
      const out: GuardrailEntry[] = [];
      for (const c of detected) {
        const own = state.entries.filter((e) => e.projectId === projectId && e.kind === "command");
        if (own.some((e) => textKey(e.text) === textKey(c.name) || (e.argv || []).join("\u0000") === c.argv.join("\u0000"))) continue;
        if (commandRoom(state.entries, projectId) <= 0) break;
        const entry: GuardrailEntry = {
          id: randomUUID(),
          projectId,
          kind: "command",
          text: clip(c.name, guardrailLimits.commandName),
          argv: [...c.argv],
          observe: { reviews: 0, passed: 0 },
          state: "observing",
          stateAt: at,
          counts: emptyCounts(),
          sources: [],
          by: "detect",
          revision: 1,
          createdAt: at,
          updatedAt: at,
        };
        state.entries.push(entry);
        out.push(entry);
      }
      return { value: out, changed: out.length > 0 };
    });
    return { found: detected.map((c) => c.name), added };
  }

  // ---- Learning (§4.3) ------------------------------------------------------------

  /** The `Guardrails` lines of this card's rework-turn summary (§4.2), or null when it does not learn. */
  async section(taskId: string): Promise<string[] | null> {
    const [board, state] = await Promise.all([this.board.read(), this.store.read()]);
    const task = board.tasks.find((t) => t.id === taskId);
    const project = board.projects.find((p) => p.id === task?.projectId);
    if (!task || !project || project.archivedAt || !memoryOn(project)) return null;
    return guardrailsSection({ entries: state.entries, items: state.items, projectId: project.id, taskId, shape: { type: task.type, size: task.review?.shape?.size }, now: this.now() });
  }

  /**
   * The deterministic bookkeeping after a rework turn's summary: `new` opens an item on this card; `same` on this
   * card's item counts it again; on another card's item promotes both into a guideline; on an active guideline
   * counts a miss and widens its scope; on a paused or archived guideline revives it. A finding the agent disputed
   * that the user now sends back for counts as caught, not missed, and the dispute ends (§6.6).
   */
  async learn(input: { taskId: string; correction: Correction; quote: string }): Promise<void> {
    const correction = input.correction;
    if (correction.kind === "none") return;
    const board = await this.board.read();
    const task = board.tasks.find((t) => t.id === input.taskId);
    const project = board.projects.find((p) => p.id === task?.projectId);
    if (!task || !project || project.archivedAt || !memoryOn(project)) return;
    const quote = clip(input.quote.replace(/\s+/g, " ").trim(), guardrailLimits.quote);
    if (hasSecret(correction.text, quote)) {
      await this.recordError(project.id, task.id, "A correction was not kept: it looks like it contains a secret (token, key or password).");
      return;
    }
    const shape: CardShape = { type: task.type, size: task.review?.shape?.size };
    const disputed = new Set((task.disputes || []).map((d) => d.id));
    // A miss needs the card's latest review to have let it through (§4.3, §6.6); never reviewed is no miss.
    const reviewLetThrough = new Set((task.review?.items || []).filter((i) => i.state === "passed" || i.state === "na").map((i) => i.id));
    const outcome = await this.store.update(async (state) => {
      const at = this.iso();
      const events: CardEvent[] = [];
      const endedDisputes: string[] = [];
      const guidelines = state.entries.filter((e) => e.projectId === project.id && e.kind === "guideline");
      const items = state.items.filter((i) => i.projectId === project.id && (i.state === "open" || (i.state === "promoted" && i.taskId === task.id)));
      const learned = (change: GuardrailChange["change"], kind: GuardrailChange["kind"], id: string, text: string) =>
        events.push({ taskId: task.id, action: guardrailLearnedAction, note: clip(text, 1000), guardrail: { change, kind, id } });
      const retired = (entry: GuardrailEntry, change: "displaced" | "paused" | "archived") =>
        events.push({ taskId: task.id, action: guardrailRetiredAction, note: clip(`${entry.text} (${entry.stateReason || change})`, 1000), guardrail: { change, kind: entry.kind, id: entry.id } });
      const displace = (keep: string) => {
        const out = guidelineToDisplace(state.entries, project.id, keep);
        if (!out) return;
        setState(out, "archived", "displaced", at);
        bump(out, at);
        retired(out, "displaced");
      };
      let target: GuardrailEntry | CardItem | null = correction.kind === "same" ? resolveShortId(correction.matches, [...guidelines, ...items]) : null;
      const text = correction.kind === "new" ? correction.text : correction.text || (target && "kind" in target ? target.text : "") || "";
      // The same words as an item of this card or a guideline count as that one.
      if (!target && text) target = items.find((i) => i.taskId === task.id && textKey(i.text) === textKey(text)) ?? guidelines.find((g) => textKey(g.text) === textKey(text)) ?? null;
      // An item of this card already promoted stands for its guideline.
      if (target && !("kind" in target) && target.state === "promoted") target = guidelines.find((g) => g.id === (target as CardItem).promotedTo) ?? null;
      if (!target) {
        if (!text) return { value: { events, endedDisputes }, changed: false };
        const item: CardItem = { id: randomUUID(), projectId: project.id, taskId: task.id, text: clip(text, guardrailLimits.itemText), quote, shape, count: 1, state: "open", createdAt: at, updatedAt: at };
        state.items.push(item);
        for (const old of openItemOverflow(state.items, task.id)) {
          old.state = "closed";
          old.updatedAt = at;
        }
        learned("item", "item", item.id, item.text);
        return { value: { events, endedDisputes }, changed: true };
      }
      if (!("kind" in target)) {
        const item = target;
        if (disputed.has(item.id)) endedDisputes.push(item.id);
        if (item.taskId === task.id) {
          item.count++;
          item.updatedAt = at;
          return { value: { events, endedDisputes }, changed: true };
        }
        // The second card with the same problem: a project guideline (D4).
        const guideline = promotedGuideline({
          id: randomUUID(),
          projectId: project.id,
          text: item.text,
          at,
          from: [
            { taskId: item.taskId, quote: item.quote, shape: item.shape, at: item.createdAt },
            { taskId: task.id, quote, shape, at },
          ],
        });
        state.entries.push(guideline);
        item.state = "promoted";
        item.promotedTo = guideline.id;
        item.updatedAt = at;
        state.items.push({ id: randomUUID(), projectId: project.id, taskId: task.id, text: item.text, quote, shape, count: 1, state: "promoted", promotedTo: guideline.id, createdAt: at, updatedAt: at });
        learned("guideline", "guideline", guideline.id, guideline.text);
        displace(guideline.id);
        await pruneArchived(this.store.directory, state, project.id, at);
        return { value: { events, endedDisputes }, changed: true };
      }
      // A merged or superseded guideline stands for the one that replaced it; that one is counted, never the old one revived.
      const guideline = liveEntry(state.entries, target);
      if (disputed.has(guideline.id)) {
        // The dispute failed: the user sent the card back for exactly this (§6.6).
        endedDisputes.push(guideline.id);
        countCaught(guideline.counts, at);
      } else if (reviewLetThrough.has(guideline.id)) countMissed(guideline.counts, at);
      addSource(guideline, { taskId: task.id, at, ...(quote ? { quote } : {}) });
      const widened = widenScope(guideline.scope, shape);
      if (widened.changed) guideline.scope = widened.scope;
      if (guideline.state !== "active") {
        setState(guideline, "active", "revived", at);
        learned("revived", "guideline", guideline.id, guideline.text);
        displace(guideline.id);
      } else if (widened.changed) learned("widened", "guideline", guideline.id, guideline.text);
      bump(guideline, at);
      await pruneArchived(this.store.directory, state, project.id, at);
      return { value: { events, endedDisputes }, changed: true };
    });
    await this.afterLearning(task.id, outcome.events, outcome.endedDisputes);
  }
  private async afterLearning(taskId: string, events: readonly CardEvent[], endedDisputes: readonly string[]) {
    if (!events.length && !endedDisputes.length) return;
    await this.board
      .mutate((board) => {
        const task = board.tasks.find((t) => t.id === taskId);
        if (!task) return;
        for (const e of events) this.board.event(board, { taskId: e.taskId, actor: "system", action: e.action, note: e.note, guardrail: e.guardrail });
        if (endedDisputes.length && task.disputes) {
          task.disputes = task.disputes.filter((d) => !endedDisputes.includes(d.id));
          if (!task.disputes.length) delete task.disputes;
        }
      })
      .catch((e) => logFailure("Flowly guardrail event not recorded:", e, taskId));
  }
  private recordError(projectId: string, taskId: string | undefined, message: string) {
    return this.store.update((state) => {
      state.errors = [...state.errors, { projectId, ...(taskId ? { taskId } : {}), at: this.iso(), message: clip(message, 500) }].slice(-200);
      return { value: undefined, changed: true };
    });
  }

  /**
   * The card entered Done or Cancelled (§6.6): each finding still disputed counts as a misfire on its entry, and the
   * disputes are cleared. Its open items stay open (§3.3): a later card with the same problem promotes them.
   */
  async finishTask(taskId: string): Promise<void> {
    const task = (await this.board.read()).tasks.find((t) => t.id === taskId);
    if (!task?.disputes?.length) return;
    const disputes = task.disputes;
    await this.store.update((state) => {
      const at = this.iso();
      let changed = false;
      for (const d of disputes) {
        const entry = state.entries.find((e) => e.id === d.id);
        if (!entry) continue;
        countMisfire(entry.counts, at);
        bump(entry, at);
        changed = true;
      }
      return { value: undefined, changed };
    });
    await this.board.mutate((board) => {
      const t = board.tasks.find((x) => x.id === taskId);
      if (t?.disputes) delete t.disputes;
    });
  }

  removeTask(taskId: string) {
    return removeTaskGuardrails(this.store, taskId, this.iso());
  }
  removeProject(projectId: string, taskIds: ReadonlySet<string>) {
    return removeProjectGuardrails(this.store, projectId, taskIds, this.iso());
  }
}

/**
 * Automatic retirement (§6.7, §4.5) over a project's entries: returns the entries that left use (paused or
 * archived); an observing command that earned it becomes active without an event.
 */
export function applyRetirement(state: GuardrailsState, projectId: string, now: number, at: string): GuardrailEntry[] {
  const out: GuardrailEntry[] = [];
  for (const entry of state.entries) {
    if (entry.projectId !== projectId) continue;
    const next = retirement(entry, now);
    if (!next) continue;
    setState(entry, next.state, next.reason, at);
    if (next.state === "active") delete entry.observe;
    if (entry.kind === "command" && next.state === "paused") entry.counts.unavailableRun = 0;
    bump(entry, at);
    if (next.state !== "active") out.push(entry);
  }
  return out;
}

/** A command whose package script or Makefile target is no longer in the repository (§4.5); unknown counts as present. */
export function scriptMissing(argv: readonly string[], names: { scripts: Set<string> | null; targets: Set<string> | null }): boolean {
  const [base, sub, name] = argv;
  if (["npm", "pnpm", "yarn", "bun"].includes(base)) {
    const script = sub === "run" || sub === "run-script" ? name : sub === "test" ? "test" : undefined;
    return !!script && !!names.scripts && !names.scripts.has(script);
  }
  if (base === "make" && sub && !sub.startsWith("-")) return !!names.targets && !names.targets.has(sub);
  return false;
}

/**
 * The command-log keys (WORKFLOW-INSIGHTS-SPEC §3.2) agents' runs of this command show up as: a package script in any
 * package manager's spellings (`npm run test` and `npm test` alike), else the command's own normalized key.
 */
export function commandKeys(argv: readonly string[]): string[] {
  const [base, sub, name] = argv;
  const managers = ["npm", "pnpm", "yarn", "bun"];
  const script = managers.includes(base) ? (sub === "run" || sub === "run-script" ? name : sub === "test" ? "test" : undefined) : undefined;
  if (script) return managers.flatMap((pm) => [`${pm} run ${script}`, ...(script === "test" ? [`${pm} test`] : [])]).concat(`yarn ${script}`);
  const segment = classify(argv.join(" "), { repo: "", home: "" });
  return segment.kind === "action" ? [segment.key] : [];
}
/** Distinct cards whose agents ran this command in these records (§4.5 usage evidence). */
export function usageCards(argv: readonly string[], records: readonly CommandRecord[]): number {
  const keys = new Set(commandKeys(argv));
  return new Set(records.filter((r) => r.actions.some((a) => keys.has(a))).map((r) => r.taskId)).size;
}

/** Notes past 100 active give up the longest unused (§3.4). */
export function displaceNotes(state: GuardrailsState, projectId: string, keep: string, at: string) {
  for (let out = noteToDisplace(state.entries, projectId, keep); out; out = noteToDisplace(state.entries, projectId, keep)) {
    setState(out, "archived", "displaced", at);
    bump(out, at);
  }
}
const pinnedCount = (own: readonly GuardrailEntry[]) => own.filter((e) => e.kind === "note" && e.state === "active" && e.pinned).length;
function checkNote(title: string, body: string, keywords: readonly string[]) {
  if (!title.trim()) throw new GuardrailError("INVALID_INPUT", "A note needs a title.");
  if (hasSecret(title, body, keywords.join(" ")))
    throw new GuardrailError("MEMORY_SECRET", "This looks like it contains a secret (token, key or password). Guardrails never store credentials; write where it is kept instead.");
}

