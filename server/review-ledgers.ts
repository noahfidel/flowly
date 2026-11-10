import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { absoluteTarget, artifactNoteLine } from "../shared/artifacts";
import { artifactLimits, type Artifact, type Board, type Project, type Task } from "../shared/model";
import { resolveExtraRoots } from "./artifacts";
import { logFailure } from "./error-report";
import { prTarget } from "./pr-review-archive";
import type { BoardStore } from "./store";

/**
 * Review ledgers on cards (REVIEW-LEDGERS-SPEC): the per-PR review ledger file in the ledger folder
 * is attached to its card as a Flowly-owned output, with the newest round's status as its note.
 * Only reads the ledger folder; never writes it. No network.
 */

export const ledgerOrigin = "review-ledger" as const;
/** A sweep shortly after start (the backfill), then every 5 minutes (§4). */
export const ledgerFirstDelayMs = 30_000;
export const ledgerTickMs = 5 * 60_000;
/** A card opened or read again within this time is not looked at again (§4). */
export const ledgerCardThrottleMs = 30_000;
const maxLedgerBytes = 1024 * 1024;

// ---------------------------------------------------------------- summary

export type LedgerSummary = { round: number; counts: { open: number; fixed: number; deferred: number } | null };

const roundHeading = /^##\s+Round\s+(\d+)\s*:/i;
const findingLine = /^\s*(?:[-*+]\s+|\d+[.)]\s+|#{3,6}\s+|\|\s*)?(?:\*\*|__)?Finding\s+(\d+)\b(.*)$/i;
const dismissedLine = /^\s*(?:[-*+]\s+|#{3,6}\s+)?(?:\*\*|__)?Dismissed\b/i;
type FindingStatus = "open" | "fixed" | "deferred" | "not_actioned";
const statusWords: [FindingStatus, RegExp][] = [
  ["not_actioned", /not actioned/g],
  ["fixed", /\bfixed\b/g],
  ["deferred", /\bdeferred\b/g],
  ["open", /\bopen\b/g],
];

/** The status a line states: after an explicit `status:` when there is one, else the last status word in it. */
function statusOf(text: string): FindingStatus | null {
  const lower = text.toLowerCase();
  const marked = /\bstatus\s*[:=]\s*(.*)$/.exec(lower);
  const scope = marked ? marked[1] : lower;
  let best: { status: FindingStatus; at: number } | null = null;
  for (const [status, pattern] of statusWords) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(scope); m; m = pattern.exec(scope)) {
      // "raised, not actioned" holds no other word; elsewhere the earliest word after `status:` wins, else the last one.
      const at = marked ? -m.index : m.index;
      if (!best || at > best.at) best = { status, at };
    }
  }
  return best?.status ?? null;
}

/**
 * The newest `## Round N:` section's findings by status (§2). `counts` is null when the round has no
 * "Finding N" lines or one of them states no status: then only the round is shown.
 */
export function parseLedgerSummary(text: string): LedgerSummary | null {
  const lines = text.split(/\r?\n/);
  let start = -1,
    round = -1;
  lines.forEach((line, i) => {
    const m = roundHeading.exec(line);
    if (m && Number(m[1]) >= round) {
      round = Number(m[1]);
      start = i;
    }
  });
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++)
    if (/^#{1,2}\s/.test(lines[i])) {
      end = i;
      break;
    }
  const statuses = new Map<number, FindingStatus | null>();
  let current: number | null = null;
  for (const line of lines.slice(start + 1, end)) {
    if (dismissedLine.test(line)) break;
    const m = findingLine.exec(line);
    if (m) {
      current = Number(m[1]);
      if (!statuses.has(current) || !statuses.get(current)) statuses.set(current, statusOf(m[2]));
      continue;
    }
    // A finding's status may sit on a following line ("  - Status: fixed in abc123").
    if (current !== null && !statuses.get(current) && /\bstatus\s*[:=]/i.test(line)) statuses.set(current, statusOf(line));
    if (/^#{3,6}\s/.test(line)) current = null;
  }
  if (!statuses.size || [...statuses.values()].some((s) => !s)) return { round, counts: null };
  const counts = { open: 0, fixed: 0, deferred: 0 };
  for (const status of statuses.values()) if (status && status !== "not_actioned") counts[status]++;
  return { round, counts };
}

