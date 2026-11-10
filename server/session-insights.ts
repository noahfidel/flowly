import { daemonRemoveAgent, type RemoveAgent } from "./summarizer-remove";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { LocaleCode } from "../shared/i18n";
import { SUMMARIZER_LABELS, readOnlyConfig, isSummarizer, type SummaryModelChoice, truncateTranscript, turnText } from "../shared/summary";
import {
  SESSION_IDEAS_MAX,
  SESSION_INSIGHTS_MAX,
  SESSION_OPEN_IDEAS_MAX,
  emptySessionInsights,
  insightJsonSchema,
  insightPrompt,
  parseInsightOutput,
  sessionIdeaInstruction,
  sessionInsightsStateSchema,
  type InsightParts,
  type SessionIdea,
  type SessionInsight,
  type SessionInsightView,
  type SessionInsightsState,
} from "../shared/session-insights";
import { sessionSummaryRow } from "../shared/native-session";
import { within } from "./summaries";
import { runSummaryModels, isWorkspaceGone } from "./summary-models";
import type { NextMoveRows } from "./next-move-rows";
import { generatedBranchName, resolveWorktreeBaseRef } from "./service";
import { logFailure } from "./error-report";
import { BackgroundJobs } from "./background-jobs";

/** `session-insights.json`: serialized writes, backup, atomic replacement; invalid data is preserved, never reset. */
export class SessionInsightStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "session-insights.json");
  }
  private async load(): Promise<SessionInsightsState> {
    try {
      return sessionInsightsStateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySessionInsights();
      throw new Error(`Session insight data is invalid; preserved at ${this.path}. Restore a valid backup before continuing.`);
    }
  }
  async read() {
    await this.tail;
    return this.load();
  }
  update<T>(operation: (state: SessionInsightsState) => { value: T; changed: boolean }): Promise<T> {
    const job = this.tail.then(async () => {
      const state = await this.load();
      const { value, changed } = operation(state);
      if (!changed) return value;
      // Bounded: the least recently updated sessions go first.
      if (state.sessions.length > SESSION_INSIGHTS_MAX)
        state.sessions = [...state.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, SESSION_INSIGHTS_MAX);
      sessionInsightsStateSchema.parse(state);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
        await copyFile(this.path, `${this.path}.bak`).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
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

/** The session the hook names, as far as insights need it. */
export type OutsideAgent = { id: string; workspaceId: string | null; parentAgentId: string | null; title: string | null; cwd: string; labels?: Readonly<Record<string, string>> | null };
export type InsightSettings = { enabled: boolean; parts: InsightParts; model: SummaryModelChoice };

type Batch = { text: string; endedAt: string; agent: OutsideAgent };
export const INSIGHT_TIMEOUT_MS = 120_000;
const ROW_TIMEOUT_MS = 10_000;

/**
 * A session the outside path handles (NATIVE-SESSION-SPEC §12.1); the caller has already ruled out managed ones.
 * Flowly's own temporary sessions (memory review, digest, workflow insights) are not the person's work: they are
 * deleted as soon as they finish, so an insight run for them only fails or races that delete.
 */
export function isOutsideCandidate(agent: OutsideAgent) {
  return !!agent.workspaceId && !agent.parentAgentId && !isSummarizer(agent);
}

function emptyInsight(agent: OutsideAgent, now: string): SessionInsight {
  return { agentId: agent.id, workspaceId: agent.workspaceId!, title: agent.title || "", updatedAt: now, summary: null, suggestion: null, ideas: [], error: null };
}

/**
 * Progress, next steps and ideas for sessions Flowly does not manage (NATIVE-SESSION-SPEC §12): one child insight
 * session per completed turn (merged while one runs), stored per session, shown as rows in Paseo's timeline.
 */
export class SessionInsightService {
  private queues = new Map<string, Batch[]>();
  private jobs = new BackgroundJobs();
  private drains = new Map<string, Promise<void>>();
  /** When each session's latest turn started (in memory): rows for an older turn are not appended. */
  private started = new Map<string, string>();
  constructor(
    readonly store: SessionInsightStore,
    readonly rows: NextMoveRows,
    readonly settings: () => Promise<InsightSettings>,
    readonly language: () => Promise<LocaleCode>,
    private timeoutMs = INSIGHT_TIMEOUT_MS,
    private rowTimeoutMs = ROW_TIMEOUT_MS,
    private remove: RemoveAgent = daemonRemoveAgent(),
  ) {}

  running() {
    return [...this.queues.keys()];
  }

  /** Resolves once no background row append is left. */
  idle() {
    return this.jobs.idle();
  }

  async turnStarted(agentId: string, paseo: PaseoApi) {
    this.started.set(agentId, new Date().toISOString());
    await this.rows.turnStarted(agentId, paseo);
    await this.store
      .update((state) => {
        const s = state.sessions.find((x) => x.agentId === agentId);
        if (!s?.suggestion?.current) return { value: undefined, changed: false };
        s.suggestion.current = false;
        return { value: undefined, changed: true };
      })
      .catch((e) => logFailure("Flowly session insight not updated:", e));
  }

  /** Resolves when this session's queue is drained (tests); the hook does not wait. */
  async enqueue(agent: OutsideAgent, timeline: readonly { type: string }[], paseo: PaseoApi, endedAt = new Date().toISOString()): Promise<void> {
    if (!isOutsideCandidate(agent)) return;
    const settings = await this.settings();
    if (!settings.enabled || !(settings.parts.progress || settings.parts.nextMoves || settings.parts.ideas)) return;
    const text = turnText(timeline);
    if (!text.trim()) return;
    const batch = { text, endedAt, agent };
    const queue = this.queues.get(agent.id);
    if (queue) {
      queue.push(batch);
      return;
    }
    this.queues.set(agent.id, [batch]);
    const drain: Promise<void> = this.drain(agent.id, paseo).finally(() => {
      if (this.drains.get(agent.id) === drain) this.drains.delete(agent.id);
    });
    this.drains.set(agent.id, drain);
    return drain;
  }

  private async drain(agentId: string, paseo: PaseoApi) {
    try {
      for (;;) {
        const queue = this.queues.get(agentId)!;
        if (!queue.length) return;
        const merged = queue.splice(0, queue.length);
        const last = merged[merged.length - 1];
        await this.run({ text: merged.map((b) => b.text).join("\n\n---\n\n"), endedAt: last.endedAt, agent: last.agent }, paseo).catch((e) =>
          this.recordError(last.agent, e),
        );
      }
    } finally {
      this.queues.delete(agentId);
    }
  }

  private recordError(agent: OutsideAgent, error: unknown) {
    logFailure("Flowly session insight failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    return this.store
      .update((state) => {
        const now = new Date().toISOString();
        let s = state.sessions.find((x) => x.agentId === agent.id);
        if (!s) state.sessions.push((s = emptyInsight(agent, now)));
        s.error = { at: now, message: message.slice(0, 500) };
        s.updatedAt = now;
        return { value: undefined, changed: true };
      })
      .catch(() => undefined);
  }

  private async run(batch: Batch, paseo: PaseoApi) {
    const settings = await this.settings();
    const { parts } = settings;
    if (!settings.enabled || !(parts.progress || parts.nextMoves || parts.ideas)) return;
    const { agent } = batch;
    const before = (await this.store.read()).sessions.find((s) => s.agentId === agent.id);
    const open = (before?.ideas ?? []).filter((i) => i.status === "open");
    const language = await this.language();
    // A child of the session in its own workspace, like the card summarizer: no new project or workspace.
    const prompt = insightPrompt({
        title: agent.title || "", cwd: agent.cwd, previous: before?.summary ?? null,
        transcript: truncateTranscript(batch.text), openIdeas: open.map((i) => i.title),
        openIdeaCount: open.length, parts, language,
    });
    // Paseo removes a merged/archived workspace's directory (autoArchiveAfterMerge) right after the turn
    // ends: the child cannot be created and the session is gone with it, so skip instead of failing.
    const result = await runSummaryModels(paseo, settings.model, {
      create: (model) => paseo.workspaces.ref(agent.workspaceId!).agents.create({
        parent: agent.id,
        config: readOnlyConfig(model),
        title: `Flowly insights · ${agent.title || "session"}`.slice(0, 120),
        labels: { ...SUMMARIZER_LABELS, "flowly-session": agent.id },
        prompt,
        outputSchema: insightJsonSchema(parts) as unknown as Record<string, unknown>,
      }),
      parse: (text) => parseInsightOutput(text, parts),
      remove: this.remove,
      timeoutMs: this.timeoutMs,
    }).catch((error) => {
      if (!isWorkspaceGone(error)) throw error;
      return null;
    });
    if (!result) return;
    const { model, output } = result;
    const now = new Date().toISOString();
    // The person already started another turn: the suggestions are for the past one (the summary still counts).
    const stale = (this.started.get(agent.id) ?? "") > batch.endedAt;
    const written = await this.store.update((state) => {
      let s = state.sessions.find((x) => x.agentId === agent.id);
      if (!s) state.sessions.push((s = emptyInsight(agent, now)));
      s.workspaceId = agent.workspaceId!;
      s.title = agent.title || s.title;
      s.updatedAt = now;
      s.error = null;
      let summary = null;
      if (output.progress && (output.progress.update || !s.summary)) {
        summary = s.summary = { id: randomUUID(), at: now, model, state: output.progress.state, target: output.progress.target, recap: output.progress.recap, next: output.progress.next };
      }
      let suggestion = null;
      if (parts.nextMoves && !stale) {
        suggestion = s.suggestion = output.moves.length ? { id: randomUUID(), at: now, moves: output.moves, current: true } : null;
      }
      const added: SessionIdea[] = [];
      for (const idea of output.ideas) {
        const openNow = s.ideas.filter((i) => i.status === "open");
        if (openNow.length >= SESSION_OPEN_IDEAS_MAX) break;
        if (openNow.some((i) => i.title.trim().toLowerCase() === idea.title.trim().toLowerCase())) continue;
        const created: SessionIdea = { id: randomUUID(), ...idea, status: "open", createdAt: now, updatedAt: now };
        s.ideas.push(created);
        added.push(created);
      }
      if (s.ideas.length > SESSION_IDEAS_MAX) {
        const drop = s.ideas.filter((i) => i.status !== "open").slice(0, s.ideas.length - SESSION_IDEAS_MAX).map((i) => i.id);
        s.ideas = s.ideas.filter((i) => !drop.includes(i.id));
      }
      return { value: { summary, suggestion, added }, changed: true };
    });
    if (stale) return;
    // Rows in Paseo's timeline: best effort, never holding up the next run.
    this.jobs.track(this.appendRows(agent, written.summary, written.suggestion, paseo));
  }

  private async appendRows(
    agent: OutsideAgent,
    summary: SessionInsight["summary"],
    suggestion: SessionInsight["suggestion"],
    paseo: PaseoApi,
  ) {
    try {
      const snapshot = await within(paseo.agents.ref(agent.id).refresh(), this.rowTimeoutMs);
      if (!snapshot?.agent || snapshot.agent.archivedAt) return;
      if (summary) await within(paseo.agents.ref(agent.id).timeline.append(sessionSummaryRow(summary)), this.rowTimeoutMs);
      if (suggestion) await this.rows.writeSession(agent.id, suggestion.id, suggestion.moves, paseo);
    } catch (e) {
      logFailure("Flowly session insight rows not added:", e);
    }
  }

  /** The chip refresh's view: each session's current suggestion and open ideas. */
  async view(): Promise<SessionInsightView[]> {
    const state = await this.store.read();
    return state.sessions
      .map((s) => ({
        agentId: s.agentId,
        workspaceId: s.workspaceId,
        suggestion: s.suggestion?.current ? s.suggestion : null,
        ideas: s.ideas.filter((i) => i.status === "open"),
      }))
      .filter((s) => s.suggestion || s.ideas.length);
  }

  async dismissIdea(input: { agentId: string; ideaId: string }) {
    await this.store.update((state) => {
      const idea = openIdea(state, input);
      idea.status = "dismissed";
      idea.updatedAt = new Date().toISOString();
      return { value: undefined, changed: true };
    });
  }

  /** Continue here / New session / New workspace (NATIVE-SESSION-SPEC §12.5). */
  async runIdea(input: { agentId: string; ideaId: string; target: "here" | "session" | "workspace" }, paseo: PaseoApi) {
    const state = await this.store.read();
    const idea = openIdea(state, input);
    const session = await paseo.agents.ref(input.agentId).refresh();
    const agent = session?.agent;
    if (!agent || agent.archivedAt || !agent.workspaceId) throw new Error("This session is unavailable.");
    const instruction = sessionIdeaInstruction(idea);
    // Same provider, model, mode and thinking as the session the idea came from.
    const config = {
      provider: agent.model ? `${agent.provider}/${agent.model}` : agent.provider,
      ...(agent.currentModeId ? { modeId: agent.currentModeId } : {}),
      ...(agent.thinkingOptionId ? { thinkingOptionId: agent.thinkingOptionId } : {}),
    };
    let adopted: NonNullable<SessionIdea["adopted"]>;
    if (input.target === "here") {
      if (agent.status === "running" || agent.status === "initializing")
        throw new Error("This session is working. Try again when its turn ends.");
      await paseo.agents.ref(input.agentId).send(instruction);
      adopted = { target: "here", agentId: input.agentId };
    } else if (input.target === "session") {
      const created = await paseo.workspaces.ref(agent.workspaceId).agents.create({ config, title: idea.title.slice(0, 120), prompt: instruction });
      adopted = { target: "session", agentId: created.id, workspaceId: agent.workspaceId };
    } else {
      const workspace = await paseo.workspaces.ref(agent.workspaceId).refresh();
      const directory = workspace?.workspaceDirectory || agent.cwd;
      if (!directory || !workspace?.projectId) throw new Error("This session's workspace has no project to branch from. Use New session instead.");
      const baseRef = await resolveWorktreeBaseRef(directory, "").catch(() => {
        throw new Error("This session's folder is not a Git repository with a named branch. Use New session instead.");
      });
      const created = await paseo.workspaces.create({
        title: idea.title.slice(0, 120),
        idempotencyKey: `flowly-session-idea:${idea.id}`,
        source: { kind: "worktree", cwd: directory, projectId: workspace.projectId, action: "branch-off", refName: baseRef, branchName: generatedBranchName(idea.title, idea.id) },
      });
      // As a card's worktree: the workspace first, then its session.
      const started = await paseo.workspaces.ref(created.id).agents.create({ config, title: idea.title.slice(0, 120), prompt: instruction });
      adopted = { target: "workspace", workspaceId: created.id, agentId: started.id };
    }
    await this.store.update((s) => {
      const current = s.sessions.find((x) => x.agentId === input.agentId)?.ideas.find((i) => i.id === input.ideaId);
      if (!current) return { value: undefined, changed: false };
      current.status = "adopted";
      current.adopted = adopted;
      current.updatedAt = new Date().toISOString();
      return { value: undefined, changed: true };
    });
    return adopted;
  }
}

function openIdea(state: SessionInsightsState, input: { agentId: string; ideaId: string }) {
  const idea = state.sessions.find((s) => s.agentId === input.agentId)?.ideas.find((i) => i.id === input.ideaId);
  if (!idea || idea.status !== "open") throw new Error("This idea is no longer open.");
  return idea;
}
