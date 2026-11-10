import { mkdir, readFile, writeFile, rename, copyFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { backgroundWorkspaces, type BackgroundWorkspaces } from "./background-workspace";
import { daemonRemoveAgent, type RemoveAgent } from "./summarizer-remove";
import type { LocaleCode } from "../shared/i18n";
import type { BoardStore } from "./store";
import type { FlowLog } from "./flow-log";
import type { GitStats } from "./git-stats";
import type { SummaryStore } from "./summaries";
import { runSummaryModels } from "./summary-models";
import { BackgroundJobs } from "./background-jobs";
import type { AgentLike, UsageService } from "./usage";
import { modelId } from "./agent-model";
import { cardWorkspaceIds, workspaceOwners } from "../shared/workspace-switch";
import { laneName } from "../shared/lanes";
import { historyStatusLabel, type Board, type HistoryStatus, type Project, type Task } from "../shared/model";
import { SUMMARIZER_LABELS, readOnlyConfig, isSummarizer, summaryModelsOf, type SummaryEntry, type SummarySettings } from "../shared/summary";
import {
  TREND_DAYS,
  addDays,
  dayKey,
  dayStart,
  isDay,
  prepare,
  tokenInsights,
  validZone,
  withoutRevertedResumes,
  type TokenInsights,
  type Commit,
  type FlowEntry,
  type ProjectInsights,
} from "../shared/insights";
import { habits, modellessAgents, withMoveDetails } from "../shared/agent-habits";
import { cardStats, cardTokens, workflowStats, type CardTokens, type InsightsView } from "../shared/workflow-stats";
import { activity } from "../shared/activity";
import { dayDetail, withDayTokens, type DayDetail } from "../shared/day-detail";
import {
  DIGEST_DAYS,
  clipMaterial,
  digestJsonSchema,
  digestPrompt,
  digestStateSchema,
  emptyDigests,
  parseDigest,
  type DigestEntry,
  type DigestState,
  type DigestView,
} from "../shared/digest";

export const DIGEST_TIMEOUT_MS = 120_000;
type DayInput = { projectId: string; tz: string; day?: string };
/** INSIGHTS-REDESIGN-SPEC §7: the page has no window; everything is relative to today. */
type WindowInput = { projectId: string; tz: string };

/** `digests.json`: serialized writes, backup, atomic replacement; invalid data is preserved. */
export class DigestStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "digests.json");
  }
  private async load(): Promise<DigestState> {
    try {
      return digestStateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDigests();
      throw new Error(`Digest data is invalid; preserved at ${this.path}. Restore a valid backup before continuing.`);
    }
  }
  async read() {
    await this.tail;
    return this.load();
  }
  update<T>(operation: (state: DigestState) => Promise<{ value: T; changed: boolean }> | { value: T; changed: boolean }): Promise<T> {
    const job = this.tail.then(async () => {
      const state = await this.load();
      const { value, changed } = await operation(state);
      if (!changed) return value;
      digestStateSchema.parse(state);
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
      return value;
    });
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
  /** Replaces the project's digest for the day; keeps the newest DIGEST_DAYS days per project. */
  put(entry: DigestEntry) {
    return this.update((state) => {
      state.entries = state.entries.filter((e) => !(e.projectId === entry.projectId && e.day === entry.day));
      state.entries.push(entry);
      const mine = state.entries.filter((e) => e.projectId === entry.projectId).sort((a, b) => b.day.localeCompare(a.day));
      const drop = new Set(mine.slice(DIGEST_DAYS));
      state.entries = state.entries.filter((e) => !drop.has(e));
      state.errors = state.errors.filter((e) => !(e.projectId === entry.projectId && e.day === entry.day));
      return { value: entry, changed: true };
    });
  }
  setError(projectId: string, day: string, message: string, now = new Date()) {
    return this.update((state) => {
      state.errors = state.errors.filter((e) => !(e.projectId === projectId && e.day === day));
      state.errors.push({ projectId, day, at: now.toISOString(), message: message.slice(0, 500) });
      // Only the latest few errors per project matter.
      const mine = state.errors.filter((e) => e.projectId === projectId);
      if (mine.length > 10) state.errors = state.errors.filter((e) => e.projectId !== projectId || mine.slice(-10).includes(e));
      return { value: undefined, changed: true };
    });
  }
  /** Project Remove: back up then drop the project's digests. */
  removeProject(projectId: string, now = new Date()) {
    return this.update(async (state) => {
      const entries = state.entries.filter((e) => e.projectId === projectId);
      const errors = state.errors.filter((e) => e.projectId === projectId);
      if (!entries.length && !errors.length) return { value: null, changed: false };
      const folder = join(this.directory, "removed");
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const backup = join(folder, `${projectId}-digests-${now.toISOString().replace(/[:.]/g, "-")}.json`);
      await writeFile(backup, JSON.stringify({ removedAt: now.toISOString(), entries, errors }, null, 2), { mode: 0o600, flag: "wx" });
      state.entries = state.entries.filter((e) => e.projectId !== projectId);
      state.errors = state.errors.filter((e) => e.projectId !== projectId);
      return { value: backup, changed: true };
    });
  }
}

