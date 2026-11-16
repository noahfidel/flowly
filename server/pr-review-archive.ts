import { execFile } from "node:child_process";
import type { PaseoApi } from "@getpaseo/client";
import { familyOf, type Connection, type ExternalRef } from "../shared/connectors";
import { isPrReviewCard, prReviewCardKey } from "../shared/pr-review";
import { laneProblem } from "../shared/lanes";
import type { Board, Status, Task } from "../shared/model";
import { refKey, type Summaries } from "./connectors/service";
import { logFailure } from "./error-report";
import {
  cardPrOutputs,
  landCandidate,
  landStatuses,
  landing,
  paseoWorkspace,
  runFileIn,
  runGit,
  type GitRun,
  type Landing,
  type LandingDeps,
  type RunIn,
  type WorkspaceWhere,
} from "./landed-done";
import type { BoardStore } from "./store";

/** PR review cards archived once their PR is merged or closed (PR-REVIEW-CARDS-SPEC §10). */

export type PrState = "open" | "merged" | "closed";
/** A pull request: `owner/repo#n` (lower case for a card's PR output), and its host when not github.com. */
export type PrTarget = { key: string; repo: string; number: number; host?: string };
/** The PR's state, or null when this source cannot tell (no token, no `gh`, not found, refused, offline). */
export type PrStateLookup = (pr: PrTarget) => Promise<PrState | null>;

/** At most this many PR lookups per check (§10). */
export const archiveLookupsPerTick = 20;
/** A check shortly after start, then every 10 minutes (§10). */
export const archiveFirstDelayMs = 60_000;
export const archiveTickMs = 10 * 60_000;

const prRefPattern = /^([^/\s]+\/[^/#\s]+)#(\d+)$/;
export function prTarget(prRef: string | undefined): PrTarget | null {
  const m = prRef ? prRefPattern.exec(prRef) : null;
  return m ? { key: prRef!, repo: m[1], number: Number(m[2]) } : null;
}

/** The card's PR: its stored `prRef`, else (cards made before prRef existed) its description's `PR:` line (§10). */
export const cardPr = (task: Task): PrTarget | null => prTarget(prReviewCardKey(task) ?? undefined);

/** Whether the card is one the timer looks at: a live PR review card in In review that names its PR (§10). */
export function archiveCandidate(task: Task): boolean {
  return !task.archivedAt && task.status === "in_review" && isPrReviewCard(task) && !!cardPr(task);
}

/** The first source that can tell wins: the GitHub connector, then the `gh` CLI. */
export function firstKnown(...lookups: PrStateLookup[]): PrStateLookup {
  return async (pr) => {
    for (const lookup of lookups) {
      const state = await lookup(pr).catch(() => null);
      if (state) return state;
    }
    return null;
  };
}

/** What the connector lookup needs of the connector service. */
export type ConnectorReads = {
  list(): Promise<Connection[]>;
  summaries(refs: readonly ExternalRef[], maxAge?: number, fingerprints?: boolean): Promise<Summaries>;
};

/** Through the user's GitHub connector for github.com, when one has a working token. */
export function connectorPrState(connectors: ConnectorReads): PrStateLookup {
  return async (pr) => {
    if (pr.host) return null;
    const connection = (await connectors.list()).find(
      (c) => familyOf(c.provider) === "github" && !c.authFailed && new URL(c.baseUrl).host.toLowerCase() === "github.com",
    );
    if (!connection) return null;
    const ref: ExternalRef = { connectionId: connection.id, provider: connection.provider, key: pr.key, remoteId: "", itemType: "pull" };
    const hit = (await connectors.summaries([ref], 0, false)).get(refKey(ref));
    // A stale entry is the cache answering for an unreachable service: not known now.
    if (!hit || hit.stale) return null;
    const status = hit.summary.status;
    return status === "Merged" ? "merged" : status === "Closed" ? "closed" : status === "Open" || status === "Draft" ? "open" : null;
  };
}

type Run = (file: string, args: readonly string[]) => Promise<string>;
const runFile: Run = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, [...args], { timeout: 20_000, maxBuffer: 256 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout)))),
  );