/** "Review: round 3 · 1 open, 2 fixed, 0 deferred", or "Review: round 3" without counts. */
export function summaryLine(summary: LedgerSummary | null): string {
  if (!summary) return "";
  const head = `Review: round ${summary.round}`;
  const c = summary.counts;
  return c ? `${head} · ${c.open} open, ${c.fixed} fixed, ${c.deferred} deferred` : head;
}

// ---------------------------------------------------------------- matching

/** What a card's ledger is matched by (§1). */
export type CardIdentity = { owner: string; repo: string; pr?: number; branch?: string };

/** owner/repo from a git remote URL (`git@host:o/r.git`, `https://host/o/r`, `ssh://git@host:22/o/r.git`). */
export function repoFromRemote(url: string | null | undefined): { owner: string; repo: string } | null {
  const value = url?.trim();
  if (!value) return null;
  const path = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "") : value.replace(/^[^@/]+@[^:/]+:/, "");
  const parts = path.replace(/\.git\/?$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts.slice(-2);
  return /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(repo) ? { owner, repo } : null;
}

/** What the sweep knows of a card's workspace: the Paseo descriptor's git and GitHub facts. */
export type WorkspaceFacts = { directory?: string | null; branch?: string | null; remoteUrl?: string | null; pr?: { number?: number; owner?: string; repo?: string } | null };

export function factsOf(descriptor: unknown): WorkspaceFacts | null {
  if (!descriptor || typeof descriptor !== "object") return null;
  const d = descriptor as {
    workspaceDirectory?: string;
    gitRuntime?: { currentBranch?: string | null; remoteUrl?: string | null } | null;
    githubRuntime?: { pullRequest?: { number?: number; repoOwner?: string; repoName?: string } | null } | null;
  };
  const pr = d.githubRuntime?.pullRequest;
  return {
    directory: d.workspaceDirectory ?? null,
    branch: d.gitRuntime?.currentBranch ?? null,
    remoteUrl: d.gitRuntime?.remoteUrl ?? null,
    pr: pr ? { number: pr.number, owner: pr.repoOwner, repo: pr.repoName } : null,
  };
}

/**
 * The card's repository, PR and branch (§1): owner/repo from the card's PR, else the workspace's PR,
 * else the origin remote; the PR from `prRef`, else the workspace's PR; the branch from the worktree.
 * Null when no repository is known (not a git folder, no origin).
 */
export function cardIdentity(task: Pick<Task, "prRef">, facts: WorkspaceFacts | null, projectRemote?: string | null): CardIdentity | null {
  const ref = prTarget(task.prRef);
  const refRepo = ref ? repoFromRemote(`/${ref.repo}`) : null;
  const wsPr = facts?.pr;
  const repo =
    refRepo ??
    (wsPr?.owner && wsPr.repo ? { owner: wsPr.owner, repo: wsPr.repo } : null) ??
    repoFromRemote(facts?.remoteUrl) ??
    repoFromRemote(projectRemote);
  if (!repo) return null;
  const pr = ref?.number ?? (wsPr?.number && (!refRepo || sameRepo(refRepo, wsPr)) ? wsPr.number : undefined);
  const branch = facts?.branch && facts.branch !== "HEAD" ? facts.branch : undefined;
  return { ...repo, ...(pr ? { pr } : {}), ...(branch ? { branch } : {}) };
}
const sameRepo = (a: { owner: string; repo: string }, b: { owner?: string; repo?: string }) =>
  !b.owner || !b.repo || (a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase());

/** `branch-<name, slashes as dashes>.md`. */
export const branchLedgerName = (branch: string) => `branch-${branch.replace(/\//g, "-")}.md`;

/** Lists the ledger folder lazily, once per sweep: lower-cased names to real names. */
export class LedgerFolder {
  private dirs: Promise<Map<string, string>> | null = null;
  private files = new Map<string, Promise<Map<string, string>>>();
  constructor(readonly root: string) {}
  private list(path: string) {
    return readdir(path, { withFileTypes: true })
      .then((entries) => entries)
      .catch(() => []);
  }
  private repoDirs() {
    this.dirs ??= this.list(this.root).then((entries) => new Map(entries.filter((e) => e.isDirectory()).map((e) => [e.name.toLowerCase(), e.name])));
    return this.dirs;
  }
  private filesOf(dir: string) {
    let hit = this.files.get(dir);
    if (!hit) {
      hit = this.list(join(this.root, dir)).then((entries) => new Map(entries.filter((e) => e.isFile()).map((e) => [e.name.toLowerCase(), e.name])));
      this.files.set(dir, hit);
    }
    return hit;
  }
  /**
   * The ledger for a card, exact names only (§1): `pr-<n>.md`, then `pr-<n>-merged.md`, else the branch file.
   * Folder and file names compare case-insensitively.
   */
  async find(id: CardIdentity): Promise<string | null> {
    const dir = (await this.repoDirs()).get(`${id.owner}-${id.repo}`.toLowerCase());
    if (!dir) return null;
    const files = await this.filesOf(dir);
    const names = [...(id.pr ? [`pr-${id.pr}.md`, `pr-${id.pr}-merged.md`] : []), ...(id.branch ? [branchLedgerName(id.branch)] : [])];
    for (const name of names) {
      const hit = files.get(name.toLowerCase());
      if (hit) return join(this.root, dir, hit);
    }
    return null;
  }
}