/** Project Insights (PROJECT-INSIGHTS-SPEC): stats from the flow log, git and live sessions; the daily digest. */
export class InsightsService {
  /** The day each project is generating a digest for, and the day waiting after it. */
  private jobs = new BackgroundJobs();
  /** Resolves once no background digest run is left. */
  idle() {
    return this.jobs.idle();
  }
  private generating = new Map<string, string>();
  private pending = new Map<string, { input: DayInput & { day: string }; force: boolean; paseo: PaseoApi }>();
  /** Reads provider logs for tokens by day (§11). */
  usage: UsageService | null = null;
  private reconciled: Promise<unknown> | null = null;
  constructor(
    readonly board: BoardStore,
    readonly flow: FlowLog,
    readonly git: GitStats,
    readonly summaries: SummaryStore,
    readonly digests: DigestStore,
    readonly settings: () => Promise<SummarySettings>,
    readonly language: () => Promise<LocaleCode>,
    private timeoutMs = DIGEST_TIMEOUT_MS,
    private now = () => Date.now(),
    /** Where the digest runs: the project's background workspace, never a card's (§7). */
    private background: BackgroundWorkspaces = backgroundWorkspaces(board.directory),
    /** Hard-deletes the digest's session when done; archives it if that fails (AGENTS.md exception, §7). */
    private removeAgent: RemoveAgent = daemonRemoveAgent(),
  ) {}

  /** Appends board events the flow log lacks (startup backfill and missed appends). */
  async reconcile() {
    await this.flow.reconcile(await this.board.read());
  }

  private async context(projectId: string) {
    // One backfill at a time; later reads still reconcile, cheaply (ids are cached).
    await (this.reconciled ??= this.reconcile().finally(() => (this.reconciled = null)));
    const board = await this.board.read();
    const project = board.projects.find((p) => p.id === projectId);
    if (!project) throw new Error("Project not found.");
    const tasks = board.tasks.filter((t) => t.projectId === projectId);
    const entries = await this.flow.read(projectId);
    return { board, project, tasks, entries };
  }

  private async commits(project: Project, day: string, tz: string | undefined) {
    const since = dayStart(addDays(day, -(TREND_DAYS + 1)), tz);
    return this.git.commits(project.primaryPath, since, this.now());
  }

