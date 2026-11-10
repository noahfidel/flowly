import { mkdir, readFile, writeFile, rename, copyFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { LocaleCode } from "../shared/i18n";
import type { BoardStore } from "./store";
import type { FlowLog } from "./flow-log";
import type { CommandLog } from "./command-log";
import { availableModels } from "./summaries";
import { backgroundWorkspaces, type BackgroundWorkspaces } from "./background-workspace";
import { daemonRemoveAgent, type RemoveAgent } from "./summarizer-remove";
import { validZone } from "../shared/insights";
import { SUMMARIZER_LABELS, readOnlyConfig, isSummarizer, resolveModel, summaryModelsOf, type SummarySettings } from "../shared/summary";
import type { Board, Project } from "../shared/model";
import { catchUpJsonSchema, catchUpPrompt, parseCatchUp, type Correction } from "../shared/guardrails";
import { finishRefusingPermissions, runSummaryModels } from "./summary-models";
import { readSkillBody, scanSkills, skillPath, writeSkill, type InstallResult } from "./project-skills";
import {
  BACKFILL_DAYS,
  CARD_DAYS,
  DISMISS_COOLDOWN_DAYS,
  RETRY_PROMPT,
  RUN_TIMEOUT_MS,
  WORKFLOW_AUTO_MODELS,
  WORKFLOW_LABEL,
  aggregate,
  replaceOpen,
  buildMaterial,
  emptyWorkflowState,
  isDue,
  laneAt,
  nextRunAt,
  parseWorkflowOutput,
  projectScriptsFrom,
  quiet,
  shellRecord,
  trimState,
  validateFindings,
  windowDays,
  workflowJsonSchema,
  workflowPrompt,
  workflowStateSchema,
  type CardInfo,
  type CommandRecord,
  type ExistingConfig,
  type RawFinding,
  type RawMerge,
  type RunUsage,
  type SkillMaterial,
  type WorkflowRun,
  type WorkflowSettings,
  type WorkflowState,
  type WorkflowView,
} from "../shared/workflow-insights";
import { logFailure } from "./error-report";
import { workspaceOwners } from "../shared/workspace-switch";
import { BackgroundJobs } from "./background-jobs";

const DAY_MS = 86_400_000;
const TICK_MS = 15 * 60_000;
const COMMANDS_LIMIT = 4000;

/** `workflow-insights.json`: serialized writes, backup, atomic replacement; invalid data is preserved. */
export class WorkflowStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "workflow-insights.json");
  }
  private async load(): Promise<WorkflowState> {
    try {
      return workflowStateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyWorkflowState();
      throw new Error(`Workflow insights data is invalid; preserved at ${this.path}. Restore a valid backup before continuing.`);
    }
  }
  async read() {
    await this.tail;
    return this.load();
  }
  update<T>(operation: (state: WorkflowState) => Promise<{ value: T; changed: boolean }> | { value: T; changed: boolean }): Promise<T> {
    const job = this.tail.then(async () => {
      const state = await this.load();
      const { value, changed } = await operation(state);
      if (!changed) return value;
      state.revision++;
      workflowStateSchema.parse(state);
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
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** The Commands section of AGENTS.md or CLAUDE.md at the project root (§4.2). */
export function commandsSection(text: string): string {
  const match = /^#{1,3}\s*(?:commands|常用命令|命令)\b.*$/im.exec(text);
  if (!match) return "";
  const rest = text.slice(match.index + match[0].length);
  const next = /^#{1,3}\s/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim().slice(0, COMMANDS_LIMIT);
}

/** package.json script names (for `npx tsc` → `npm run typecheck`) and the full table for the material. */
async function packageScripts(root: string): Promise<Record<string, string>> {
  const text = await readText(join(root, "package.json"));
  if (!text) return {};
  try {
    const scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== "object") return {};
    return Object.fromEntries(Object.entries(scripts as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string").slice(0, 40));
  } catch {
    return {};
  }
}

/** Script names and types in the project root's paseo.json, for agents (§5.4). */
export async function projectScripts(project: Pick<Project, "primaryPath">) {
  const text = await readText(join(project.primaryPath, "paseo.json"));
  return text ? projectScriptsFrom(text) : [];
}

export const projectIncluded = (project: Project | undefined) => !!project && !project.archivedAt && project.workflowInsights !== false;

/**
 * Workflow insights (WORKFLOW-INSIGHTS-SPEC): records shell calls of card
 * sessions, backfills on enable, runs the analysis on schedule or on request.
 */
export class WorkflowInsightsService {
  private paseo: PaseoApi | null = null;
  private running = new Set<string>();
  private backfilling = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  /** Agents known to be (or not be) Flowly's own summarizer sessions. */
  private summarizer = new Map<string, boolean>();
  constructor(
    readonly board: BoardStore,
    readonly log: CommandLog,
    readonly state: WorkflowStore,
    readonly flow: FlowLog,
    readonly settings: () => Promise<WorkflowSettings>,
    readonly summarySettings: () => Promise<SummarySettings>,
    readonly language: () => Promise<LocaleCode>,
    private now = () => Date.now(),
    private timeoutMs = RUN_TIMEOUT_MS,
    private home = homedir(),
    /** Where the run happens: the project's background workspace, never a card's. */
    private background: BackgroundWorkspaces = backgroundWorkspaces(board.directory),
    /** Hard-deletes the run's session when done; archives it if that fails (AGENTS.md exception). */
    private removeAgent: RemoveAgent = daemonRemoveAgent(),
  ) {}

  /**
   * The project's guardrails in the weekly run (GUARDRAILS-SPEC §7.3); set by the daemon. Step 1 runs before the
   * model call: commands re-detected with usage evidence, retirement, and the catch-up learning when card summaries are
   * off. The material gets a `# Guardrails` section; the model's merges are applied after it.
   */
  guardrails: {
    weekly(projectId: string, input: { records: readonly CommandRecord[]; commands: boolean }): Promise<unknown>;
    catchUpInput(projectId: string): Promise<{ clues: { taskId: string; text: string; at: string }[]; section: string[] } | null>;
    catchUp(projectId: string, clues: readonly { taskId: string; text: string; at: string }[], corrections: readonly Correction[]): Promise<void>;
    material(projectId: string, flow: Awaited<ReturnType<FlowLog["read"]>>): Promise<string>;
    merge(projectId: string, merges: readonly RawMerge[]): Promise<unknown>;
  } | null = null;

  /** Card summaries and project memory for the skill material (INSIGHTS-REDESIGN-SPEC §3.2); set by the daemon. */
  skillSources: {
    summaries(): Promise<readonly { taskId: string; target?: string; recap?: string; at: string }[]>;
    memory(): Promise<{ clues: readonly { taskId: string; kind: string; text: string; at: string }[]; entries: readonly { projectId: string; kind: string; title: string; body: string; status: string }[] }>;
    memoryOn(project: Project): boolean;
  } | null = null;

  private pendingBackfill = false;
  /** Backfills and analyses started without being awaited. */
  private jobs = new BackgroundJobs();
  /** Resolves once no background backfill or queued analysis is left, including ones they started. */
  idle() {
    return this.jobs.idle();
  }

  attach(paseo: PaseoApi) {
    this.paseo = paseo;
    if (this.pendingBackfill) {
      this.pendingBackfill = false;
      this.jobs.track(this.backfillAll(paseo).catch(log("backfill")));
    }
  }
  /** The switch was turned on: backfill now, or as soon as a Paseo connection is known. */
  requestBackfillAll() {
    if (this.paseo) this.jobs.track(this.backfillAll(this.paseo).catch(log("backfill")));
    else this.pendingBackfill = true;
  }

  /** Checks for due projects shortly after start, then every 15 minutes. */
  start() {
    if (this.timer) return;
    this.first = setTimeout(() => void this.tick().catch(log("check")), 60_000);
    this.timer = setInterval(() => void this.tick().catch(log("check")), TICK_MS);
    this.first.unref?.();
    this.timer.unref?.();
  }
  stop() {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = this.timer = null;
  }

  private async enabledFor(project: Project | undefined) {
    return projectIncluded(project) && (await this.settings()).enabled;
  }

  private async scriptNames(project: Project) {
    return new Set(Object.keys(await packageScripts(project.primaryPath)));
  }

  private async isSummarizer(agentId: string, paseo: PaseoApi) {
    const known = this.summarizer.get(agentId);
    if (known !== undefined) return known;
    const snapshot = await paseo.agents.ref(agentId).refresh().catch(() => null);
    const value = snapshot ? isSummarizer(snapshot.agent as { labels?: Record<string, string> | null }) : false;
    this.summarizer.set(agentId, value);
    return value;
  }

  /** A finished turn's shell calls (§3.1); never throws into the hook. */
  async recordTurn(agent: { id: string; workspaceId: string | null; provider: string }, timeline: readonly unknown[], paseo: PaseoApi) {
    this.attach(paseo);
    if (!agent.workspaceId) return 0;
    const board = await this.board.read();
    const task = board.tasks.find((t) => t.workspaceId === agent.workspaceId && !t.archivedAt);
    const project = board.projects.find((p) => p.id === task?.projectId);
    if (!task || !project || !(await this.enabledFor(project))) return 0;
    const ctx = { repo: project.primaryPath, home: this.home };
    const scripts = await this.scriptNames(project);
    const at = new Date(this.now()).toISOString();
    const records = timeline
      .map((item) => shellRecord(item as Record<string, unknown>, { taskId: task.id, agentId: agent.id, lane: task.status, provider: agent.provider, at }, ctx, scripts))
      .filter((r): r is CommandRecord => !!r);
    if (!records.length || (await this.isSummarizer(agent.id, paseo))) return 0;
    return this.log.append(project.id, records);
  }

  /** Reads the last BACKFILL_DAYS of the project's card sessions once (§3.3). */
  async backfill(projectId: string, paseo: PaseoApi) {
    this.attach(paseo);
    if (this.backfilling.has(projectId)) return 0;
    this.backfilling.add(projectId);
    try {
      const board = await this.board.read();
      const project = board.projects.find((p) => p.id === projectId);
      if (!project || !projectIncluded(project)) return 0;
      const tasks = board.tasks.filter((t) => t.projectId === projectId);
      const byWorkspace = workspaceOwners(tasks);
      const cutoff = this.now() - BACKFILL_DAYS * DAY_MS;
      const agents: { id: string; provider: string; task: (typeof tasks)[number] }[] = [];
      let cursor: string | undefined;
      do {
        const page = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200, cursor } });
        for (const { agent } of page.entries) {
          const task = agent.workspaceId ? byWorkspace.get(agent.workspaceId) : undefined;
          if (!task || isSummarizer(agent as { labels?: Record<string, string> | null })) continue;
          const touched = Date.parse((agent as { lastActivityAt?: string }).lastActivityAt || agent.updatedAt || agent.createdAt || "");
          if (Number.isFinite(touched) && touched < cutoff) continue;
          agents.push({ id: agent.id, provider: String(agent.provider || ""), task });
        }
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
      const changes = new Map<string, { at: string; from?: string; to?: string }[]>();
      for (const e of await this.flow.read(projectId).catch(() => [])) {
        if (e.action !== "status_changed") continue;
        const list = changes.get(e.taskId) || [];
        list.push(e);
        changes.set(e.taskId, list);
      }
      for (const list of changes.values()) list.sort((a, b) => a.at.localeCompare(b.at));
      const ctx = { repo: project.primaryPath, home: this.home };
      const scripts = await this.scriptNames(project);
      let written = 0;
      // Two sessions at a time; each reads its timeline backwards until the cutoff.
      const queue = [...agents];
      const worker = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          // Not `written += await …`: that reads `written` before the other worker adds to it.
          const n = await this.backfillAgent(next, project.id, cutoff, changes.get(next.task.id) || [], ctx, scripts, paseo);
          written += n;
        }
      };
      await Promise.all([worker(), worker()]);
      await this.markCollecting(projectId);
      return written;
    } finally {
      this.backfilling.delete(projectId);
    }
  }

  private async backfillAgent(
    agent: { id: string; provider: string; task: { id: string; status: string } },
    projectId: string,
    cutoff: number,
    changes: readonly { at: string; from?: string; to?: string }[],
    ctx: { repo: string; home: string },
    scripts: ReadonlySet<string>,
    paseo: PaseoApi,
  ) {
    const records: CommandRecord[] = [];
    let before: unknown;
    try {
      for (let page = 0; page < 120; page++) {
        const res = await paseo.agents.ref(agent.id).timeline.refetch({
          direction: before ? "before" : "tail",
          ...(before ? { cursor: before as never } : {}),
          limit: 200,
          projection: "projected",
        });
        let oldest = Infinity;
        for (const entry of res.entries) {
          const t = Date.parse(entry.timestamp);
          oldest = Math.min(oldest, t);
          if (!(t >= cutoff)) continue;
          const lane = laneAt(changes, t, agent.task.status);
          const record = shellRecord(entry.item as Record<string, unknown>, { taskId: agent.task.id, agentId: agent.id, lane, provider: agent.provider, at: new Date(t).toISOString() }, ctx, scripts);
          if (record) records.push(record);
        }
        if (!res.hasOlder || !res.startCursor || oldest < cutoff) break;
        before = res.startCursor;
      }
    } catch (e) {
      logFailure("Workflow insights backfill skipped a session:", e);
    }
    return records.length ? this.log.append(projectId, records) : 0;
  }

  /** Backfills every included project (the switch was just turned on). */
  async backfillAll(paseo: PaseoApi) {
    const board = await this.board.read();
    for (const p of board.projects.filter(projectIncluded)) await this.backfill(p.id, paseo).catch(log("backfill"));
  }

  /** The newest run; of runs with the same time, the one written last. */
  private lastRun(state: WorkflowState, projectId: string): WorkflowRun | null {
    let last: WorkflowRun | null = null;
    for (const r of state.runs) if (r.projectId === projectId && (!last || r.at >= last.at)) last = r;
    return last;
  }

  /** Queues due projects, one analysis at a time (§4.1). */
  async tick() {
    const paseo = this.paseo;
    if (!paseo) return;
    const settings = await this.settings();
    if (!settings.enabled) return;
    const tz = validZone(settings.timeZone);
    const [board, state] = await Promise.all([this.board.read(), this.state.read()]);
    // A project that never ran nor collected (a new install, or on by default after an update):
    // start collecting now and read the last week once; its first run waits one interval (INSIGHTS-REDESIGN-SPEC §3.1).
    for (const p of board.projects.filter(projectIncluded))
      if (!this.lastRun(state, p.id) && !state.collectingSince[p.id] && !this.backfilling.has(p.id)) this.jobs.track(this.backfill(p.id, paseo).catch(log("backfill")));
    const due = board.projects
      .filter(projectIncluded)
      .map((p) => ({ p, last: this.lastRun(state, p.id), since: state.collectingSince[p.id] ?? null }))
      .filter(({ p, last, since }) => !this.running.has(p.id) && !this.backfilling.has(p.id) && (!!last || !!since) && isDue({ now: this.now(), tz, runHour: settings.runHour, intervalDays: settings.intervalDays, lastRunAt: last?.at ?? since }))
      .sort((a, b) => (a.last?.at ?? "").localeCompare(b.last?.at ?? ""));
    for (const { p } of due) this.run(p.id, paseo, false);
  }

  /** Queues one analysis; false when one is already queued or running for the project. */
  run(projectId: string, paseo: PaseoApi, manual: boolean): { queued: boolean } {
    this.attach(paseo);
    if (this.running.has(projectId)) return { queued: false };
    this.running.add(projectId);
    const job = this.chain.then(() => this.execute(projectId, paseo, manual));
    this.chain = job.then(
      () => undefined,
      () => undefined,
    );
    this.jobs.track(job.catch(log("run")).finally(() => this.running.delete(projectId)));
    return { queued: true };
  }

  private async config(project: Project): Promise<ExistingConfig> {
    const [paseoJson, pkg, agentsMd, claudeMd] = await Promise.all([
      readText(join(project.primaryPath, "paseo.json")),
      packageScripts(project.primaryPath),
      readText(join(project.primaryPath, "AGENTS.md")),
      readText(join(project.primaryPath, "CLAUDE.md")),
    ]);
    let worktree = "";
    try {
      const raw = paseoJson ? (JSON.parse(paseoJson) as { worktree?: unknown }) : null;
      if (raw?.worktree) worktree = JSON.stringify(raw.worktree).slice(0, 2000);
    } catch {
      worktree = "";
    }
    const scripts = paseoJson ? projectScriptsFrom(paseoJson).map((s) => `${s.name} (${s.type})`) : [];
    return { paseoScripts: scripts, paseoWorktree: worktree, packageScripts: pkg, commands: commandsSection(agentsMd || "") || commandsSection(claudeMd || "") };
  }

  private async model(paseo: PaseoApi, settings: WorkflowSettings) {
    const providers = await availableModels(paseo, settings.model);
    const offered = (id: string) => {
      const slash = id.indexOf("/");
      const provider = providers.find((p) => p.provider === id.slice(0, slash) && p.available);
      return slash > 0 && !!provider?.models.some((m) => m.id === id.slice(slash + 1) && (m as { isSelectable?: boolean }).isSelectable !== false);
    };
    if (settings.model) {
      if (!offered(settings.model)) throw new Error(`Workflow insights model ${settings.model} is not available.`);
      return settings.model;
    }
    const auto = WORKFLOW_AUTO_MODELS.find(offered);
    if (auto) return auto;
    const summary = await this.summarySettings();
    const choices = summaryModelsOf(summary);
    const inventory = await availableModels(paseo, choices).catch(() => providers);
    return resolveModel(choices, inventory);
  }

  /**
   * Stores a run. A run with new suggestions replaces the project's open ones
   * (§5.3), checked against the suggestions as they are at write time (the user
   * may have dismissed one while the run went). Accepted and dismissed ones stay.
   */
  private async record(
    run: Omit<WorkflowRun, "id" | "findings" | "replaced">,
    result?: {
      findings: RawFinding[];
      cardIds: readonly string[];
      skills?: { names: readonly string[]; installed: ReadonlyMap<string, string> };
      redact?: { repo: string; home: string };
    },
  ) {
    const id = randomUUID();
    return this.state.update((state) => {
      const drafts = result
        ? validateFindings(result.findings, {
            cardIds: result.cardIds,
            existing: state.findings.filter((f) => f.projectId === run.projectId),
            now: Date.parse(run.at),
            skills: result.skills,
            redact: result.redact,
          })
        : [];
      // A run without valid suggestions keeps the previous ones rather than emptying the list.
      const replaced = drafts.length
        ? replaceOpen(state.findings, run.projectId, drafts.map((f) => ({ ...f, id: randomUUID(), projectId: run.projectId, runId: id, status: "open" as const, createdAt: run.at, updatedAt: run.at })))
        : 0;
      const counts = { findings: drafts.length, replaced };
      const reason = run.status === "ok" && !drafts.length ? { reason: "No suggestions this time." } : {};
      state.runs.push({ ...run, ...reason, id, ...counts });
      trimState(state, Date.parse(run.at));
      return { value: counts, changed: true };
    });
  }

  private async execute(projectId: string, paseo: PaseoApi, manual: boolean) {
    const settings = await this.settings();
    const board = await this.board.read();
    const project = board.projects.find((p) => p.id === projectId);
    if (!project || project.archivedAt) return;
    const days = windowDays(settings.intervalDays);
    const now = this.now();
    // Guardrails step 1 (GUARDRAILS-SPEC §7.3): deterministic upkeep and the catch-up; never stops the run.
    await this.guardrailUpkeep(project, paseo, now).catch(log("guardrails"));
    const from = new Date(now - days * DAY_MS).toISOString(),
      to = new Date(now).toISOString();
    let records = await this.log.read(projectId, now - days * DAY_MS);
    // Run now on a project with nothing collected (the switch was off): read the last week first.
    if (!records.length && manual) {
      await this.backfill(projectId, paseo).catch(log("backfill"));
      records = await this.log.read(projectId, now - days * DAY_MS);
    }
    const last = this.lastRun(await this.state.read(), projectId);
    const sinceLast = last ? records.filter((r) => r.at > last.at) : records;
    const agg = aggregate(records);
    const stats = { calls: agg.calls, actions: agg.actions, cards: agg.cards, sessions: agg.sessions };
    const base = { projectId, at: to, from, to, manual, stats, model: "" };
    const entries = await this.flow.read(projectId).catch(() => []);
    const recent = recentCards(entries, now - CARD_DAYS * DAY_MS);
    const since = last ? Date.parse(last.at) : now - days * DAY_MS;
    const activeCards = new Set(entries.filter((e) => e.action === "agent.turn_ended" && Date.parse(e.at) > since).map((e) => e.taskId)).size;
    // Nothing collected and no recent card: a scheduled check waits instead of using up the interval.
    if (!records.length && !recent.length) return manual ? this.record({ ...base, status: "skipped", reason: "No recent activity." }) : undefined;
    if (!manual && quiet(sinceLast, agg.cards, activeCards)) return this.record({ ...base, status: "skipped", reason: "Not enough new activity." });
    let model = "";
    try {
      model = await this.model(paseo, settings);
      const state = await this.state.read();
      const existing = state.findings.filter((f) => f.projectId === projectId);
      const skills = await this.skillContext(project, board, state, recent, now);
      // The project's guardrails (GUARDRAILS-SPEC §7.3 step 2); empty while Guardrails is off for it.
      const guardrails = this.guardrails ? await this.guardrails.material(project.id, entries).catch(() => "") : "";
      // Card ids the model may cite: the command window's and the last 30 days' (INSIGHTS-REDESIGN-SPEC §3.1).
      const cardIds = [...new Set([...records.map((r) => r.taskId), ...recent])];
      const cards: CardInfo[] = [...new Set(records.map((r) => r.taskId))]
        .map((id) => board.tasks.find((t) => t.id === id))
        .filter((t): t is Board["tasks"][number] => !!t)
        .map((t) => ({ id: t.id, title: t.title, type: t.type, tags: (t.tags || []).map((x) => x.tag), lane: t.status }));
      const material = buildMaterial({
        days,
        agg,
        cards,
        config: await this.config(project),
        previous: existing
          .filter((f) => f.status === "accepted" || (f.status === "dismissed" && now - Date.parse(f.updatedAt) < 30 * DAY_MS))
          .map((f) => ({ target: f.target, title: f.title, status: f.status, proposal: f.proposal })),
        skills: skills.material,
      }) + (guardrails ? `\n\n${guardrails}` : "");
      const { usage, parsed } = await this.background.use(project, paseo, async (workspaceId) => {
        const agent = await paseo.workspaces.ref(workspaceId).agents.create({
          config: readOnlyConfig(model),
          title: `Flowly workflow insights · ${project.title}`.slice(0, 120),
          labels: { ...SUMMARIZER_LABELS, "flowly-project": project.id, ...WORKFLOW_LABEL },
          prompt: workflowPrompt(days, material, await this.language(), !!guardrails),
          outputSchema: workflowJsonSchema as unknown as Record<string, unknown>,
        });
        this.summarizer.set(agent.id, true);
        let usage: RunUsage | undefined;
        let parsed;
        try {
          const result = await finishRefusingPermissions(agent, this.timeoutMs);
          if (result.status !== "idle")
            throw new Error(
              result.status === "timeout"
                ? "The workflow insights model timed out."
                : result.status === "permission"
                  ? "The workflow insights model asked for a permission."
                  : result.error || "The workflow insights model failed.",
            );
          parsed = parseWorkflowOutput(result.lastMessage);
          if (!parsed) {
            const retry = await agent.run(RETRY_PROMPT, { timeoutMs: 180_000 });
            if (retry.status === "idle") parsed = parseWorkflowOutput(retry.lastMessage);
          }
          const u = agent.current()?.lastUsage;
          if (u) usage = { inputTokens: u.inputTokens, cachedInputTokens: u.cachedInputTokens, outputTokens: u.outputTokens, totalCostUsd: u.totalCostUsd, contextTokens: u.contextWindowUsedTokens };
        } finally {
          await this.removeAgent(agent);
        }
        return { usage, parsed };
      });
      if (!parsed) throw new Error("The workflow insights model returned no JSON.");
      await this.record({ ...base, model, status: "ok", usage }, { findings: parsed.findings, cardIds, skills: skills.check, redact: { repo: project.primaryPath, home: this.home } });
      // Merges of two guidelines or two notes (§7.3); the run never creates a guideline or a command.
      if (guardrails && parsed.merges.length) await this.guardrails!.merge(project.id, parsed.merges).catch(log("merge"));
    } catch (e) {
      await this.record({ ...base, model, status: "error", reason: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
    }
  }

  async view(projectId: string): Promise<WorkflowView> {
    const [settings, board, state] = await Promise.all([this.settings(), this.board.read(), this.state.read()]);
    const project = board.projects.find((p) => p.id === projectId);
    if (!project) throw new Error("Project not found.");
    const last = this.lastRun(state, projectId);
    const included = projectIncluded(project);
    const findings = state.findings.filter((f) => f.projectId === projectId);
    const tz = validZone(settings.timeZone);
    return {
      enabled: settings.enabled,
      projectEnabled: project.workflowInsights !== false,
      backfilling: this.backfilling.has(projectId),
      running: this.running.has(projectId),
      nextRunAt:
        settings.enabled && included
          ? new Date(nextRunAt({ now: this.now(), tz, runHour: settings.runHour, intervalDays: settings.intervalDays, lastRunAt: last?.at ?? state.collectingSince[projectId] ?? null })).toISOString()
          : null,
      windowDays: windowDays(settings.intervalDays),
      lastRun: last,
      findings,
      ...(await this.installedView(project, state, findings)),
      revision: state.revision,
    };
  }

  /**
   * Guardrails step 1 (GUARDRAILS-SPEC §7.3): commands re-detected against the last 30 days of the command log (with
   * Auto review on), retirement, and, when card summaries are off, one Summary-model call over the week's rework words
   * in the project's background workspace, its session hard-deleted after.
   */
  private async guardrailUpkeep(project: Project, paseo: PaseoApi, now: number) {
    const guardrails = this.guardrails;
    if (!guardrails) return;
    const records = await this.log.read(project.id, now - 30 * DAY_MS).catch(() => []);
    await guardrails.weekly(project.id, { records, commands: !!project.autoReview?.enabled });
    const summary = await this.summarySettings();
    if (summary.summaryEnabled) return;
    const input = await guardrails.catchUpInput(project.id);
    if (!input) return;
    const corrections = await this.background.use(project, paseo, async (workspaceId) => {
      const { output } = await runSummaryModels(paseo, summaryModelsOf(summary), {
        create: async (model) => {
          const agent = await paseo.workspaces.ref(workspaceId).agents.create({
            config: readOnlyConfig(model),
            title: `Flowly guardrails · ${project.title}`.slice(0, 120),
            labels: { ...SUMMARIZER_LABELS, "flowly-project": project.id },
            prompt: catchUpPrompt(input.clues, input.section),
            outputSchema: catchUpJsonSchema as unknown as Record<string, unknown>,
          });
          this.summarizer.set(agent.id, true);
          return agent;
        },
        parse: (text) => parseCatchUp(text, input.clues.length),
        remove: this.removeAgent,
        timeoutMs: this.timeoutMs,
      });
      return output;
    });
    await guardrails.catchUp(project.id, input.clues, corrections);
  }

  /** Flowly's skills in the project with their current text, and the bodies open updates would change (§4.6). */
  private async installedView(project: Project, state: WorkflowState, findings: WorkflowState["findings"]) {
    const installed: WorkflowView["installed"] = [];
    for (const i of state.installed.filter((x) => x.projectId === project.id)) {
      const content = await readFile(skillPath(project.primaryPath, i.name), "utf8").catch(() => null);
      if (content !== null) installed.push({ name: i.name, path: `.agents/skills/${i.name}/SKILL.md`, content });
    }
    const current: Record<string, string> = {};
    for (const f of findings)
      if (f.status === "open" && f.skill?.updates) {
        const body = await readSkillBody(project.primaryPath, f.skill.name);
        if (body !== null) current[f.skill.name] = body;
      }
    return { installed, current };
  }

  /** Starts the collecting clock once per project (§3.1). */
  private markCollecting(projectId: string) {
    const at = new Date(this.now()).toISOString();
    return this.state.update((state) => {
      if (state.collectingSince[projectId]) return { value: undefined, changed: false };
      state.collectingSince[projectId] = at;
      return { value: undefined, changed: true };
    });
  }

  /** The skill material and the names the validation needs (INSIGHTS-REDESIGN-SPEC §3.2, §3.4). */
  private async skillContext(project: Project, board: Board, state: WorkflowState, recent: readonly string[], now: number) {
    const sources = this.skillSources;
    const [summaries, memory, found] = await Promise.all([
      sources?.summaries().catch(() => []) ?? Promise.resolve([]),
      sources?.memory().catch(() => null) ?? Promise.resolve(null),
      scanSkills(project.primaryPath),
    ]);
    const memoryOn = !!sources?.memoryOn(project) && !!memory;
    const mine = new Set(state.installed.filter((i) => i.projectId === project.id).map((i) => i.name));
    const installed = new Map<string, string>();
    for (const name of mine) {
      const body = await readSkillBody(project.primaryPath, name);
      if (body !== null) installed.set(name, body);
    }
    const latest = new Map<string, { target?: string; recap?: string }>();
    for (const s of summaries) latest.set(s.taskId, s);
    const cards: SkillMaterial["cards"] = recent
      .map((id) => board.tasks.find((t) => t.id === id))
      .filter((t): t is Board["tasks"][number] => !!t)
      .map((t) => {
        const sum = latest.get(t.id);
        const summary = [sum?.target, sum?.recap].filter(Boolean).join("\n");
        return {
          id: t.id,
          title: t.title,
          type: t.type,
          tags: (t.tags || []).map((x) => x.tag),
          lane: t.status,
          summary,
          acceptance: (board.workpads.find((w) => w.taskId === t.id)?.acceptance || []).map((a) => a.text),
          clues: memoryOn ? memory!.clues.filter((c) => c.taskId === t.id).map((c) => ({ kind: c.kind, text: c.text })) : [],
        };
      });
    const cooldown = now - DISMISS_COOLDOWN_DAYS * DAY_MS;
    const material: SkillMaterial = {
      cards,
      memoryOn,
      memory: memoryOn ? memory!.entries.filter((e) => e.projectId === project.id && e.status === "active").map((e) => ({ kind: e.kind, title: e.title, body: e.body })) : [],
      skills: found.map((f) => ({ name: f.name, description: f.description, ...(installed.has(f.name) ? { body: installed.get(f.name) } : {}) })),
      closedSkills: state.findings
        .filter((f) => f.projectId === project.id && f.skill && (f.status === "accepted" || (f.status === "dismissed" && Date.parse(f.updatedAt) >= cooldown)))
        .map((f) => ({ status: f.status, name: f.skill!.name, title: f.title })),
    };
    return { material, check: { names: found.map((f) => f.name), installed } };
  }

  /**
   * Writes an open skill draft into the project (INSIGHTS-REDESIGN-SPEC §4): the file, the
   * Claude Code link, then the draft accepted and the skill recorded as Flowly's. No git.
   */
  async installSkill(input: { projectId: string; findingId: string; expectedRevision: number }): Promise<InstallResult & { revision: number }> {
    const board = await this.board.read();
    const project = board.projects.find((p) => p.id === input.projectId);
    if (!project) throw new Error("Project not found.");
    let draft: WorkflowState["findings"][number] | undefined;
    // Checked inside the serialized write, so two clicks cannot write twice.
    return this.state.update(async (state) => {
      if (state.revision !== input.expectedRevision) throw new Error("REVISION_CONFLICT: the suggestions changed; reload and try again.");
      draft = state.findings.find((f) => f.id === input.findingId && f.projectId === input.projectId);
      if (!draft || draft.status !== "open" || draft.target !== "skill" || !draft.skill) throw new Error("FINDING_NOT_OPEN: this skill draft is no longer open.");
      const skill = draft.skill;
      if (skill.updates && !state.installed.some((i) => i.projectId === project.id && i.name === skill.name)) throw new Error("SKILL_MISSING: Flowly did not add this skill, so it will not change it.");
      const result = await writeSkill(project.primaryPath, skill, skill.updates ? "update" : "new");
      const at = new Date(this.now()).toISOString();
      draft.status = "accepted";
      draft.acceptedSkill = skill.name;
      draft.updatedAt = at;
      state.installed = [...state.installed.filter((i) => !(i.projectId === project.id && i.name === skill.name)), { projectId: project.id, name: skill.name, findingId: draft.id, at }];
      return { value: { ...result, revision: state.revision + 1 }, changed: true };
    });
  }

  /** For the settings page: the latest run anywhere, and how many projects have a log. */
  async overview() {
    const state = await this.state.read();
    let lastRun: WorkflowRun | null = null;
    for (const r of state.runs) if (r.status === "ok" && (!lastRun || r.at >= lastRun.at)) lastRun = r;
    // One cycle: the latest priced run of each project still included, from the last 30 days.
    const board = await this.board.read();
    const included = new Set(board.projects.filter(projectIncluded).map((p) => p.id));
    const latest = new Map<string, WorkflowRun>();
    const since = new Date(this.now() - 30 * DAY_MS).toISOString();
    for (const r of state.runs)
      if (r.status === "ok" && included.has(r.projectId) && typeof r.usage?.totalCostUsd === "number" && r.at >= since && (!latest.has(r.projectId) || r.at >= latest.get(r.projectId)!.at))
        latest.set(r.projectId, r);
    const costs = [...latest.values()].map((r) => r.usage!.totalCostUsd!);
    return {
      lastRun,
      collected: (await this.log.projects()).length,
      cycleCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      costProjects: costs.length,
    };
  }

  /** Dismiss or restore a suggestion (§5.2). */
  setStatus(input: { projectId: string; findingId: string; status: "open" | "dismissed"; expectedRevision: number }) {
    return this.state.update((state) => {
      if (state.revision !== input.expectedRevision) throw new Error("REVISION_CONFLICT: the suggestions changed; reload and try again.");
      const f = state.findings.find((x) => x.id === input.findingId && x.projectId === input.projectId);
      if (!f) throw new Error("This suggestion no longer exists.");
      if (f.status === "accepted") throw new Error("This suggestion already has a card.");
      if (f.status === input.status) return { value: { revision: state.revision }, changed: false };
      f.status = input.status;
      f.updatedAt = new Date(this.now()).toISOString();
      return { value: { revision: state.revision + 1 }, changed: true };
    });
  }

  /** `tasks.create` with `insightFindingId`: checked before any workspace exists (§5.2). */
  async check(projectId: string, findingId: string) {
    const f = (await this.state.read()).findings.find((x) => x.id === findingId);
    if (!f || f.projectId !== projectId || f.status !== "open") throw new Error("This suggestion is no longer open.");
  }

  /** Marks the suggestion accepted once its card exists; a replayed create is a no-op. */
  accept(projectId: string, findingId: string, taskId: string) {
    return this.state.update((state) => {
      const f = state.findings.find((x) => x.id === findingId && x.projectId === projectId);
      if (!f || (f.status === "accepted" && f.acceptedTaskId === taskId)) return { value: undefined, changed: false };
      f.status = "accepted";
      f.acceptedTaskId = taskId;
      f.updatedAt = new Date(this.now()).toISOString();
      return { value: undefined, changed: true };
    });
  }

  purge() {
    return this.log.purge();
  }

  /** Permanent card delete: its command lines go, suggestions that created it forget the card. */
  async removeTask(projectId: string, taskId: string) {
    await this.log.removeTask(projectId, taskId);
    await this.state.update((state) => {
      let changed = false;
      for (const f of state.findings)
        if (f.acceptedTaskId === taskId) {
          delete f.acceptedTaskId;
          changed = true;
        }
      return { value: undefined, changed };
    });
  }

  /** Project Remove: back up then drop the project's runs and suggestions; the log moves to `removed/`. */
  async removeProject(projectId: string, now = new Date()) {
    await this.log.removeProject(projectId, now);
    await this.state.update(async (state) => {
      const runs = state.runs.filter((r) => r.projectId === projectId);
      const findings = state.findings.filter((f) => f.projectId === projectId);
      const installed = state.installed.filter((i) => i.projectId === projectId);
      if (!runs.length && !findings.length && !installed.length && !state.collectingSince[projectId]) return { value: null, changed: false };
      const folder = join(this.state.directory, "removed");
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const backup = join(folder, `${projectId}-workflow-insights-${now.toISOString().replace(/[:.]/g, "-")}.json`);
      await writeFile(backup, JSON.stringify({ removedAt: now.toISOString(), runs, findings, installed }, null, 2), { mode: 0o600, flag: "wx" });
      state.runs = state.runs.filter((r) => r.projectId !== projectId);
      state.findings = state.findings.filter((f) => f.projectId !== projectId);
      // The records go; the skill files stay in the project (§3.5).
      state.installed = state.installed.filter((i) => i.projectId !== projectId);
      delete state.collectingSince[projectId];
      return { value: backup, changed: true };
    });
  }
}

const log = (what: string) => (e: unknown) => logFailure(`Workflow insights ${what} failed:`, e);

/** Cards with a turn or a move to Done since `cutoff`, the most recently active first (INSIGHTS-REDESIGN-SPEC §3.2). */
export function recentCards(entries: readonly { taskId: string; action: string; to?: string; at: string }[], cutoff: number): string[] {
  const last = new Map<string, string>();
  for (const e of entries) {
    if (!(e.action === "agent.turn_ended" || (e.action === "status_changed" && e.to === "done"))) continue;
    if (Date.parse(e.at) < cutoff) continue;
    if ((last.get(e.taskId) ?? "") < e.at) last.set(e.taskId, e.at);
  }
  return [...last].sort((a, b) => b[1].localeCompare(a[1])).map(([id]) => id);
}