// ---------------------------------------------------------------- folder check

export type LedgerFolderState = { usable: true; folder: string } | { usable: false; reason: "missing" | "outside" };

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** Whether the ledger folder exists and lies inside one of the extra artifact folders (§5). */
export async function ledgerFolderState(folder: string, extraFolders: readonly string[], home = homedir()): Promise<LedgerFolderState> {
  const value = folder.trim();
  const path = value === "~" || value.startsWith("~/") ? join(home, value.slice(1)) : value;
  if (!path || !isAbsolute(path)) return { usable: false, reason: "outside" };
  const real = await realpath(resolve(path)).catch(() => null);
  if (!real || !(await stat(real).then((s) => s.isDirectory()).catch(() => false))) return { usable: false, reason: "missing" };
  const roots = await resolveExtraRoots(extraFolders, home);
  return roots.some((root) => inside(real, root)) ? { usable: true, folder: real } : { usable: false, reason: "outside" };
}

// ---------------------------------------------------------------- applying

/** What one card should carry: its ledger's path and summary, or nothing (no ledger, or nothing known). */
export type LedgerWant = { path: string; note: string } | null;

const titleOf = (path: string) => `Review ledger (${path.split(/[\\/]/).pop()!.replace(/\.md$/i, "")})`.slice(0, artifactLimits.title);
const exists = (path: string) => stat(path).then((s) => s.isFile()).catch(() => false);
const realOf = (path: string) => realpath(path).catch(() => path);

/**
 * Brings one card's Flowly-owned ledger records in line with `want` (§3). Never touches an artifact
 * a person or an agent added; when one of those already points at the ledger, Flowly adds none.
 * Own records whose file is gone are removed; when the card's ledger is another file (renamed
 * branch- to pr-), the old record is swapped for the new one. With no ledger found (`want` null),
 * only records whose file is gone are removed: a card whose facts could not be read keeps its record.
 */
export async function applyLedger(
  store: BoardStore,
  taskId: string,
  want: LedgerWant,
  workspaceDirectory?: string | null,
  /** A board read moments ago (a sweep's); the write rechecks the card itself. */
  snapshot?: Board,
): Promise<boolean> {
  // File checks run outside the board's write queue.
  const board = snapshot ?? (await store.read());
  const task = board.tasks.find((t) => t.id === taskId);
  if (!task || task.archivedAt) return false;
  const mine = board.artifacts.filter((a) => a.taskId === taskId && a.origin === ledgerOrigin);
  const gone = new Set<string>();
  for (const a of mine) if (!(await exists(a.target))) gone.add(a.id);
  let theirs = false;
  if (want) {
    const real = await realOf(want.path);
    for (const a of board.artifacts)
      if (a.taskId === taskId && a.origin !== ledgerOrigin && a.kind === "file") {
        const path = absoluteTarget(a.target, workspaceDirectory || task.sourcePath);
        if (path === want.path || (await realOf(path)) === real) theirs = true;
      }
  }
  if (!gone.size && !want) return false;
  // Already in line: no write.
  if (!gone.size && want && (theirs ? !mine.length : mine.length === 1 && mine[0].target === want.path && mine[0].note === want.note)) return false;
  return store.transaction((b) => {
    const t = b.tasks.find((x) => x.id === taskId);
    const project = t && b.projects.find((p) => p.id === t.projectId);
    if (!t || t.archivedAt || !project || project.archivedAt) return { value: false, changed: false };
    const now = new Date().toISOString();
    let changed = false;
    const drop = (a: Artifact) => {
      b.artifacts = b.artifacts.filter((x) => x !== a);
      eventOf(store, b, a, "artifact_removed");
      changed = true;
    };
    for (const a of b.artifacts.filter((x) => x.taskId === taskId && x.origin === ledgerOrigin)) {
      if (gone.has(a.id)) drop(a);
      else if (want && (theirs || a.target !== want.path)) drop(a);
      else if (want && a.note !== want.note) {
        a.note = want.note;
        a.updatedAt = now;
        changed = true;
      }
    }
    if (want && !theirs && !b.artifacts.some((a) => a.taskId === taskId && a.origin === ledgerOrigin && a.target === want.path)) {
      // A target someone else already uses (exact text) or a full card is left alone.
      const taken = b.artifacts.some((a) => a.taskId === taskId && a.kind === "file" && a.target === want.path);
      if (!taken && b.artifacts.filter((a) => a.taskId === taskId).length < artifactLimits.perTask) {
        const artifact: Artifact = {
          id: randomUUID(),
          taskId,
          projectId: t.projectId,
          role: "output",
          kind: "file",
          target: want.path,
          title: titleOf(want.path),
          note: want.note,
          createdBy: "human",
          origin: ledgerOrigin,
          createdAt: now,
          updatedAt: now,
        };
        b.artifacts.push(artifact);
        eventOf(store, b, artifact, "artifact_added");
        changed = true;
      }
    }
    return { value: changed, changed };
  });
}