/** Through the GitHub CLI (`gh pr view`), with an argument array, never a shell. */
export function ghPrState(run: Run = runFile): PrStateLookup {
  return async (pr) => {
    const out = await run("gh", ["pr", "view", String(pr.number), "--repo", pr.host ? `${pr.host}/${pr.repo}` : pr.repo, "--json", "state,mergedAt"]);
    const parsed = JSON.parse(out) as { state?: unknown; mergedAt?: unknown };
    if (parsed.state === "MERGED" || (typeof parsed.mergedAt === "string" && parsed.mergedAt)) return "merged";
    if (parsed.state === "CLOSED") return "closed";
    if (parsed.state === "OPEN") return "open";
    return null;
  };
}

/** A review card archived (PR-REVIEW-CARDS-SPEC §10). */
export type ArchiveOutcome = { taskId: string; state: Exclude<PrState, "open"> };
/** An ordinary card moved to Done, or noted for a PR closed without merging (LANDED-DONE-SPEC §3–§4). */
export type LandOutcome =
  | { taskId: string; done: "pr" | "branch-pr"; pr: string }
  | { taskId: string; done: "landed"; base: string }
  | { taskId: string; note: "closed"; pr: string };
export type CheckOutcome = ArchiveOutcome | LandOutcome;

/** The once-per-PR activity note for a card's PR closed without merging (LANDED-DONE-SPEC R4). */
export const closedPrNote = (pr: string) => `PR closed without merging: ${pr}`;

/**
 * Every ~10 minutes, one check over two kinds of card (LANDED-DONE-SPEC §6): archives PR review cards still in
 * In review whose pull request was merged or closed (PR-REVIEW-CARDS-SPEC §10), and moves ordinary cards in In review,
 * Committed or Integrated to Done once their work landed on the base branch (LANDED-DONE-SPEC). Neither touches a
 * card's workspace or sessions itself; a move to Done is followed by what follows a person's move (`afterDone`).
 */
export class PrReviewArchiver {
  /** The Archive review cards when the PR closes setting; set by the plugin entry. */
  enabled: () => Promise<boolean> = async () => true;
  /** The Move cards to Done when their work lands setting (LANDED-DONE-SPEC §5); set by the plugin entry. */
  doneOnLand: () => Promise<boolean> = async () => true;
  /** The attached Paseo API, or null before the first hook or RPC after a start. */
  paseo: () => PaseoApi | null = () => null;
  /** Where a card's workspace lives (LANDED-DONE-SPEC §3.2). */
  workspace: WorkspaceWhere = paseoWorkspace;
  /** Runs `gh` in a card's directory (§3.2). */
  gh: RunIn = runFileIn;
  /** Runs `git` in a card's directory (§3.3). */
  git: GitRun = runGit;
  /** What follows a move into Done (memory review, guardrails, Auto wrap up); set by the plugin entry. */
  afterDone: (taskId: string, previous: Status, paseo: PaseoApi) => void = () => undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<CheckOutcome[]> | null = null;
  /** When each card was last looked up, so a long list is covered across checks. */
  private checkedAt = new Map<string, number>();
  private loggedUnknown = false;
  private loggedNoPaseo = false;

  constructor(
    readonly store: BoardStore,
    readonly lookup: PrStateLookup,
    readonly clock = () => Date.now(),
    readonly log: (line: string) => void = (line) => console.log(line),
  ) {}

  start() {
    if (this.timer) return;
    const tick = () => void this.tick().catch((e) => logFailure("Flowly PR review archive check failed:", e));
    this.first = setTimeout(tick, archiveFirstDelayMs);
    this.timer = setInterval(tick, archiveTickMs);
    this.first.unref?.();
    this.timer.unref?.();
  }
  stop() {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = this.timer = null;
  }