  /** Agent habits for the 7 days ending at `day` (WORKFLOW-INSIGHTS-SPEC §12); the agent list is read only for turns that carry no model. */
  private async habits(entries: readonly FlowEntry[], board: Board, tasks: readonly Pick<Task, "workspaceId" | "previousWorkspaces">[], day: string, tz: string | undefined, paseo: PaseoApi) {
    const full = withMoveDetails(entries, board.events);
    const wanted = modellessAgents(full, { day, tz });
    const models = new Map<string, string>();
    if (wanted.size) {
      const workspaces = new Set(tasks.flatMap(cardWorkspaceIds));
      try {
        let cursor: string | undefined;
        do {
          const page = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200, cursor } });
          for (const { agent } of page.entries) {
            const model = wanted.has(agent.id) && agent.workspaceId && workspaces.has(agent.workspaceId) ? modelId(agent as Parameters<typeof modelId>[0]) : "";
            if (model) models.set(agent.id, model);
          }
          cursor = page.pageInfo.nextCursor ?? undefined;
        } while (cursor);
      } catch {
        // Turns without a model stay under "Unknown model".
      }
    }
    return habits(full, { day, tz, modelOf: (agentId) => models.get(agentId) });
  }

  /** The developer switch for Agent habits (INSIGHTS-REDESIGN-SPEC §6); off unless set. */
  agentHabits: () => Promise<boolean> = async () => false;

  /** Current models of sessions whose turns carry none (WORKFLOW-INSIGHTS-SPEC §12.5); empty on failure. */
  private async agentModels(wanted: ReadonlySet<string>, workspaces: ReadonlySet<string>, paseo: PaseoApi) {
    const models = new Map<string, string>();
    if (!wanted.size) return models;
    try {
      let cursor: string | undefined;
      do {
        const page = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200, cursor } });
        for (const { agent } of page.entries) {
          const model = wanted.has(agent.id) && agent.workspaceId && workspaces.has(agent.workspaceId) ? modelId(agent as Parameters<typeof modelId>[0]) : "";
          if (model) models.set(agent.id, model);
        }
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
    } catch {
      // Cards whose turns carry no model fall into "other".
    }
    return models;
  }

  private window(input: WindowInput) {
    const tz = validZone(input.tz);
    const now = this.now();
    return { tz, now, today: dayKey(now, tz) };
  }

  /** Cards finished in the last 7 days with their model, from the replayed histories. */
  private finished(tasks: Parameters<typeof prepare>[0]["tasks"], entries: readonly FlowEntry[], now: number, tz: string | undefined, today: string, modelOf: (id: string) => string | undefined) {
    const prepared = prepare({ tasks, entries, now, tz, day: today, runningAgents: new Set(), runningWorkspaces: new Set(), commits: [], repos: 0, gitError: null });
    return { prepared, cards: cardStats({ histories: prepared.histories, modelOf }) };
  }

  /** The Insights page (INSIGHTS-REDESIGN-SPEC §7): a year of activity, the last week's workflow, habits for developers. */
  async project(input: WindowInput, paseo: PaseoApi): Promise<InsightsView> {
    const { tz, now, today } = this.window(input);
    const { board, tasks, entries } = await this.context(input.projectId);
    const workspaces = new Set(tasks.flatMap(cardWorkspaceIds));
    const modelless = new Set(entries.filter((e) => e.action === "agent.turn_ended" && !e.model && e.agentId).map((e) => e.agentId!));
    const models = await this.agentModels(modelless, workspaces, paseo);
    const { cards } = this.finished(tasks, entries, now, tz, today, (id) => models.get(id));
    const view: InsightsView = { today, activity: activity({ entries, today, tz }), workflow: workflowStats({ cards, today, tz, now }) };
    if (await this.agentHabits().catch(() => false)) view.habits = await this.habits(entries, board, tasks, today, tz, paseo);
    return view;
  }

  /**
   * Tokens by day for every session in the project's card workspaces (archived
   * and summarizer sessions included), read from local provider logs only.
   */
  async tokens(input: WindowInput, paseo: PaseoApi): Promise<CardTokens> {
    if (!this.usage) throw new Error("Token usage is not available.");
    const { tz, now, today } = this.window(input);
    const { tasks, entries } = await this.context(input.projectId);
    const { agents, models } = await this.cardAgents(tasks, paseo);
    // The same cards and model attribution as insights.project.
    const { cards } = this.finished(tasks, entries, now, tz, today, (id) => models.get(id));
    const stats = workflowStats({ cards, today, tz, now });
    const usage = this.usage;
    const wantedTasks = new Set(stats.cards.map((c) => c.taskId));
    const series = await Promise.all(
      agents.filter((a) => wantedTasks.has(a.taskId)).map(async (a) => ({ taskId: a.taskId, buckets: await usage.buckets(a).catch(() => null) })),
    );
    const modelOfTask = new Map(cards.map((c) => [c.taskId, c.model]));
    return cardTokens({ series, cards: stats.cards, modelOf: (id) => modelOfTask.get(id) || "", models: stats.models.map((m) => m.model) });
  }

  /** Every session (archived included) in the project's card workspaces, with its card, model and whether it runs now. */
  private async cardAgents(tasks: readonly Task[], paseo: PaseoApi) {
    const owner = new Map([...workspaceOwners(tasks)].map(([workspace, t]) => [workspace, t.id]));
    const agents: (AgentLike & { taskId: string })[] = [];
    const models = new Map<string, string>();
    const running = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200, cursor } });
      for (const { agent } of page.entries) {
        const taskId = agent.workspaceId ? owner.get(agent.workspaceId) : undefined;
        if (!taskId) continue;
        agents.push({ ...(agent as AgentLike), taskId });
        const model = modelId(agent as Parameters<typeof modelId>[0]);
        if (model) models.set(agent.id, model);
        if (agent.status === "running" || agent.status === "initializing") running.add(agent.id);
      }
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return { agents, models, running };
  }

  /**
   * One day for the day summary card (INSIGHTS-REDESIGN-SPEC §2.2). Without `tokens` it reads
   * only the flow log; with it, it also lists the sessions (a running turn counts until now)
   * and adds the day's tokens from local provider logs.
   */
  async day(input: DayInput & { day: string; tokens?: boolean }, paseo: PaseoApi): Promise<DayDetail> {
    const tz = validZone(input.tz);
    const { tasks, entries } = await this.context(input.projectId);
    if (!input.tokens || !this.usage) return dayDetail({ entries, day: input.day, tz, now: this.now() });
    const usage = this.usage;
    const { agents, running } = await this.cardAgents(tasks, paseo);
    const detail = dayDetail({ entries, day: input.day, tz, now: this.now(), running });
    const wanted = new Set(detail.list.map((c) => c.taskId));
    const series = await Promise.all(agents.filter((a) => wanted.has(a.taskId)).map(async (a) => ({ taskId: a.taskId, buckets: await usage.buckets(a).catch(() => null) })));
    return withDayTokens(detail, series, tz);
  }

  /** The day's digest; a past day without one is generated once when the setting is on. */
  async digest(input: DayInput & { day: string }, paseo: PaseoApi): Promise<DigestView> {
    const tz = validZone(input.tz);
    const today = dayKey(this.now(), tz);
    const [state, settings, material] = await Promise.all([this.digests.read(), this.settings(), this.material(input)]);
    const entry = state.entries.find((e) => e.projectId === input.projectId && e.day === input.day) || null;
    const error = state.errors.find((e) => e.projectId === input.projectId && e.day === input.day) || null;
    const empty = !material.text;
    if (!entry && !error && !empty && settings.digestEnabled && input.day < today) this.queue(input, false, paseo);
    return { entry, running: this.busyWith(input), error, enabled: settings.digestEnabled, empty };
  }

  refresh(input: DayInput & { day: string }, paseo: PaseoApi) {
    this.queue(input, true, paseo);
    return { queued: true as const };
  }

  /** Generating or waiting to generate this day. */
  private busyWith(input: DayInput & { day: string }) {
    return this.generating.get(input.projectId) === input.day || this.pending.get(input.projectId)?.input.day === input.day;
  }

  /**
   * One digest per project at a time (INSIGHTS-REDESIGN-SPEC §2.2): a day asked for while
   * another runs replaces any earlier waiting one, so clicking through days generates only
   * the running one and the last selected.
   */
  private queue(input: DayInput & { day: string }, force: boolean, paseo: PaseoApi) {
    const running = this.generating.get(input.projectId);
    if (running === input.day) return;
    if (running !== undefined) this.pending.set(input.projectId, { input, force, paseo });
    else this.jobs.track(this.start(input, paseo));
  }

  private async start(input: DayInput & { day: string }, paseo: PaseoApi) {
    this.generating.set(input.projectId, input.day);
    try {
      await this.run(input, paseo);
    } catch (e) {
      await this.digests.setError(input.projectId, input.day, e instanceof Error ? e.message : String(e)).catch(() => undefined);
    } finally {
      this.generating.delete(input.projectId);
      const next = this.pending.get(input.projectId);
      this.pending.delete(input.projectId);
      if (next) {
        const state = await this.digests.read().catch(() => null);
        const has = state?.entries.some((e) => e.projectId === next.input.projectId && e.day === next.input.day);
        if (next.force || !has) this.jobs.track(this.start(next.input, next.paseo));
      }
    }
  }

  private async run(input: DayInput & { day: string }, paseo: PaseoApi) {
    const tz = validZone(input.tz);
    const { text, taskIds, project } = await this.material(input);
    if (!text) throw new Error("No activity on this day.");
    const settings = await this.settings();
    const prompt = digestPrompt({ project: project.title, day: input.day, today: input.day === dayKey(this.now(), tz), material: text, language: await this.language() });
    const { model, output } = await this.background.use(project, paseo, (workspaceId) => runSummaryModels(paseo, summaryModelsOf(settings), {
      create: (model) => paseo.workspaces.ref(workspaceId).agents.create({
        config: readOnlyConfig(model),
        title: `Kanban digest · ${project.title} · ${input.day}`.slice(0, 120),
        labels: { ...SUMMARIZER_LABELS, "flowly-project": project.id },
        prompt,
        outputSchema: digestJsonSchema as unknown as Record<string, unknown>,
      }),
      parse: (text) => parseDigest(text, taskIds),
      remove: this.removeAgent,
      timeoutMs: this.timeoutMs,
    }));
    await this.digests.put({ ...output, projectId: project.id, day: input.day, tz: tz || "", at: new Date(this.now()).toISOString(), model });
  }

  /** The day's activity as plain text for the digest model; "" when nothing happened. */
  async material(input: DayInput & { day: string }) {
    const tz = validZone(input.tz);
    const { board, project, tasks, entries } = await this.context(input.projectId);
    const start = dayStart(input.day, tz),
      end = dayStart(addDays(input.day, 1), tz);
    const inDay = (iso: string) => {
      const t = Date.parse(iso);
      return t >= start && t < end;
    };
    const todays = withoutRevertedResumes(entries).filter((e) => inDay(e.at));
    const summaries = (await this.summaries.read()).entries;
    const git = await this.commits(project, input.day, tz).catch(() => ({ commits: [] as Commit[] }));
    const commits = git.commits.filter((c) => inDay(c.at));
    const time = (iso: string) => {
      const d = new Date(iso);
      return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
    };
    const active = tasks.filter((t) => inDay(t.createdAt) || todays.some((e) => e.taskId === t.id));
    const sections: string[] = [];
    for (const task of active) {
      const mine = todays.filter((e) => e.taskId === task.id);
      const lines = [`## Card ${task.id}: ${task.title}`, `Now in: ${laneName(project, task.status)}${task.archivedAt ? " (archived)" : ""} · priority ${task.priority}${task.type ? ` · ${task.type}` : ""}`];
      if (inDay(task.createdAt)) lines.push("Created this day.");
      for (const e of mine.filter((e) => e.action === "status_changed"))
        lines.push(`${time(e.at)} ${label(e.from)} → ${label(e.to)} (${e.rule ? "rule" : e.actor})`);
      const turns = mine.filter((e) => e.action === "agent.turn_ended");
      const failed = turns.filter((e) => e.outcome === "failed").length;
      if (turns.length) lines.push(`Agent turns: ${turns.length}${failed ? ` (${failed} failed)` : ""}`);
      const questions = mine.filter((e) => e.reportKind === "question").length,
        blockers = mine.filter((e) => e.reportKind === "blocker").length;
      if (questions || blockers) lines.push(`Agent questions: ${questions}, blockers: ${blockers}`);
      const versions = summaries.filter((s) => s.taskId === task.id);
      const last = lastIn(versions, (s) => inDay(s.at)),
        before = lastIn(versions, (s) => Date.parse(s.at) < start);
      if (before && last) lines.push(`State before: ${before.state}`);
      if (last) lines.push(`State at end of day: ${last.state}`, `Recap:\n${last.recap}`, `Next: ${last.next}`);
      sections.push(lines.join("\n"));
    }
    const material = [
      ...sections,
      commits.length ? `## Commits (${commits.length})\n` + commits.slice(0, 50).map((c) => `- ${c.subject}`).join("\n") : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return { text: material ? clipMaterial(material) : "", taskIds: new Set(active.map((t) => t.id)), project, board };
  }
}

const label = (status: string | undefined) => (status ? historyStatusLabel(status as HistoryStatus) : "?");
function lastIn(list: readonly SummaryEntry[], test: (s: SummaryEntry) => boolean) {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) return list[i];
  return null;
}