function eventOf(store: BoardStore, board: Board, artifact: Artifact, action: "artifact_added" | "artifact_removed") {
  store.event(board, { taskId: artifact.taskId, actor: "system", action, note: artifactNoteLine(artifact) });
}

// ---------------------------------------------------------------- service

type Run = (file: string, args: readonly string[]) => Promise<string>;
const runFile: Run = (file, args) =>
  new Promise((done, fail) =>
    execFile(file, [...args], { timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout) => (error ? fail(error) : done(String(stdout)))),
  );

/** Reads a folder's origin URL and branch with `git` (argument arrays, never a shell); null outside git. */
export function gitFacts(run: Run = runFile) {
  return async (directory: string): Promise<{ remoteUrl: string | null; branch: string | null } | null> => {
    const top = await run("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"]).catch(() => "");
    if (top.trim() !== "true") return null;
    const [remote, branch] = await Promise.all([
      run("git", ["-C", directory, "remote", "get-url", "origin"]).catch(() => ""),
      // The branch name, also before the first commit; nothing on a detached HEAD.
      run("git", ["-C", directory, "symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ""),
    ]);
    return { remoteUrl: remote.trim() || null, branch: branch.trim() || null };
  };
}

type Settings = { attach: boolean; folder: string };
type Paseo = Pick<PaseoApi, "workspaces">;

/** Keeps review ledgers attached to their cards: on card open, on `flowly_get_task`, and every 5 minutes (§4). */
export class ReviewLedgers {
  settings: () => Promise<Settings> = async () => ({ attach: false, folder: "" });
  extraFolders: () => Promise<readonly string[]> = async () => [];
  /** The attached Paseo API, or null before the first hook or RPC after a start. */
  paseo: () => Paseo | null = () => null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<number> | null = null;
  private seen = new Map<string, number>();

  constructor(
    readonly store: BoardStore,
    readonly git: (directory: string) => Promise<{ remoteUrl: string | null; branch: string | null } | null> = gitFacts(),
    readonly clock = () => Date.now(),
  ) {}

  start() {
    if (this.timer) return;
    const tick = () => void this.tick().catch((e) => logFailure("Flowly review ledger sweep failed:", e));
    this.first = setTimeout(tick, ledgerFirstDelayMs);
    this.timer = setInterval(tick, ledgerTickMs);
    this.first.unref?.();
    this.timer.unref?.();
  }
  stop() {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = this.timer = null;
  }

  /** The folder to read, or null when attaching is off or the folder is not usable (§5). */
  private async folder(): Promise<string | null> {
    const s = await this.settings();
    if (!s.attach) return null;
    const state = await ledgerFolderState(s.folder, await this.extraFolders());
    return state.usable ? state.folder : null;
  }

  /** For the settings screen (§5). */
  async check(): Promise<{ attach: boolean } & ({ usable: true } | { usable: false; reason: "missing" | "outside" })> {
    const s = await this.settings();
    const state = await ledgerFolderState(s.folder, await this.extraFolders());
    return state.usable ? { attach: s.attach, usable: true } : { attach: s.attach, usable: false, reason: state.reason };
  }

  /** One card, when it is opened or read; at most once per 30 seconds per card. Never throws. */
  async syncCard(taskId: string, paseo: Paseo | null = this.paseo()): Promise<void> {
    const now = this.clock();
    if (now - (this.seen.get(taskId) ?? -Infinity) < ledgerCardThrottleMs) return;
    this.seen.set(taskId, now);
    try {
      const root = await this.folder();
      if (!root) return;
      const board = await this.store.read();
      const task = board.tasks.find((t) => t.id === taskId);
      const project = board.projects.find((p) => p.id === task?.projectId);
      if (!task || !project || task.archivedAt || project.archivedAt) return;
      const descriptor = paseo ? await paseo.workspaces.ref(task.workspaceId).refresh().catch(() => null) : null;
      await this.syncOne(new LedgerFolder(root), task, project, factsOf(descriptor), new Map());
    } catch (e) {
      logFailure("Flowly review ledger not synced:", e, taskId);
    }
  }

  /** One sweep over every live card; a sweep still running is joined, never doubled. Returns the cards changed. */
  tick(): Promise<number> {
    if (!this.running)
      this.running = this.sweep().finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async sweep(): Promise<number> {
    const root = await this.folder();
    if (!root) return 0;
    const board = await this.store.read();
    const live = new Map(board.projects.filter((p) => !p.archivedAt).map((p) => [p.id, p]));
    const cards = board.tasks.filter((t) => !t.archivedAt && live.has(t.projectId));
    if (!cards.length) return 0;
    const descriptors = await this.workspaceFacts();
    const folder = new LedgerFolder(root);
    const gitCache = new Map<string, Promise<{ remoteUrl: string | null; branch: string | null } | null>>();
    let changed = 0;
    for (const task of cards) {
      this.seen.set(task.id, this.clock());
      const ok = await this.syncOne(folder, task, live.get(task.projectId)!, descriptors.get(task.workspaceId) ?? null, gitCache, board).catch((e) => {
        logFailure("Flowly review ledger not synced:", e, task.id);
        return false;
      });
      if (ok) changed++;
    }
    return changed;
  }

  /** Every workspace's facts in a few list calls; empty without Paseo (the git fallback still runs). */
  private async workspaceFacts(): Promise<Map<string, WorkspaceFacts>> {
    const paseo = this.paseo();
    const map = new Map<string, WorkspaceFacts>();
    if (!paseo) return map;
    let cursor: string | undefined;
    try {
      do {
        const page = await paseo.workspaces.list({ filter: { includeBackground: true }, page: { limit: 200, cursor } });
        for (const w of page.entries) {
          const facts = factsOf(w);
          if (facts) map.set(w.id, facts);
        }
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
    } catch (e) {
      logFailure("Flowly review ledger workspace list failed:", e);
    }
    return map;
  }

  private async syncOne(
    folder: LedgerFolder,
    task: Task,
    project: Project,
    facts: WorkspaceFacts | null,
    gitCache: Map<string, Promise<{ remoteUrl: string | null; branch: string | null } | null>>,
    snapshot?: Board,
  ): Promise<boolean> {
    const git = (dir: string) => {
      let hit = gitCache.get(dir);
      if (!hit) gitCache.set(dir, (hit = this.git(dir).catch(() => null)));
      return hit;
    };
    // The descriptor first; `git` fills what it lacks (a workspace Paseo no longer lists, an older daemon).
    let merged = facts;
    const dir = facts?.directory || null;
    if (dir && (!facts?.branch || !facts.remoteUrl)) {
      const local = await git(dir);
      if (local) merged = { ...facts, branch: facts?.branch || local.branch, remoteUrl: facts?.remoteUrl || local.remoteUrl };
    }
    const projectRemote = merged?.remoteUrl ? null : ((await git(project.primaryPath))?.remoteUrl ?? null);
    const id = cardIdentity(task, merged, projectRemote);
    if (!id) return applyLedger(this.store, task.id, null, dir, snapshot);
    const path = await folder.find(id);
    if (!path) return applyLedger(this.store, task.id, null, dir, snapshot);
    const text = await readLedger(path);
    return applyLedger(this.store, task.id, { path, note: summaryLine(text === null ? null : parseLedgerSummary(text)) }, dir, snapshot);
  }
}

async function readLedger(path: string): Promise<string | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > maxLedgerBytes) return null;
  return readFile(path, "utf8").catch(() => null);
}
