import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { LocaleCode } from "../shared/i18n";
import { isDeliveryStatus, type Board, type Project, type Task } from "../shared/model";
import { SUMMARIZER_LABELS, readOnlyConfig, summaryModelsOf, type SummarySettings } from "../shared/summary";
import {
  RETRO_DELAY_MS,
  RETRO_LABEL,
  RETRO_SUMMARY_WAIT_MS,
  RETRO_TIMEOUT_MS,
  CODEX_ANSWERS_PREFIX,
  answerText,
  clueText,
  containsSecret,
  fitCandidate,
  memoryForTask,
  memoryLimits,
  noteUse,
  parseRetroOutput,
  questionAnswers,
  recallMemory,
  retroJsonSchema,
  retroMaterial,
  retroPrompt,
  titleKey,
  trimClues,
  type MemoryClue,
  type MemoryEntry,
  type MemoryKind,
  type MemoryState,
  type TurnItem,
} from "../shared/memory";
import { emptyCounts, guardrailContext, memoryStateOf, recallGuidelines, setState, toMemoryEntry, type GuardrailEntry, type GuardrailsState } from "../shared/guardrails";
import type { BoardStore } from "./store";
import type { SummaryStore } from "./summaries";
import { runSummaryModels } from "./summary-models";
import { backgroundWorkspaces, type BackgroundWorkspaces } from "./background-workspace";
import { daemonRemoveAgent, type RemoveAgent } from "./summarizer-remove";
import { logFailure } from "./error-report";
import { displaceNotes, guardrailsStore, memoryOn, pruneArchived, removeProjectGuardrails, removeTaskGuardrails, type GuardrailsStore } from "./guardrails";

export { memoryOn, setMemoryEverywhere } from "./guardrails";

const DAY_MS = 86_400_000;

/**
 * Project memory is the notes of the project's guardrails (GUARDRAILS-SPEC §4.4): written at once, retired by
 * disuse. The `memory.*` RPCs, flowly_remember, flowly_recall and the finished-card review keep their contracts
 * on top of `guardrails.json`; entries go in and out as the former MemoryEntry.
 */
export const memoryStore = (directory: string): GuardrailsStore => guardrailsStore(directory);

/** Both blocks of a card's first instructions (§5.1) and the notes it shows. Guardrails off: nothing. */
export async function memoryContext(directory: string, task: Task, project: Project, board: Board): Promise<{ lines: string[]; ids: string[] }> {
  if (!memoryOn(project)) return { lines: [], ids: [] };
  const state = await guardrailsStore(directory).read().catch(() => null);
  if (!state) return { lines: [], ids: [] };
  const titleOf = (id: string | undefined) => (id && id !== task.id ? board.tasks.find((t) => t.id === id)?.title : undefined);
  const { lines, noteIds } = guardrailContext(state, task, titleOf);
  return { lines, ids: noteIds };
}

