import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { absoluteTarget, artifactNoteLine } from "../shared/artifacts";
import { artifactLimits, type Artifact, type Board, type Task } from "../shared/model";
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
  // A negated word ("not fixed", "not yet deferred") states nothing; "not actioned" is its own status.
  const lower = text.toLowerCase().replace(/\b(?:not|never)\s+(?:yet\s+)?(?:fixed|deferred|open)\b/g, (m) => " ".repeat(m.length));
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

/** What a card's ledger is matched by (§1). A card with a `prRef` never has a branch. */
export type CardIdentity = { owner: string; repo: string; pr?: number; branch?: string };
/** `unknown`: the card's facts could not be read this time; `none`: read, and nothing to match. */
export type CardMatch = { state: "unknown" } | { state: "none" } | { state: "match"; id: CardIdentity };

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

/** What a sync knows of a card's workspace: the Paseo descriptor's facts, `git` filling gaps. */
export type WorkspaceFacts = {
  directory?: string | null;
  /** Paseo's `workspaceKind`: only "worktree" may match by branch or by its PR. */
  kind?: string | null;
  branch?: string | null;
  remoteUrl?: string | null;
  /** The repository's default branch (origin HEAD), when known. */
  defaultBranch?: string | null;
  pr?: { number?: number; owner?: string; repo?: string } | null;
};

export function factsOf(descriptor: unknown): WorkspaceFacts | null {
  if (!descriptor || typeof descriptor !== "object") return null;
  const d = descriptor as {
    workspaceDirectory?: string;
    workspaceKind?: string;
    gitRuntime?: { currentBranch?: string | null; remoteUrl?: string | null } | null;
    githubRuntime?: { pullRequest?: { number?: number; repoOwner?: string; repoName?: string } | null } | null;
  };
  const pr = d.githubRuntime?.pullRequest;
  return {
    directory: d.workspaceDirectory ?? null,
    kind: d.workspaceKind ?? null,
    branch: d.gitRuntime?.currentBranch ?? null,
    remoteUrl: d.gitRuntime?.remoteUrl ?? null,
    pr: pr ? { number: pr.number, owner: pr.repoOwner, repo: pr.repoName } : null,
  };
}

/** Branch names never matched: the default branch is shared by everything checked out on it (§1). */
export function defaultBranchName(branch: string, defaultBranch?: string | null) {
  const b = branch.toLowerCase();
  return b === "main" || b === "master" || b === "head" || (!!defaultBranch && b === defaultBranch.toLowerCase());
}

/**
 * The card's ledger key (§1). A card with a `prRef` matches only that PR's files. Without one, only a
 * worktree the card owns, shared with no other live card, matches: by its PR, then by its branch
 * (never the default branch). `shared`: another live card has the same workspace or folder.
 */
export function cardIdentity(task: Pick<Task, "prRef" | "ownsWorkspace">, facts: WorkspaceFacts | null, shared = false): CardMatch {
  if (task.prRef) {
    const ref = prTarget(task.prRef);
    const repo = ref ? repoFromRemote(`/${ref.repo}`) : null;
    return ref && repo ? { state: "match", id: { ...repo, pr: ref.number } } : { state: "none" };
  }
  if (!facts) return { state: "unknown" };
  if (!task.ownsWorkspace || facts.kind !== "worktree" || shared) return { state: "none" };
  const wsPr = facts.pr;
  const repo = (wsPr?.owner && wsPr.repo ? { owner: wsPr.owner, repo: wsPr.repo } : null) ?? repoFromRemote(facts.remoteUrl);
  if (!repo) return { state: "none" };
  const pr = wsPr?.number;
  const branch = facts.branch && !defaultBranchName(facts.branch, facts.defaultBranch) ? facts.branch : undefined;
  if (!pr && !branch) return { state: "none" };
  return { state: "match", id: { ...repo, ...(pr ? { pr } : {}), ...(branch ? { branch } : {}) } };
}

/** `branch-<name, slashes as dashes>.md`. */
export const branchLedgerName = (branch: string) => `branch-${branch.replace(/\//g, "-")}.md`;

