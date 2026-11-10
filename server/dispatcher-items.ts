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
import type { DispatcherEntry } from "./dispatcher";

/** The dispatcher chat's own items (DISPATCHER-SPEC §9.1) and its "Changed since you looked" line (§9.2). */

/**
 * What the per-group cap counts an item under (§0, §9.1): a note under the group stamped on it (unstamped v1 notes
 * together, under a key of their own), asks and answers all together, as they have no group.
 */
function capKey(item: Stored): string {
  if (item.kind !== "note") return "asks";
  return item.groupId ? `note:${item.groupId}` : "note";
}

/**
 * Drops answered or dismissed asks older than 7 days, then keeps the newest `chatItemLimit` items of each cap key
 * (each group's notes; the asks and answers), oldest first.
 */
export function pruneItems(items: readonly Stored[], now: number): Stored[] {
  const live = items.filter((item) => {
    if (item.kind !== "ask" || (item.state !== "answered" && item.state !== "dismissed")) return true;
    const resolved = Date.parse(item.resolvedAt ?? item.at);
    return !(now - resolved > resolvedAskMs);
  });
  const sorted = live.map((item, index) => ({ item, index })).sort((a, b) => a.item.at.localeCompare(b.item.at) || a.index - b.index);
  const counts = new Map<string, number>();
  const kept: Stored[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const { item } = sorted[i];
    const key = capKey(item);
    const count = counts.get(key) ?? 0;
    if (count >= chatItemLimit) continue;
    counts.set(key, count + 1);
    kept.push(item);
  }
  return kept.reverse();
}

/** One note row per note the dispatcher received in one batch (§9.1), stamped with the group and session that received it (§0). */
export function noteItems(notes: readonly DispatcherNote[], at: string, to?: { groupId: string; agentId: string }): Stored[] {
  return notes.map((note) => ({ id: `note-${randomUUID()}`, at, kind: "note", note, ...(to ? { groupId: to.groupId, agentId: to.agentId } : {}) }));
}

/**
 * A group's chat items (§0, §9): the notes its own sessions received (an unstamped v1 note belongs to `legacyGroupId`,
 * the group the v1 session moved to), and every ask and answer, which have no group.
 */
export function groupItems<T extends ChatItem>(items: readonly T[], groupId: string, legacyGroupId: string | null): T[] {
  return items.filter((item) => item.kind !== "note" || (item.groupId ?? legacyGroupId) === groupId);
}

/** The mark the change line counts from: the user's Mark seen, else the dispatcher's start, else none (§9.2). */
/** Where "Changed since you looked" starts: a millisecond, and the events at exactly that ms already seen. */
export type SeenMark = { revision: number; ids: readonly string[] };

export function seenMark(record: Partial<Pick<DispatcherEntry, "seenRevision" | "seenIds" | "startedAt">>): SeenMark | null {
  if (typeof record.seenRevision === "number") return { revision: record.seenRevision, ids: record.seenIds ?? [] };
  const started = record.startedAt ? Date.parse(record.startedAt) : NaN;
  return Number.isFinite(started) ? { revision: started, ids: [] } : null;
}

/**
 * "Changed since you looked" (§9.2): cards with an agent's or the system's event after `mark` (event revision =
 * its time in ms; at the mark's own ms, an event whose id was not seen), on live cards of live projects; newest
 * first. The user's own changes and the actions of every dispatcher session this install has had
 * (`dispatcherAgentIds`) are left out. With `projectIds` (a group's live projects, §0) only their cards count. Null
 * when nothing changed.
 */
export function changeLine(board: Board, mark: SeenMark | null, dispatcherAgentIds: readonly string[] = [], projectIds?: readonly string[]): ChatItem | null {
  if (mark === null) return null;
  const seenAtMark = new Set(mark.ids);
  const dispatchers = new Set(dispatcherAgentIds);
  const only = projectIds ? new Set(projectIds) : null;
  const live = new Set(board.projects.filter((p) => !p.archivedAt && (!only || only.has(p.id))).map((p) => p.id));
  const tasks = new Map(board.tasks.filter((t) => !t.archivedAt && live.has(t.projectId)).map((t) => [t.id, t]));
  const changed = new Map<string, { card: ChangedCard; newest: number }>();
  let newest = -Infinity;
  let newestIds: string[] = [];
  for (const event of board.events) {
    if (event.actor === "human" || (event.agentId && dispatchers.has(event.agentId))) continue;
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

/** A group's live project ids: the projects whose cards its change line counts (§0, §9.2). */
export function groupProjectIds(board: Pick<Board, "projects">, groupId: string): string[] {
  return board.projects.filter((p) => !p.archivedAt && p.groupId === groupId).map((p) => p.id);
}

/**
 * The change line for each open panel's poll without a board scan while nothing moved: one cached result per group,
 * keyed on the board's revision and last event, the group's mark and projects, and the dispatcher sessions (§0, §9.2).
 */
export class ChangeLineCache {
  private readonly last = new Map<string, { key: string; value: ChatItem | null }>();
  constructor(private readonly scan: typeof changeLine = changeLine) {}
  get(groupId: string, board: Board, mark: SeenMark | null, dispatcherAgentIds: readonly string[], projectIds: readonly string[]): ChatItem | null {
    const key = JSON.stringify([board.revision, board.events.length, board.events.at(-1)?.id ?? null, mark, dispatcherAgentIds, projectIds]);
    const cached = this.last.get(groupId);
    if (cached?.key === key) return cached.value;
    const value = this.scan(board, mark, dispatcherAgentIds, projectIds);
    this.last.set(groupId, { key, value });
    return value;
  }
  /** Forgets a deleted group's entry. */
  forget(groupId: string) {
    this.last.delete(groupId);
  }
}

/** Every dispatcher session id a group's entry names: the earlier ones, then the current one. */
export function dispatcherSessionIds(entry: Pick<DispatcherEntry, "agentId" | "previousAgentIds">): string[] {
  return [...(entry.previousAgentIds ?? []), ...(entry.agentId ? [entry.agentId] : [])];
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