/** A refusal an agent tool turns into its error code (§4.1). */
export class MemoryError extends Error {
  constructor(
    readonly code: "MEMORY_DISABLED" | "MEMORY_DUPLICATE" | "MEMORY_LIMIT" | "MEMORY_SECRET" | "MEMORY_CONFLICT" | "MEMORY_FULL" | "INVALID_INPUT" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

export type Proposal = {
  projectId: string;
  taskId?: string;
  agentId?: string;
  eventId?: string;
  by: "agent" | "retro";
  kind: MemoryKind;
  title: string;
  body: string;
  tags: string[];
  keywords: string[];
  supersedes?: string;
  evidence?: string;
};

const notesOf = (state: GuardrailsState, projectId: string) => state.entries.filter((e) => e.projectId === projectId && e.kind === "note");

/**
 * Duplicate, limit, secret and supersedes checks of a new note (§4.1, GUARDRAILS-SPEC §4.4). A note is live at
 * once, so one card may add at most five: MEMORY_LIMIT past that.
 */
export function checkProposal(state: GuardrailsState, p: Omit<Proposal, "by" | "eventId" | "agentId">) {
  if (containsSecret(`${p.title}\n${p.body}\n${p.keywords.join(" ")}`))
    throw new MemoryError("MEMORY_SECRET", "This looks like it contains a secret (token, key or password). Memory never stores credentials: describe where it is kept instead.");
  const own = notesOf(state, p.projectId);
  const same = own.find((e) => e.state === "active" && titleKey(e.text) === titleKey(p.title));
  if (same) throw new MemoryError("MEMORY_DUPLICATE", `This project already has a memory with that title (${same.id}). To replace it, propose a new one with supersedes=${same.id}.`);
  if (p.supersedes && !own.some((e) => e.id === p.supersedes && e.state === "active"))
    throw new MemoryError("INVALID_INPUT", "supersedes must be the id of one of this project's active memories (see flowly_get_task memory or flowly_recall).");
  if (p.taskId && own.filter((e) => e.by !== "user" && e.source?.taskId === p.taskId).length >= memoryLimits.openPerTask)
    throw new MemoryError("MEMORY_LIMIT", `This card already added ${memoryLimits.openPerTask} memories. Mention anything else worth remembering in your reply instead.`);
}

/** AGENTS.md and CLAUDE.md at the project root (a CLAUDE.md that repeats AGENTS.md counts once); missing files are skipped. */
async function instructionFiles(root: string) {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const text = (await readFile(join(root, name), "utf8").catch(() => "")).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    parts.push(`## ${name}\n${text}`);
  }
  return parts.join("\n\n");
}

export class MemoryService {
  readonly store: GuardrailsStore;
  /** Cards whose review is running or waiting (shown as "Reviewing…"). */
  private running = new Set<string>();
  /** One review at a time per project (§4.2). */
  private queues = new Map<string, Promise<unknown>>();
  private paseo?: PaseoApi;
  constructor(
    readonly board: BoardStore,
    readonly summaries: SummaryStore,
    readonly summarySettings: () => Promise<SummarySettings>,
    readonly language: () => Promise<LocaleCode>,
    /** Resolves when a card's progress summary is not running (TASK-SUMMARY-SPEC §2). */
    readonly summarySettled: (taskId: string) => Promise<void> = async () => undefined,
    private now = () => Date.now(),
    private delayMs = RETRO_DELAY_MS,
    private timeoutMs = RETRO_TIMEOUT_MS,
    /** Hard-deletes the review's child session when done; archives it if that fails (AGENTS.md exception, §4.2). */
    private removeAgent: RemoveAgent = daemonRemoveAgent(),
    /** Where the review runs: the project's background workspace, never a card's (§4.2). */
    private background: BackgroundWorkspaces = backgroundWorkspaces(board.directory),
  ) {
    this.store = guardrailsStore(board.directory);
  }
  attach(paseo: PaseoApi) {
    this.paseo = paseo;
  }
  private iso() {
    return new Date(this.now()).toISOString();
  }
  /** The notes as the former memory state, for search, the skill material and telemetry. */
  async memoryState(): Promise<MemoryState> {
    return memoryStateOf(await this.store.read());
  }
  /** Cards whose finished-card review is running. */
  runningTasks() {
    return [...this.running];
  }

  // ---- Reads ----------------------------------------------------------------------

  /** flowly_get_task `memory` (§6.3): the notes chosen for this card. */
  async taskContext(task: Task, project: Project) {
    if (!memoryOn(project)) return { enabled: false, total: 0, entries: [] };
    const state = await this.store.read();
    const own = notesOf(state, project.id).map(toMemoryEntry);
    const selection = memoryForTask(own, { title: task.title, description: task.description, tags: (task.tags || []).map((t) => t.tag) });
    return { enabled: true, total: selection.total, entries: selection.entries.map(agentEntry) };
  }
  /** flowly_recall (§6.4). Counts the query; an empty result counts as a miss. */
  async recall(project: Project, taskId: string, input: { query: string; kind?: MemoryKind; limit?: number }) {
    if (!memoryOn(project)) throw new MemoryError("MEMORY_DISABLED", "Project memory is turned off for this project.");
    const state = await this.store.read();
    const found = recallMemory(notesOf(state, project.id).map(toMemoryEntry), input);
    // Guidelines too (GUARDRAILS-SPEC §5.3); only notes count as used.
    const guidelines = recallGuidelines(state.entries, project.id, input);
    void this.recordRecall(project.id, taskId, found.entries.map((e) => e.id), guidelines.length > 0).catch((e) => logFailure("Flowly recall stats not recorded:", e, taskId));
    return { entries: found.entries.map(agentEntry), total: found.total, ...(guidelines.length ? { guidelines } : {}) };
  }
  private recordRecall(projectId: string, taskId: string, ids: string[], other = false) {
    const at = this.iso();
    const day = at.slice(0, 10);
    return this.store.update((state) => {
      const stats = (state.recallStats[projectId] ||= { days: {} });
      const today = (stats.days[day] ||= { queries: 0, empty: 0 });
      today.queries++;
      if (!ids.length && !other) today.empty++;
      for (const d of Object.keys(stats.days)) if (Date.parse(at) - Date.parse(`${d}T00:00:00Z`) > 31 * DAY_MS) delete stats.days[d];
      for (const e of state.entries) if (ids.includes(e.id)) noteUse(e.counts, taskId, at);
      return { value: undefined, changed: true };
    });
  }
  /** Session creation: the injected notes count as used by this card, at most once an hour (§3.2). */
  markUsed(ids: readonly string[], taskId: string) {
    if (!ids.length) return Promise.resolve();
    const at = this.iso();
    return this.store.update((state) => {
      let changed = false;
      for (const e of state.entries) {
        if (!ids.includes(e.id)) continue;
        const last = e.counts.usedBy.find((u) => u.taskId === taskId);
        if (last && Date.parse(at) - Date.parse(last.at) < 3_600_000) continue;
        noteUse(e.counts, taskId, at);
        changed = true;
      }
      return { value: undefined, changed };
    });
  }

