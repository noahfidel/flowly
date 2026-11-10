import { execFile } from "node:child_process";
import type { PaseoApi } from "@getpaseo/client";
import { familyOf, type Connection, type ExternalRef } from "../shared/connectors";
import { isPrReviewCard, prReviewCardKey } from "../shared/pr-review";
import type { Task } from "../shared/model";
import { refKey, type Summaries } from "./connectors/service";
import { logFailure } from "./error-report";
import type { BoardStore } from "./store";

/** PR review cards archived once their PR is merged or closed (PR-REVIEW-CARDS-SPEC §10). */

export type PrState = "open" | "merged" | "closed";
/** A pull request named by a card's `prRef` (`owner/repo#n`, lower case). */
export type PrTarget = { key: string; repo: string; number: number };
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
    const out = await run("gh", ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "state,mergedAt"]);
    const parsed = JSON.parse(out) as { state?: unknown; mergedAt?: unknown };
    if (parsed.state === "MERGED" || (typeof parsed.mergedAt === "string" && parsed.mergedAt)) return "merged";
    if (parsed.state === "CLOSED") return "closed";
    if (parsed.state === "OPEN") return "open";
    return null;
  };
}

export type ArchiveOutcome = { taskId: string; state: Exclude<PrState, "open"> };

/**
 * Every ~10 minutes, archives PR review cards still in In review whose pull request was merged or closed (§10).
 * Only the card is archived, as the board's Archive does; its workspace and sessions are left alone.
 */
export class PrReviewArchiver {
  /** The Archive review cards when the PR closes setting; set by the plugin entry. */
  enabled: () => Promise<boolean> = async () => true;
  /** The attached Paseo API, or null before the first hook or RPC after a start. */
  paseo: () => PaseoApi | null = () => null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<ArchiveOutcome[]> | null = null;
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
  tick(): Promise<ArchiveOutcome[]> {
    if (!this.running)
      this.running = this.check().finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async check(): Promise<ArchiveOutcome[]> {
    if (!(await this.enabled())) return [];
    const board = await this.store.read();
    const live = new Set(board.projects.filter((p) => !p.archivedAt).map((p) => p.id));
    const candidates = board.tasks.filter((t) => live.has(t.projectId) && archiveCandidate(t));
    for (const id of [...this.checkedAt.keys()]) if (!candidates.some((t) => t.id === id)) this.checkedAt.delete(id);
    if (!candidates.length) return [];
    const paseo = this.paseo();
    if (!paseo) {
      if (!this.loggedNoPaseo) {
        this.loggedNoPaseo = true;
        this.log("Flowly: PR review cards not checked yet: Paseo is not attached (logged once per run).");
      }
      return [];
    }
    const busy = await runningWorkspaces(paseo);
    const due = candidates
      .filter((t) => !busy.has(t.workspaceId))
      .sort((a, b) => (this.checkedAt.get(a.id) ?? 0) - (this.checkedAt.get(b.id) ?? 0) || a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, archiveLookupsPerTick);
    const archived: ArchiveOutcome[] = [];
    let unknown = 0;
    for (const task of due) {
      const pr = cardPr(task)!;
      const state = await this.lookup(pr).catch(() => null);
      this.checkedAt.set(task.id, this.clock());
      if (!state) {
        unknown++;
        continue;
      }
      if (state === "open") continue;
      if (await this.archive(task, state)) archived.push({ taskId: task.id, state });
    }
    if (unknown && unknown === due.length) {
      if (!this.loggedUnknown) {
        this.loggedUnknown = true;
        this.log("Flowly: PR states could not be read (no GitHub connector token, and gh failed or is missing); review cards are not archived (logged once until a lookup works).");
      }
    } else if (due.length) this.loggedUnknown = false;
    return archived;
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