/** Lists the ledger folder lazily, once per sync: lower-cased names to real names. */
export class LedgerFolder {
  private dirs: Promise<Map<string, string>> | null = null;
  private files = new Map<string, Promise<Map<string, string>>>();
  constructor(readonly root: string) {}
  private list(path: string) {
    return readdir(path, { withFileTypes: true }).catch(() => []);
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
   * Folder and file names compare case-insensitively. `via` says which kind matched.
   */
  async find(id: CardIdentity): Promise<{ path: string; via: "pr" | "branch" } | null> {
    const dir = (await this.repoDirs()).get(`${id.owner}-${id.repo}`.toLowerCase());
    if (!dir) return null;
    const files = await this.filesOf(dir);
    const names: [string, "pr" | "branch"][] = [
      ...(id.pr ? ([[`pr-${id.pr}.md`, "pr"], [`pr-${id.pr}-merged.md`, "pr"]] as [string, "pr"][]) : []),
      ...(id.branch ? ([[branchLedgerName(id.branch), "branch"]] as [string, "branch"][]) : []),
    ];
    for (const [name, via] of names) {
      const hit = files.get(name.toLowerCase());
      if (hit) return { path: join(this.root, dir, hit), via };
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

/** What one card should carry (§3): its ledger, nothing (`null`, facts read), or keep what it has (`unknown`). */
export type LedgerWant = { path: string; note: string } | null | "unknown";

const titleOf = (path: string) => `Review ledger (${path.split(/[\\/]/).pop()!.replace(/\.md$/i, "")})`.slice(0, artifactLimits.title);
const exists = (path: string) => stat(path).then((s) => s.isFile()).catch(() => false);
const realOf = (path: string) => realpath(path).catch(() => path);

/**
 * Brings one card's Flowly-owned ledger records in line with `want` (§3). Never touches an artifact a
 * person or an agent added; when one of those already points at the ledger, Flowly adds none (and drops
 * its own). A record whose file is missing is removed only when `missedBefore` says it was missing at the
 * previous sync too (an atomic rewrite never churns it); `missing` returns this sync's missing ids.
 * A record for another file than `want`, or any record when `want` is null, is removed at once.
 */
export async function applyLedger(
  store: BoardStore,
  taskId: string,
  want: LedgerWant,
  options: { workspaceDirectory?: string | null; missedBefore?: (artifactId: string) => boolean; snapshot?: Board } = {},
): Promise<{ changed: boolean; missing: string[] }> {
  const missedBefore = options.missedBefore ?? (() => false);
  const board = options.snapshot ?? (await store.read());
  const task = board.tasks.find((t) => t.id === taskId);
  if (!task || task.archivedAt) return { changed: false, missing: [] };
  const mine = board.artifacts.filter((a) => a.taskId === taskId && a.origin === ledgerOrigin);
  const missing: string[] = [];
  for (const a of mine) if (!(await exists(a.target))) missing.push(a.id);
  const target = want && want !== "unknown" ? want : null;
  const others = board.artifacts.some((a) => a.taskId === taskId && a.origin !== ledgerOrigin && a.kind === "file");
  // Nothing to do, seen from the snapshot (the write below rechecks everything).
  if (!mine.length && !target) return { changed: false, missing };
  if (target && !others && !missing.length && mine.length === 1 && mine[0].target === target.path && mine[0].note === target.note) return { changed: false, missing };
  const changed = await store.transaction(async (b) => {
    const t = b.tasks.find((x) => x.id === taskId);
    const project = t && b.projects.find((p) => p.id === t.projectId);
    if (!t || t.archivedAt || !project || project.archivedAt) return { value: false, changed: false };
    // People's and agents' artifacts come from this read, not the snapshot.
    let theirs = false;
    if (target) {
      const real = await realOf(target.path);
      for (const a of b.artifacts)
        if (a.taskId === taskId && a.origin !== ledgerOrigin && a.kind === "file") {
          const path = absoluteTarget(a.target, options.workspaceDirectory || t.sourcePath);
          if (path === target.path || (await realOf(path)) === real) theirs = true;
        }
    }
    const now = new Date().toISOString();
    let dirty = false;
    const drop = (a: Artifact) => {
      b.artifacts = b.artifacts.filter((x) => x !== a);
      eventOf(store, b, a, "artifact_removed");
      dirty = true;
    };
    for (const a of b.artifacts.filter((x) => x.taskId === taskId && x.origin === ledgerOrigin)) {
      const isMissing = missing.includes(a.id);
      if (isMissing && missedBefore(a.id)) drop(a);
      else if (want === "unknown") continue;
      else if (!target) {
        // Missing once: maybe mid-rewrite, decide at the next sync.
        if (!isMissing) drop(a);
      } else if (theirs || a.target !== target.path) drop(a);
      else if (a.note !== target.note) {
        a.note = target.note;
        a.updatedAt = now;
        dirty = true;
      }
    }
    if (target && !theirs && !b.artifacts.some((a) => a.taskId === taskId && a.origin === ledgerOrigin && a.target === target.path)) {
      const taken = b.artifacts.some((a) => a.taskId === taskId && a.kind === "file" && a.target === target.path);
      if (!taken && b.artifacts.filter((a) => a.taskId === taskId).length < artifactLimits.perTask) {
        const artifact: Artifact = {
          id: randomUUID(),
          taskId,
          projectId: t.projectId,
          role: "output",
          kind: "file",
          target: target.path,
          title: titleOf(target.path),
          note: target.note,
          createdBy: "human",
          origin: ledgerOrigin,
          createdAt: now,
          updatedAt: now,
        };
        b.artifacts.push(artifact);
        eventOf(store, b, artifact, "artifact_added");
        dirty = true;
      }
    }
    return { value: dirty, changed: dirty };
  });
  return { changed, missing };
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

export type GitFacts = { remoteUrl: string | null; branch: string | null; defaultBranch: string | null };

/** Reads a folder's origin URL, branch and origin HEAD with `git` (argument arrays, never a shell); null outside git. */
export function gitFacts(run: Run = runFile) {
  return async (directory: string): Promise<GitFacts | null> => {
    const top = await run("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"]).catch(() => "");
    if (top.trim() !== "true") return null;
    const [remote, branch, head] = await Promise.all([
      run("git", ["-C", directory, "remote", "get-url", "origin"]).catch(() => ""),
      // The branch name, also before the first commit; nothing on a detached HEAD.
      run("git", ["-C", directory, "symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ""),
      run("git", ["-C", directory, "symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]).catch(() => ""),
    ]);
    return { remoteUrl: remote.trim() || null, branch: branch.trim() || null, defaultBranch: head.trim().replace(/^origin\//, "") || null };
  };
}

type Settings = { attach: boolean; folder: string };
type Paseo = Pick<PaseoApi, "workspaces">;
/** At most this long, card open and `flowly_get_task` wait for a sync; it finishes in the background (§4). */
export const ledgerWaitMs = 1_000;

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
  /** Per card, Flowly records whose file was missing at its last sync (§3, two syncs in a row). */
  private missed = new Map<string, Set<string>>();

  constructor(
    readonly store: BoardStore,
    readonly git: (directory: string) => Promise<GitFacts | null> = gitFacts(),
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

  /** `syncCard`, waited for at most `ledgerWaitMs`; the rest runs in the background. Never throws. */
  async syncCardSoon(taskId: string, paseo: Paseo | null = this.paseo(), waitMs = ledgerWaitMs): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((done) => {
      timer = setTimeout(done, waitMs);
      timer.unref?.();
    });
    await Promise.race([this.syncCard(taskId, paseo), cap]);
    clearTimeout(timer);
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
      if (!task || task.archivedAt) return;
      const facts = await this.workspaceFacts(paseo);
      // A workspace the list missed (a slow host, an older daemon): asked once directly.
      if (paseo && !facts.has(task.workspaceId)) {
        const one = factsOf(await paseo.workspaces.ref(task.workspaceId).refresh().catch(() => null));
        if (one) facts.set(task.workspaceId, one);
      }
      const wants = await this.plan(board, facts, new LedgerFolder(root), taskId);
      if (wants.has(taskId)) await this.apply(task, wants.get(taskId)!, facts);
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
    const facts = await this.workspaceFacts(this.paseo());
    const wants = await this.plan(board, facts, new LedgerFolder(root));
    let changed = 0;
    for (const [taskId, want] of wants) {
      const task = board.tasks.find((t) => t.id === taskId)!;
      this.seen.set(taskId, this.clock());
      const ok = await this.apply(task, want, facts, board).catch((e) => {
        logFailure("Flowly review ledger not synced:", e, taskId);
        return false;
      });
      if (ok) changed++;
    }
    return changed;
  }

  private async apply(task: Task, want: LedgerWant, facts: Map<string, WorkspaceFacts>, snapshot?: Board) {
    const result = await applyLedger(this.store, task.id, want, {
      workspaceDirectory: facts.get(task.workspaceId)?.directory,
      missedBefore: (id) => !!this.missed.get(task.id)?.has(id),
      snapshot,
    });
    if (result.missing.length) this.missed.set(task.id, new Set(result.missing));
    else this.missed.delete(task.id);
    return result.changed;
  }

  /**
   * What every live card (or just `only`) should carry (§1, §3). Every live card's key is worked out, as
   * a branch ledger two cards would match goes to neither; PR ledgers may go to several cards.
   */
  private async plan(board: Board, facts: Map<string, WorkspaceFacts>, folder: LedgerFolder, only?: string): Promise<Map<string, LedgerWant>> {
    const live = new Map(board.projects.filter((p) => !p.archivedAt).map((p) => [p.id, p]));
    const cards = board.tasks.filter((t) => !t.archivedAt && live.has(t.projectId));
    const git = new Map<string, Promise<GitFacts | null>>();
    const gitOf = (dir: string) => {
      let hit = git.get(dir);
      if (!hit) git.set(dir, (hit = this.git(dir).catch(() => null)));
      return hit;
    };
    // Cards sharing a workspace or a folder can't tell whose branch or PR it is.
    const byWorkspace = new Map<string, number>();
    const byDirectory = new Map<string, number>();
    for (const t of cards) {
      byWorkspace.set(t.workspaceId, (byWorkspace.get(t.workspaceId) ?? 0) + 1);
      const dir = facts.get(t.workspaceId)?.directory;
      if (dir) byDirectory.set(dir, (byDirectory.get(dir) ?? 0) + 1);
    }
    const found = new Map<string, { path: string; via: "pr" | "branch" } | null | "unknown">();
    for (const t of cards) {
      // Only cards that could match by branch matter besides `only` (they decide what is ambiguous).
      if (only && t.id !== only && (t.prRef || !t.ownsWorkspace)) continue;
      let f = facts.get(t.workspaceId) ?? null;
      const shared = (byWorkspace.get(t.workspaceId) ?? 0) > 1 || (!!f?.directory && (byDirectory.get(f.directory) ?? 0) > 1);
      if (!t.prRef && f?.directory && t.ownsWorkspace && f.kind === "worktree" && !shared) {
        // `git` fills what the descriptor lacks, and always gives the default branch.
        const local = await gitOf(f.directory);
        if (local) f = { ...f, branch: f.branch || local.branch, remoteUrl: f.remoteUrl || local.remoteUrl, defaultBranch: local.defaultBranch };
      }
      const match = cardIdentity(t, f, shared);
      found.set(t.id, match.state === "unknown" ? "unknown" : match.state === "none" ? null : await folder.find(match.id));
    }
    const branchUse = new Map<string, number>();
    for (const hit of found.values()) if (hit && hit !== "unknown" && hit.via === "branch") branchUse.set(hit.path, (branchUse.get(hit.path) ?? 0) + 1);
    const wants = new Map<string, LedgerWant>();
    for (const [taskId, hit] of found) {
      if (only && taskId !== only) continue;
      if (hit === "unknown" || !hit) {
        wants.set(taskId, hit);
        continue;
      }
      if (hit.via === "branch" && (branchUse.get(hit.path) ?? 0) > 1) {
        wants.set(taskId, null);
        continue;
      }
      const text = await readLedger(hit.path);
      wants.set(taskId, { path: hit.path, note: summaryLine(text === null ? null : parseLedgerSummary(text)) });
    }
    return wants;
  }

  /** Every workspace's facts in a few list calls; empty without Paseo. */
  private async workspaceFacts(paseo: Paseo | null): Promise<Map<string, WorkspaceFacts>> {
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
}

async function readLedger(path: string): Promise<string | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > maxLedgerBytes) return null;
  return readFile(path, "utf8").catch(() => null);
}