  // ---- Agent notes (§4.1, GUARDRAILS-SPEC §4.4) ----------------------------------

  /** Before the card write: refusals that should not leave a receipt. */
  async precheck(project: Project, taskId: string, input: Omit<Proposal, "by" | "projectId" | "taskId">) {
    if (!memoryOn(project)) throw new MemoryError("MEMORY_DISABLED", "Project memory is turned off for this project. Mention what is worth remembering in your reply instead.");
    checkProposal(await this.store.read(), { ...input, projectId: project.id, taskId });
  }
  /** Stores an active note; `supersedes` archives the old one in the same write. The same card event never stores twice. */
  propose(p: Proposal): Promise<MemoryEntry> {
    return this.store.update(async (state) => {
      const existing = p.eventId ? state.entries.find((e) => e.source?.eventId === p.eventId) : undefined;
      if (existing) return { value: toMemoryEntry(existing), changed: false };
      checkProposal(state, p);
      const at = this.iso();
      const entry: GuardrailEntry = {
        id: randomUUID(),
        projectId: p.projectId,
        kind: "note",
        noteKind: p.kind,
        text: p.title.trim(),
        ...(p.body.trim() ? { body: p.body.trim() } : {}),
        tags: p.tags,
        keywords: p.keywords,
        state: "active",
        stateAt: at,
        counts: emptyCounts(),
        sources: p.taskId ? [{ taskId: p.taskId, at, ...(p.evidence ? { quote: p.evidence.slice(0, 300) } : {}) }] : [],
        ...(p.taskId || p.agentId || p.eventId
          ? { source: { ...(p.taskId ? { taskId: p.taskId } : {}), ...(p.agentId ? { agentId: p.agentId } : {}), ...(p.eventId ? { eventId: p.eventId } : {}) } }
          : {}),
        by: p.by,
        ...(p.supersedes ? { supersedes: p.supersedes } : {}),
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      state.entries.push(entry);
      const replaced = p.supersedes ? state.entries.find((e) => e.id === p.supersedes && e.kind === "note" && e.state === "active") : undefined;
      if (replaced) {
        setState(replaced, "archived", "superseded", at);
        replaced.supersededBy = entry.id;
        replaced.revision++;
        replaced.updatedAt = at;
      }
      displaceNotes(state, p.projectId, entry.id, at);
      await pruneArchived(this.store.directory, state, p.projectId, at);
      return { value: toMemoryEntry(entry), changed: true };
    });
  }

  /** Card deleted (GUARDRAILS-SPEC §3.5): its items and clues go (backed up); notes and guidelines stay. */
  removeTask(taskId: string) {
    return removeTaskGuardrails(this.store, taskId, this.iso());
  }
  /** Project Remove (§3.5): everything of the project, backed up first. */
  removeProject(projectId: string, taskIds: ReadonlySet<string>) {
    return removeProjectGuardrails(this.store, projectId, taskIds, this.iso());
  }

  // ---- Clues (§4.0) ----------------------------------------------------------------

  /**
   * After a managed session's turn: the user's own message that started it, tagged
   * as an answer (to the agent's question), feedback (on a delivery) or a message.
   * `before` is the board as it was when the turn started being recorded.
   */
  async recordTurn(identity: { taskId: string; agentId: string }, timeline: readonly TurnItem[], board: Board) {
    const task = board.tasks.find((t) => t.id === identity.taskId);
    const project = board.projects.find((p) => p.id === task?.projectId);
    if (!task || !project || !memoryOn(project)) return;
    const at = this.iso();
    const clues: MemoryClue[] = [];
    // Answers given through a native question tool (AskUserQuestion, Codex request_user_input).
    for (const qa of questionAnswers(timeline)) {
      const text = answerText(qa.text);
      if (text) clues.push({ id: `${identity.agentId}:${qa.id}`, taskId: task.id, projectId: project.id, at, kind: "answer", ask: qa.ask.slice(0, memoryLimits.clueText), text });
    }
    const own = this.openingClue(identity, timeline, board, task.id);
    if (own) clues.push({ id: randomUUID(), taskId: task.id, projectId: project.id, at, ...own });
    if (!clues.length) return;
    await this.store.update((state) => {
      const known = new Set(state.clues.map((c) => c.id));
      const fresh = clues.filter((c) => !known.has(c.id));
      if (!fresh.length) return { value: undefined, changed: false };
      state.clues.push(...fresh);
      state.clues = trimClues(state.clues, task.id);
      return { value: undefined, changed: true };
    });
  }
  /**
   * A rework turn (GUARDRAILS-SPEC §4.1, B6): the turn began with the user's own words while the card was In review,
   * the same fact as a `feedback` clue, but with no minimum length: "测试没跑" is a correction. Returns those words, or
   * null. Guardrails off: null.
   */
  reworkQuote(identity: { taskId: string; agentId: string }, timeline: readonly TurnItem[], board: Board): string | null {
    const task = board.tasks.find((t) => t.id === identity.taskId);
    if (!task || !memoryOn(board.projects.find((p) => p.id === task.projectId))) return null;
    const clue = this.openingClue(identity, timeline, board, task.id, 1);
    return clue?.kind === "feedback" ? clue.text : null;
  }
  /** `min`: the shortest message kept; clues keep the 15-character rule (§4.0). */
  private openingClue(identity: { agentId: string }, timeline: readonly TurnItem[], board: Board, taskId: string, min?: number) {
    const first = timeline.find((i) => i.type === "user_message" && typeof i.text === "string");
    return first && !String(first.text).trimStart().startsWith(CODEX_ANSWERS_PREFIX) ? this.messageClue(identity, String(first.text), board, taskId, min) : null;
  }
  /** The turn's opening message as an answer (to a kind=question report), feedback (on a delivery) or a message; null when it is not the user's own words. */
  private messageClue(identity: { agentId: string }, message: string, board: Board, taskId: string, min?: number): Pick<MemoryClue, "kind" | "ask" | "text"> | null {
    const events = board.events.filter((e) => e.taskId === taskId);
    // The board events of this turn begin at its turn_started; what came before tells the situation.
    let start = events.length;
    for (let i = events.length - 1; i >= 0; i--)
      if (events[i].agentId === identity.agentId && events[i].action === "agent.turn_started") {
        start = i;
        break;
      }
    const before = events.slice(0, start);
    const picked = before.filter((e) => e.action === "next_moves_suggested" && e.moves).flatMap((e) => e.moves!.flatMap((m) => (m.prompt ? [m.prompt] : [])));
    const ideaTexts = board.ideas.filter((i) => i.taskId === taskId).flatMap((i) => [i.detail, `${i.title}\n\n${i.detail}`]);
    const value = clueText(message, [...picked, ...ideaTexts], min);
    if (!value || value.startsWith("Good idea — go ahead with it in this task:")) return null;
    const lastReport = [...before].reverse().find((e) => e.agentId === identity.agentId && e.actor === "agent" && (e.action === "progress_reported" || e.action === "status_changed"));
    const question = lastReport?.reportKind === "question" ? lastReport : undefined;
    const lastStatus = [...before].reverse().find((e) => e.action === "status_changed" && e.to);
    return {
      kind: question ? "answer" : isDeliveryStatus(lastStatus?.to) ? "feedback" : "message",
      ...(question?.note ? { ask: question.note.slice(0, memoryLimits.clueText) } : {}),
      text: value,
    };
  }

  // ---- Finished-card review (§4.2) -------------------------------------------------

  isRunning(taskId: string) {
    return this.running.has(taskId);
  }
  /** A card moved into Done: review it after a short wait, once its summary has settled. */
  afterDone(taskId: string, paseo: PaseoApi) {
    this.attach(paseo);
    void (async () => {
      const settings = await this.summarySettings();
      if (!settings.retroEnabled) return;
      const board = await this.board.read();
      const task = board.tasks.find((t) => t.id === taskId);
      if (!task || !memoryOn(board.projects.find((p) => p.id === task.projectId))) return;
      this.running.add(taskId);
      try {
        await sleep(this.delayMs);
        await Promise.race([this.summarySettled(taskId), sleep(RETRO_SUMMARY_WAIT_MS)]);
        const now = (await this.board.read()).tasks.find((t) => t.id === taskId);
        if (now?.status !== "done") return;
        await this.review(taskId, paseo, false);
      } finally {
        this.running.delete(taskId);
      }
    })().catch(logError("review"));
  }
  /** Find memories / guardrails.retro (§4.2): ignores the skip rules. */
  async manual(taskId: string, paseo: PaseoApi) {
    this.attach(paseo);
    const board = await this.board.read();
    const task = board.tasks.find((t) => t.id === taskId);
    const project = board.projects.find((p) => p.id === task?.projectId);
    if (!task || !project) throw new Error("Task not found.");
    if (!memoryOn(project)) throw new Error("Project memory is turned off for this project.");
    if (task.status !== "done" && task.status !== "cancelled") throw new Error("Only finished cards are reviewed for memories.");
    this.running.add(taskId);
    void this.review(taskId, paseo, true)
      .catch(logError("review"))
      .finally(() => this.running.delete(taskId));
    return { queued: true };
  }
  /** Reviews run one at a time per project; a failure is recorded on the card (§8). */
  private async review(taskId: string, paseo: PaseoApi, manual: boolean) {
    const projectId = (await this.board.read()).tasks.find((t) => t.id === taskId)?.projectId || "";
    const previous = this.queues.get(projectId) || Promise.resolve();
    const run = previous.then(() => this.execute(taskId, paseo, manual)).catch(async (e) => {
      await this.setError(projectId, taskId, e instanceof Error ? e.message : String(e)).catch((failure) => logFailure("Flowly memory review error not recorded:", failure, taskId));
    });
    this.queues.set(projectId, run);
    await run;
    if (this.queues.get(projectId) === run) this.queues.delete(projectId);
  }
  private setError(projectId: string, taskId: string, message: string) {
    return this.store.update((state) => {
      state.errors = state.errors.filter((e) => e.taskId !== taskId);
      state.errors.push({ taskId, projectId, at: this.iso(), message: message.slice(0, 500) });
      return { value: undefined, changed: true };
    });
  }
  /** The review's material for one card; null when there is nothing to learn from. */
  async material(taskId: string) {
    const [board, state, history] = await Promise.all([this.board.read(), this.store.read(), this.summaries.history(taskId)]);
    const task = board.tasks.find((t) => t.id === taskId);
    const project = board.projects.find((p) => p.id === task?.projectId);
    if (!task || !project) return null;
    const versions = [...history].reverse(); // oldest first
    const latest = versions[versions.length - 1];
    const recapLines = [...new Set(versions.flatMap((v) => v.recap.split("\n").map((l) => l.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean)))];
    const clues = state.clues.filter((c) => c.taskId === taskId);
    const reports = board.events
      .filter((e) => e.taskId === taskId && e.actor === "agent" && (e.reportKind === "question" || e.reportKind === "blocker" || e.reportKind === "result") && e.note)
      .slice(-10)
      .map((e) => `${e.reportKind}: ${e.note}`);
    // What the card's latest auto review found (GUARDRAILS-SPEC §6.4).
    const failedChecks = (task.review?.items || []).filter((i) => i.state === "failed").map((i) => `${i.name}${i.detail ? ` (${i.detail})` : ""}`);
    if (!latest && !clues.length && !reports.length) return null;
    const instructions = await instructionFiles(project.primaryPath);
    const notes = notesOf(state, project.id);
    return {
      task,
      project,
      latestId: latest?.id,
      clueAt: clues[clues.length - 1]?.at,
      text: retroMaterial({
        project: project.title,
        card: { title: task.title, type: task.type, tags: (task.tags || []).map((t) => t.tag), description: task.description },
        clues,
        summary: latest ? { target: latest.target, recap: latest.recap, next: latest.next } : undefined,
        recapLines,
        states: versions.slice(-6, -1).map((v) => v.state),
        failedChecks,
        reports,
        existing: notes.filter((e) => e.state === "active").slice(-100).map((e) => ({ id: e.id, kind: e.noteKind || "convention", title: e.text })),
        waiting: [],
        // What the user turned down teaches the review this project's bar (§4.2).
        dismissed: notes
          .filter((e) => e.state === "archived" && e.stateReason === "dismissed")
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
          .slice(0, 30)
          .map((e) => ({ kind: e.noteKind || "convention", title: e.text })),
        instructions,
      }),
    };
  }
  private async execute(taskId: string, paseo: PaseoApi, manual: boolean) {
    const m = await this.material(taskId);
    const state = await this.store.read();
    const last = state.retros.find((r) => r.taskId === taskId);
    if (!m) {
      if (manual) await this.recordRetro(m, taskId, []);
      return;
    }
    if (!manual && last && last.summaryId === m.latestId && last.clueAt === m.clueAt) return;
    const models = summaryModelsOf(await this.summarySettings());
    const prompt = retroPrompt(m.text, await this.language());
    const { output } = await this.background.use(m.project, paseo, (workspaceId) => runSummaryModels(paseo, models, {
      create: (model) => paseo.workspaces.ref(workspaceId).agents.create({
        config: readOnlyConfig(model),
        title: `Flowly memory review · ${m.task.title}`.slice(0, 120),
        labels: { ...SUMMARIZER_LABELS, "flowly-project": m.project.id, "flowly-task": m.task.id, ...RETRO_LABEL },
        prompt,
        outputSchema: retroJsonSchema as unknown as Record<string, unknown>,
      }),
      parse: (text) => parseRetroOutput(text).map(fitCandidate),
      remove: this.removeAgent,
      timeoutMs: this.timeoutMs,
    }));
    await this.recordRetro(m, taskId, output);
  }

  private async recordRetro(m: Awaited<ReturnType<MemoryService["material"]>>, taskId: string, candidates: ReturnType<typeof fitCandidate>[]) {
    const added: MemoryEntry[] = [];
    const dropped: string[] = [];
    for (const c of candidates) {
      if (!m) break;
      try {
        added.push(await this.propose({ ...c, projectId: m.project.id, taskId, by: "retro", evidence: c.evidence || undefined }));
      } catch (e) {
        if (e instanceof MemoryError && e.code === "MEMORY_DUPLICATE") continue;
        dropped.push(e instanceof Error ? e.message : String(e));
      }
    }
    await this.store.update((state) => {
      state.retros = state.retros.filter((r) => r.taskId !== taskId);
      state.retros.push({ taskId, at: this.iso(), ...(m?.latestId ? { summaryId: m.latestId } : {}), ...(m?.clueAt ? { clueAt: m.clueAt } : {}) });
      state.errors = state.errors.filter((e) => e.taskId !== taskId);
      if (dropped.length && m) state.errors.push({ taskId, projectId: m.project.id, at: this.iso(), message: `${dropped.length} suggestion(s) not kept: ${dropped[0]}`.slice(0, 500) });
      // Clues stay 30 days after a review, for a rerun.
      const cutoff = this.now() - memoryLimits.clueDays * DAY_MS;
      const reviewed = new Set(state.retros.filter((r) => Date.parse(r.at) < cutoff).map((r) => r.taskId));
      state.clues = state.clues.filter((c) => !reviewed.has(c.taskId));
      return { value: undefined, changed: true };
    });
    if (added.length && m)
      await this.board
        .mutate((board) => {
          if (board.tasks.some((t) => t.id === taskId))
            this.board.event(board, { taskId, actor: "system", action: "memory_proposed", note: added.map((e) => e.title).join(" · ").slice(0, 1000) });
        })
        .catch(logError("event"));
  }
}

/** What agents see of a note (§6.3). */
function agentEntry(e: MemoryEntry) {
  return {
    id: e.id,
    kind: e.kind,
    title: e.title,
    body: e.body,
    tags: e.tags,
    pinned: e.pinned,
    ...(e.source.taskId ? { sourceTaskId: e.source.taskId } : {}),
    ...(e.confirmedAt ? { confirmedAt: e.confirmedAt } : {}),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());
const logError = (what: string) => (e: unknown) => logFailure(`Flowly project memory ${what} failed:`, e);