  /** One check; a check still running is joined, never doubled. */
  tick(): Promise<CheckOutcome[]> {
    if (!this.running)
      this.running = this.check().finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async check(): Promise<CheckOutcome[]> {
    const [reviewOn, doneOn] = await Promise.all([this.enabled(), this.doneOnLand()]);
    if (!reviewOn && !doneOn) return [];
    const board = await this.store.read();
    const live = new Set(board.projects.filter((p) => !p.archivedAt).map((p) => p.id));
    // One list of both kinds (LANDED-DONE-SPEC §6); each switch gates only its own kind (§5).
    const candidates = board.tasks.filter(
      (t) => live.has(t.projectId) && ((reviewOn && archiveCandidate(t)) || (doneOn && landCandidate(t, board.artifacts))),
    );
    for (const id of [...this.checkedAt.keys()]) if (!candidates.some((t) => t.id === id)) this.checkedAt.delete(id);
    if (!candidates.length) return [];
    const paseo = this.paseo();
    if (!paseo) {
      if (!this.loggedNoPaseo) {
        this.loggedNoPaseo = true;
        this.log("Flowly: PR review cards and landed work not checked yet: Paseo is not attached (logged once per run).");
      }
      return [];
    }
    const busy = await runningWorkspaces(paseo);
    const due = candidates
      .filter((t) => !busy.has(t.workspaceId))
      .sort((a, b) => (this.checkedAt.get(a.id) ?? 0) - (this.checkedAt.get(b.id) ?? 0) || a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, archiveLookupsPerTick);
    const outcomes: CheckOutcome[] = [];
    let unknown = 0;
    const deps: LandingDeps = { lookup: this.lookup, workspace: this.workspace, gh: this.gh, git: this.git };
    for (const task of due) {
      if (isPrReviewCard(task)) {
        const state = await this.lookup(cardPr(task)!).catch(() => null);
        this.checkedAt.set(task.id, this.clock());
        if (!state) {
          unknown++;
          continue;
        }
        if (state === "open") continue;
        if (await this.archive(task, state)) outcomes.push({ taskId: task.id, state });
        continue;
      }
      const found = await landing(task, board.artifacts, paseo, deps).catch((): Landing => ({ kind: "unknown" }));
      this.checkedAt.set(task.id, this.clock());
      if (found.kind === "unknown" || (found.kind === "pr" && !found.state)) {
        unknown++;
        continue;
      }
      if (found.kind === "pr") {
        if (found.state === "merged" && (await this.moveToDone(task, paseo, `Moved to Done: PR merged (${found.pr.key})`, found.pr.key)))
          outcomes.push({ taskId: task.id, done: "pr", pr: found.pr.key });
        else if (found.state === "closed" && (await this.noteClosed(task, found.pr.key))) outcomes.push({ taskId: task.id, note: "closed", pr: found.pr.key });
      } else if (found.kind === "branch-pr") {
        if (await this.moveToDone(task, paseo, `Moved to Done: PR merged (${found.pr})`)) outcomes.push({ taskId: task.id, done: "branch-pr", pr: found.pr });
      } else if (found.kind === "landed") {
        if (await this.moveToDone(task, paseo, `Moved to Done: work landed on ${found.base}`)) outcomes.push({ taskId: task.id, done: "landed", base: found.base });
      }
    }
    if (unknown && unknown === due.length) {
      if (!this.loggedUnknown) {
        this.loggedUnknown = true;
        this.log(
          "Flowly: PR and branch states could not be read (no GitHub connector token, gh failed or is missing, or git fetch failed); cards are not archived or moved to Done (logged once until a lookup works).",
        );
      }
    } else if (due.length) this.loggedUnknown = false;
    return outcomes;
  }

  /** Archives the card as the board's Archive does, if nothing about it changed since it was read. */
  private archive(read: Task, state: "merged" | "closed"): Promise<boolean> {
    return this.store.transaction<boolean>((board) => {
      const t = board.tasks.find((x) => x.id === read.id);
      const project = t && board.projects.find((p) => p.id === t.projectId);
      if (!t || !project || project.archivedAt || !archiveCandidate(t) || cardPr(t)?.key !== cardPr(read)?.key || t.workspaceId !== read.workspaceId)
        return { value: false, changed: false };
      const now = new Date().toISOString();
      t.archivedAt = now;
      t.revision++;
      t.updatedAt = now;
      this.store.event(board, { taskId: t.id, actor: "system", action: "archive_changed", note: state === "merged" ? "Archived: PR merged" : "Archived: PR closed" });
      return { value: true, changed: true };
    });
  }

  /** The card as it is now, if it is still the card the check read (LANDED-DONE-SPEC §4); `pr`: its single PR then. */
  private stillLanding(board: Board, read: Task, pr?: string): Task | null {
    const t = board.tasks.find((x) => x.id === read.id);
    const project = t && board.projects.find((p) => p.id === t.projectId);
    if (!t || !project || project.archivedAt || t.archivedAt || isPrReviewCard(t)) return null;
    // Any change since the check read it (status, revision, workspace) leaves the card alone (LANDED-DONE-SPEC §4).
    if (t.status !== read.status || t.revision !== read.revision || !landStatuses.includes(t.status) || t.workspaceId !== read.workspaceId) return null;
    const prs = cardPrOutputs(board.artifacts, t.id).map((p) => p.key);
    if (pr ? prs.length !== 1 || prs[0] !== pr : prs.length !== 0) return null;
    return t;
  }

  /**
   * Moves the card to Done as a person's move does (status, revision, `status_changed` event), with actor system and
   * the note, then runs what follows any move into Done (§4). Nothing when the card changed since it was read.
   */
  private async moveToDone(read: Task, paseo: PaseoApi, note: string, pr?: string): Promise<boolean> {
    // The check's snapshot of running sessions can be minutes old: read that one workspace again (R3, §4).
    const busy = await workspaceBusy(paseo, read.workspaceId).catch(() => true);
    if (busy) return false;
    const previous = await this.store.transaction<Status | null>((board) => {
      const t = this.stillLanding(board, read, pr);
      if (!t || laneProblem(board.projects.find((p) => p.id === t.projectId), "done")) return { value: null, changed: false };
      const from = t.status;
      t.status = "done";
      t.revision++;
      t.updatedAt = new Date().toISOString();
      this.store.event(board, { taskId: t.id, actor: "system", action: "status_changed", from, to: "done", note });
      return { value: from, changed: true };
    });
    if (!previous) return false;
    try {
      this.afterDone(read.id, previous, paseo);
    } catch (e) {
      logFailure("Flowly follow-up of a landed card's move to Done failed:", e, read.id);
    }
    return true;
  }

  /** The R4 note, once per PR: nothing when the card's activity already holds it (a restart never repeats it). */
  private noteClosed(read: Task, pr: string): Promise<boolean> {
    const note = closedPrNote(pr);
    return this.store.transaction<boolean>((board) => {
      const t = this.stillLanding(board, read, pr);
      if (!t || board.events.some((e) => e.taskId === t.id && e.action === "note" && e.note === note)) return { value: false, changed: false };
      this.store.event(board, { taskId: t.id, actor: "system", action: "note", note });
      return { value: true, changed: true };
    });
  }
}

/** Whether one workspace has a running or starting session now (LANDED-DONE-SPEC §4). */
async function workspaceBusy(paseo: PaseoApi, workspaceId: string): Promise<boolean> {
  return (await runningWorkspaces(paseo)).has(workspaceId);
}

/** Workspaces with a running or starting session: their cards are left alone. */
async function runningWorkspaces(paseo: PaseoApi): Promise<Set<string>> {
  const busy = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({ filter: { includeArchived: false, includeBackground: true }, page: { limit: 200, cursor } });
    for (const { agent } of page.entries)
      if (agent.workspaceId && !agent.archivedAt && (agent.status === "running" || agent.status === "initializing")) busy.add(agent.workspaceId);
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return busy;
}
