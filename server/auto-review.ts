import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import { laneEnabled } from "../shared/lanes";
import {
  autoReviewLimits,
  type AcceptanceItem,
  type Board,
  type ChangeShape,
  type GitHead,
  type HistoryStatus,
  type Project,
  type ReviewItem,
  type Task,
  type TaskType,
} from "../shared/model";
import {
  GOAL_ID,
  GOAL_NAME,
  autoReviewOf,
  autoReviewRuns,
  continuesRound,
  conversationForReview,
  conversationLimits,
  defaultCheckTimeoutSec,
  failureSummary,
  goalPrompt,
  hasEvidence,
  itemPassed,
  outputTail,
  reviewFailedRule,
  reviewFinishedAction,
  reviewStartedAction,
  reviewVerdict,
  reworkMessage,
  reworkRule,
  reworkStage,
} from "../shared/auto-review";
import { sizeOf, type CardItem, type GuardrailEntry } from "../shared/guardrails";
import type { BoardStore } from "./store";
import { isSummarizer } from "../shared/summary";
import { logFailure } from "./error-report";

/** An agent delivery to In review that starts a review (AUTO-REVIEW-SPEC §3.1). */
export type DeliveredReview = { taskId: string; projectId: string; eventId: string; agentId: string; from: HistoryStatus };

/** One check the review session judges (GUARDRAILS-SPEC §6.3): the built-in goal, a guideline or a card item. */
export type JudgedCheck = {
  id: string;
  kind: "goal" | "guideline" | "item";
  /** What to judge: the built-in check's rule, the guideline's sentence, the card item's text. */
  text: string;
  /** The user's own words it came from. */
  quote?: string;
  /** Round ≥ 2: its result in the previous round. */
  previous?: { state: string; detail?: string };
};
/** What the review session reads (GUARDRAILS-SPEC §6.3). */
export type LlmReviewInput = {
  task: { id: string; title: string; description: string; type?: TaskType; workspaceId: string };
  checks: JudgedCheck[];
  /** The user's messages in the card's sessions, oldest first (§4.2); null when they could not be read. */
  conversation?: string[] | null;
  /** The workspace is not a worktree: the diff may hold other cards' uncommitted changes (§2 limit 3). */
  shared?: boolean;
  /** The card's acceptance list: the agent's own claim, context only. */
  acceptance: AcceptanceItem[];
  deliveryNote: string;
  outputs: string[];
  commands: string[];
  diff: string;
  /** Round ≥ 2 of a rework: `diff` holds only what changed since the previous delivery (§6.3). */
  incremental?: boolean;
  /** The delivering session, as the review session's parent. */
  parentAgentId: string;
};
export type LlmVerdict = { id: string; verdict: "pass" | "fail" | "na"; detail: string; file?: string; line?: number; quote?: string };
export type LlmReview = (input: LlmReviewInput, paseo: PaseoApi) => Promise<{ model: string; verdicts: LlmVerdict[] }>;

const execute = promisify(execFile);
export type Git = (cwd: string, args: string[]) => Promise<string>;
export const defaultGit: Git = async (cwd, args) =>
  (await execute("git", ["-C", cwd, ...args], { timeout: 20_000, maxBuffer: 16 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout;

const shaPattern = /^[0-9a-f]{4,40}$/;
/** HEAD, branch and dirty state of a workspace, for the review's fingerprint; null when git fails. */
export async function readHead(dir: string, git: Git, now = new Date().toISOString()): Promise<GitHead | null> {
  try {
    const sha = (await git(dir, ["rev-parse", "--short=12", "HEAD"])).trim();
    if (!shaPattern.test(sha)) return null;
    const [branch, status] = await Promise.all([
      git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).then(
        (s) => s.trim(),
        () => "",
      ),
      git(dir, ["status", "--porcelain"]).then(
        (s) => s,
        () => "",
      ),
    ]);
    return { sha, ...(branch && branch !== "HEAD" ? { branch } : {}), dirty: !!status.trim(), at: now };
  } catch {
    return null;
  }
}

const diffLimit = 64 * 1024;
/**
 * Where a worktree card's own change starts (GUARDRAILS-SPEC §6.2): `git merge-base <baseRef> HEAD`. null for a card
 * without a base ref (directory, linked or older cards) or when git cannot resolve it: the caller falls back.
 */
export async function changeBase(directory: string, baseRef: string | undefined, git: Git = defaultGit): Promise<string | null> {
  const ref = baseRef?.trim();
  if (!ref || ref.startsWith("-")) return null;
  const sha = await git(directory, ["merge-base", ref, "HEAD"]).then(
    (s) => s.trim(),
    () => "",
  );
  return shaPattern.test(sha) ? sha : null;
}

/** Files git does not track and does not ignore (§6.2); `git add -N` is never used, so the index stays as it is. */
async function untrackedFiles(directory: string, git: Git): Promise<string[]> {
  return (await git(directory, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter((f) => f && !f.endsWith("/"));
}
const newFileLimit = 1 << 20;
/** A new file over 1 MiB is not read, like a binary one (§6.2); an unreadable one neither. */
const readable = (path: string) =>
  stat(path).then(
    (s) => s.isFile() && s.size <= newFileLimit,
    () => false,
  );
/** A new file's lines as `git diff` would count them; a binary file (a NUL byte in the first 8 KiB), one over 1 MiB or an unreadable one counts 0. */
async function fileLines(path: string): Promise<number> {
  if (!(await readable(path))) return 0;
  const data = await readFile(path).catch(() => null);
  if (!data?.length || data.subarray(0, 8192).includes(0)) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 10) lines++;
  return data[data.length - 1] === 10 ? lines : lines + 1;
}
/** `git diff --no-index` exits 1 when the files differ, which for a new file is always: that output is the diff. */
async function newFileDiff(directory: string, file: string, git: Git, shown: string[] = []): Promise<string> {
  return git(directory, ["diff", "--no-index", "--no-color", ...shown, "--", "/dev/null", file]).catch((e: unknown) => {
    const failure = e as { code?: unknown; stdout?: unknown } | null;
    return failure?.code === 1 && typeof failure.stdout === "string" ? failure.stdout : "";
  });
}

/** `git diff` / `git log -p` flags that show each path under the repository's folder name in a linked root (§6.2). */
const prefixArgs = (prefix: string) => (prefix ? [`--src-prefix=a/${prefix}`, `--dst-prefix=b/${prefix}`] : []);

/**
 * What the review session reads, cut at 64 KiB: a worktree card's change since it branched off `baseRef` (or, without
 * one, uncommitted changes plus the last few commits); with `since` (round ≥ 2, §6.3) only what changed since that
 * commit. Untracked new files follow in every mode. Never fails: an empty diff when git does.
 */
export async function reviewDiff(directory: string, options: { since?: string; baseRef?: string } = {}, git: Git = defaultGit): Promise<string> {
  return cut(await repoDiff(directory, options, git, ""));
}
const cut = (text: string) => (text.length > diffLimit ? `${text.slice(0, diffLimit)}\n[diff truncated at 64 KiB]` : text);

/** One repository's part of the review diff; `prefix` (`name/`, or empty) goes before every path it shows. */
async function repoDiff(directory: string, options: { since?: string; baseRef?: string }, git: Git, prefix: string): Promise<string> {
  const run = (args: string[]) => git(directory, args).catch(() => "");
  const shown = prefixArgs(prefix);
  const { since } = options;
  let text: string;
  if (since && shaPattern.test(since)) text = `# Changes since the previous delivery (git diff ${since})\n${(await run(["diff", since, "--no-color", ...shown])) || "(none)\n"}`;
  else {
    const base = await changeBase(directory, options.baseRef, git);
    if (base) text = `# Changes on this card's branch (git diff ${base})\n${(await run(["diff", base, "--no-color", ...shown])) || "(none)\n"}`;
    else {
      const [uncommitted, recent] = await Promise.all([run(["diff", "HEAD", "--no-color", ...shown]), run(["log", "-5", "-p", "--no-color", ...shown, "--format=commit %h %s"])]);
      text = `# Uncommitted changes (git diff HEAD)\n${uncommitted || "(none)\n"}\n# Recent commits\n${recent}`;
    }
  }
  const added = await untrackedFiles(directory, git).catch(() => []);
  if (added.length) {
    text += "\n# New files (untracked)\n";
    for (const file of added) {
      if (text.length > diffLimit) break;
      text += (await readable(join(directory, file))) ? await newFileDiff(directory, file, git, shown) : `new file ${prefix}${file} (over 1 MiB or unreadable, not shown)\n`;
    }
  }
  return text;
}

/** A Git repository inside a workspace directory that is not one itself (a linked root, GUARDRAILS-SPEC §6.2). */
export type LinkedRepo = { name: string; directory: string };
const linkedRepoLimit = 20;
/**
 * The repositories a review reads when the workspace directory is not a Git repository (a linked root or a common
 * folder, §6.2): every non-hidden child, link or folder, that holds `.git`, by name, at most 20. Empty when none.
 */
export async function linkedRepos(directory: string): Promise<LinkedRepo[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const repos: LinkedRepo[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    const path = join(directory, entry.name);
    if (await fileExists(join(path, ".git"))) repos.push({ name: entry.name, directory: path });
    if (repos.length >= linkedRepoLimit) break;
  }
  return repos;
}

/**
 * The review diff of a linked root (§6.2): each repository's part, as `reviewDiff` takes it, under its own heading and
 * with its paths under the repository's name, cut to an equal share of the 64 KiB so one large change cannot hide the
 * other repositories; `since` holds each repository's commit of the previous delivery.
 */
export async function linkedReviewDiff(repos: readonly LinkedRepo[], options: { since?: Readonly<Record<string, string>>; baseRef?: string } = {}, git: Git = defaultGit): Promise<string> {
  const share = Math.floor(diffLimit / Math.max(1, repos.length)) - 200;
  const parts: string[] = [];
  for (const repo of repos) {
    const part = await repoDiff(repo.directory, { since: options.since?.[repo.name], baseRef: options.baseRef }, git, `${repo.name}/`);
    const shown = part.length > share ? `${part.slice(0, share)}\n[${repo.name}: diff truncated]\n` : part;
    parts.push(`## Repository ${repo.name} (its paths start with ${repo.name}/)\n${shown}`);
  }
  return cut(parts.join("\n"));
}

/**
 * HEAD of a linked root (§6.2): each repository's commit by name, and one 12-character digest of them as the review's
 * `sha`, so the fingerprint notices a commit in any of them; dirty when any is. null head when git fails in all.
 */
export async function linkedHead(repos: readonly LinkedRepo[], git: Git, now = new Date().toISOString()): Promise<{ head: GitHead | null; repos: Record<string, string> }> {
  const heads = await Promise.all(repos.map((r) => readHead(r.directory, git, now)));
  const shas: Record<string, string> = {};
  let dirty = false;
  heads.forEach((h, i) => {
    if (!h?.sha) return;
    shas[repos[i]!.name] = h.sha;
    dirty ||= h.dirty;
  });
  const names = Object.keys(shas).sort();
  if (!names.length) return { head: null, repos: shas };
  const sha = createHash("sha1").update(names.map((n) => `${n} ${shas[n]}`).join("\n")).digest("hex").slice(0, 12);
  return { head: { sha, dirty, at: now }, repos: shas };
}

/** Changed files and lines from `git --numstat` lines; a binary file counts 0 lines. */
export function numstatShape(...outputs: string[]): { shape: ChangeShape; paths: Set<string> } {
  const paths = new Set<string>();
  let lines = 0;
  for (const output of outputs)
    for (const line of output.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
      if (!m) continue;
      lines += (m[1] === "-" ? 0 : Number(m[1])) + (m[2] === "-" ? 0 : Number(m[2]));
      paths.add(renamedTo(m[3]));
    }
  return { shape: { files: paths.size, lines, size: sizeOf(lines) }, paths };
}
/** `a => b` and `dir/{a => b}/f` are the renamed file's new path. */
function renamedTo(path: string) {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/\//g, "/");
  const plain = /^(.*) => (.*)$/.exec(path);
  return plain ? plain[2] : path;
}

/**
 * The delivery's shape (GUARDRAILS-SPEC §6.2): a worktree card's `git diff <merge-base> --numstat`, otherwise
 * `git diff HEAD --numstat` plus the same last five commits the review's diff reads; untracked new files count too,
 * one file each with their lines. null when git fails.
 */
export async function reviewShape(directory: string, baseRef?: string, git: Git = defaultGit, prefix = ""): Promise<{ shape: ChangeShape; paths: Set<string> } | null> {
  try {
    const base = await changeBase(directory, baseRef, git);
    const tracked = base
      ? [git(directory, ["diff", base, "--numstat"])]
      : [git(directory, ["diff", "HEAD", "--numstat"]), git(directory, ["log", "-5", "--numstat", "--format="])];
    const [outputs, added] = await Promise.all([Promise.all(tracked), untrackedFiles(directory, git)]);
    const { shape, paths } = numstatShape(...outputs);
    let lines = shape.lines;
    for (const file of added) {
      if (paths.has(file)) continue;
      paths.add(file);
      lines += await fileLines(join(directory, file));
    }
    return { shape: { files: paths.size, lines, size: sizeOf(lines) }, paths: prefix ? new Set([...paths].map((p) => `${prefix}${p}`)) : paths };
  } catch {
    return null;
  }
}

/** A linked root's shape (§6.2): the sum of its repositories', paths under each repository's name; null when git fails in all. */
export async function linkedShape(repos: readonly LinkedRepo[], baseRef?: string, git: Git = defaultGit): Promise<{ shape: ChangeShape; paths: Set<string> } | null> {
  const parts = (await Promise.all(repos.map((r) => reviewShape(r.directory, baseRef, git, `${r.name}/`)))).filter((p) => p !== null);
  if (!parts.length) return null;
  const paths = new Set(parts.flatMap((p) => [...p.paths]));
  const lines = parts.reduce((sum, p) => sum + p.shape.lines, 0);
  return { shape: { files: paths.size, lines, size: sizeOf(lines) }, paths };
}

/** A file the model cited, as a repository-relative path; null when it points outside the workspace. */
export function repoPath(directory: string, file: string): string | null {
  const trimmed = file.trim().replace(/^\.\//, "");
  if (!trimmed) return null;
  const full = resolve(directory, trimmed);
  const rel = relative(directory, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * The user's messages in the card's sessions (§4.2): the projected tail of each session in its workspace, Flowly's own
 * temporary sessions left out. null when Paseo could not list them; one unreadable session is skipped.
 */
export async function readConversation(task: Pick<Task, "workspaceId">, paseo: PaseoApi): Promise<string[] | null> {
  const ids: string[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200, cursor } });
      for (const { agent } of page.entries) if (agent.workspaceId === task.workspaceId && !isSummarizer(agent as { labels?: Record<string, string> | null })) ids.push(agent.id);
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
  } catch (e) {
    logFailure("Flowly auto review could not list the card's sessions:", e);
    return null;
  }
  const messages: { at: string; text: string }[] = [];
  for (const id of ids) {
    const res = await paseo.agents
      .ref(id)
      .timeline.refetch({ direction: "tail", limit: conversationLimits.perSession, projection: "projected" })
      .catch(() => null);
    for (const entry of (res?.entries || []) as { timestamp?: string; item?: { type?: unknown; text?: unknown } }[])
      if (entry.item?.type === "user_message" && typeof entry.item.text === "string") messages.push({ at: entry.timestamp || "", text: entry.item.text });
  }
  return conversationForReview(messages);
}

export type CheckRun = { exitCode: number | null; timedOut: boolean; spawnError?: string; ms: number; output: string };
/** Runs one check as an argument array in `cwd`, never through a shell. */
export type RunCheck = (argv: readonly string[], cwd: string, timeoutMs: number) => Promise<CheckRun>;

export const runCheck: RunCheck = (argv, cwd, timeoutMs) =>
  new Promise((resolve) => {
    const started = Date.now();
    let output = "",
      timedOut = false,
      settled = false;
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-autoReviewLimits.tail * 2);
    };
    // Its own process group, so a timeout also stops the test runner's workers.
    const group = process.platform !== "win32";
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      detached: group,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (group && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    const finish = (run: Omit<CheckRun, "ms" | "output" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...run, timedOut, ms: Date.now() - started, output });
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", (e) => finish({ exitCode: null, spawnError: e.message }));
    child.on("close", (code) => finish({ exitCode: code }));
  });

const packageRunners = new Set(["npm", "pnpm", "yarn", "bun", "npx", "pnpx", "bunx"]);
const npmScriptAliases: Record<string, string> = { test: "test", t: "test", tst: "test", start: "start", stop: "stop", restart: "restart" };
const makefiles = ["GNUmakefile", "makefile", "Makefile"];
const projectFiles: Record<string, string> = { go: "go.mod", cargo: "Cargo.toml" };
/**
 * Whether a project command belongs in this repository of a linked root (GUARDRAILS-SPEC §6.3): an npm, pnpm, yarn or
 * bun script when its `package.json` has that script (any other package command when it has a `package.json`); `make
 * <target>` when a makefile there names the target (bare `make` when it has one); `go` and `cargo` when `go.mod` /
 * `Cargo.toml` is there. Any other command runs in every repository.
 */
export async function commandApplies(argv: readonly string[], directory: string): Promise<boolean> {
  const [tool, ...args] = argv;
  const base = tool ? tool.split(/[\\/]/).pop()! : "";
  if (packageRunners.has(base)) {
    const pkg = await readFile(join(directory, "package.json"), "utf8").then(
      (t) => JSON.parse(t) as { scripts?: Record<string, unknown> },
      () => null,
    );
    if (!pkg) return false;
    const first = args.find((a) => !a.startsWith("-"));
    const script = first === "run" || first === "run-script" ? args[args.indexOf(first) + 1] : first && npmScriptAliases[first];
    return !script || typeof pkg.scripts?.[script] === "string";
  }
  if (base === "make") {
    const file = (await Promise.all(makefiles.map((m) => readFile(join(directory, m), "utf8").catch(() => null)))).find((t) => t !== null);
    if (file === undefined || file === null) return false;
    const targets = args.filter((a, i) => !a.startsWith("-") && !a.includes("=") && !["-C", "-f", "-j"].includes(args[i - 1] ?? ""));
    return targets.every((t) => new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`, "m").test(file));
  }
  if (projectFiles[base]) return fileExists(join(directory, projectFiles[base]));
  return true;
}

/**
 * The repositories of a linked root this delivery touched (§6.3): uncommitted or untracked changes, or a commit after
 * the card was created. All of them when none did; a repository git cannot read counts as touched.
 */
export async function changedRepos(repos: readonly LinkedRepo[], since: string | undefined, git: Git = defaultGit): Promise<LinkedRepo[]> {
  const after = since ? Date.parse(since) : NaN;
  const touched = await Promise.all(
    repos.map(async (repo) => {
      try {
        const [status, last] = await Promise.all([
          git(repo.directory, ["status", "--porcelain", "--untracked-files=normal"]),
          Number.isFinite(after) ? git(repo.directory, ["log", "-1", "--format=%ct"]) : Promise.resolve(""),
        ]);
        return status.trim() !== "" || Number(last.trim()) * 1000 > after;
      } catch {
        return true;
      }
    }),
  );
  const changed = repos.filter((_, i) => touched[i]);
  return changed.length ? changed : [...repos];
}

/**
 * Runs one project command in a linked root (§6.3): in each repository where it applies, in order, until one fails.
 * null when it applies in none. The failing run's output names its repository; the time is the sum; `ran` lists the
 * repositories it ran in, the failing one last.
 */
export async function runInRepos(run: RunCheck, argv: readonly string[], repos: readonly LinkedRepo[], timeoutMs: number): Promise<(CheckRun & { ran: string[] }) | null> {
  let ms = 0;
  const ran: string[] = [];
  for (const repo of repos) {
    if (!(await commandApplies(argv, repo.directory))) continue;
    ran.push(repo.name);
    const result = await run(argv, repo.directory, timeoutMs);
    ms += result.ms;
    if (result.exitCode !== 0 || result.timedOut || result.spawnError) return { ...result, ms, ran, output: `[${repo.name}]\n${result.output}` };
  }
  return ran.length ? { exitCode: 0, timedOut: false, ms, ran, output: "" } : null;
}

/** What a review reads of the project's guardrails (GUARDRAILS-SPEC §6.3) and reports back at its end (§6.6). */
export type ReviewGuardrails = {
  /**
   * The project's active and observing commands; with Guardrails on (B4) also the active guidelines in scope for this
   * shape and the card's open items, and the user's words for each by id.
   */
  reviewInput(task: Task, project: Project, size: ChangeShape["size"] | undefined): Promise<{ commands: GuardrailEntry[]; guidelines: GuardrailEntry[]; items: CardItem[]; words: Map<string, string> }>;
  /** The three signals and automatic retirement at the end of a review that judged something (§6.6, §6.7). */
  reviewed(input: { projectId: string; taskId: string; items: readonly ReviewItem[]; previous?: readonly ReviewItem[]; disputed: readonly string[] }): Promise<void>;
};

export type AutoReviewDeps = {
  /** The card workspace's directory and whether it is a worktree; null when Paseo has none. */
  workspace: (task: Task, paseo: PaseoApi) => Promise<{ directory: string; worktree: boolean } | null>;
  /** The session is in a turn now (running or starting). */
  sessionBusy: (agentId: string, paseo: PaseoApi) => Promise<boolean>;
  /** The delivering session still exists and is not archived. */
  sessionLive: (agentId: string, task: Task, paseo: PaseoApi) => Promise<boolean>;
  /** Queues a message for a session; it goes out when the session's turn ends (the composer queue). */
  send: (input: { taskId: string; agentId: string; text: string }, paseo: PaseoApi) => Promise<unknown>;
  /** Judges the built-in check, guidelines and card items in a temporary review session; absent makes them unavailable. */
  llm?: LlmReview;
  /** The project's guardrails; absent: only the built-in check runs. */
  guardrails?: ReviewGuardrails;
  /** The user's messages in the card's sessions (§4.2), for the built-in check; null when unreadable. */
  conversation?: (task: Task, paseo: PaseoApi) => Promise<string[] | null>;
  /** The diff the review session reads; `reviewDiff` by default. */
  diff?: (directory: string, since?: string, baseRef?: string) => Promise<string>;
  /** The delivery's shape; `reviewShape` by default. */
  shape?: (directory: string, baseRef?: string) => Promise<{ shape: ChangeShape; paths: Set<string> } | null>;
  /** Whether a cited file exists in the workspace (B1); a file check by default. */
  exists?: (path: string) => Promise<boolean>;
  run?: RunCheck;
  git?: Git;
  clock?: () => number;
};

const fileExists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The automatic review of agent deliveries (AUTO-REVIEW-SPEC, GUARDRAILS-SPEC §6): runs the project's commands in the
 * card workspace, then one review session judges the built-in check, the guidelines in scope and the card's own
 * items; a passed card stays in In review, a failed one goes back to rework (R1) or, past the limit, to Blocked (R2).
 * The review record lives on the task and never changes its revision.
 */
export class AutoReviewService {
  private chains = new Map<string, Promise<void>>();
  /** Deliveries waiting for their session's turn to end, by session. */
  private pending = new Map<string, DeliveredReview>();
  private readonly run: RunCheck;
  private readonly git: Git;
  private readonly clock: () => number;
  constructor(
    readonly store: BoardStore,
    readonly deps: AutoReviewDeps,
  ) {
    this.run = deps.run ?? runCheck;
    this.git = deps.git ?? defaultGit;
    this.clock = deps.clock ?? (() => Date.now());
  }

  /**
   * An agent delivered the card to In review; never throws. The review starts when that session's turn ends (§3.1):
   * whatever the agent still does in that turn (a commit, a workpad edit) would otherwise cancel it.
   */
  async delivered(delivery: DeliveredReview, paseo: PaseoApi) {
    // Recorded before the status check, so a turn ending meanwhile still finds it.
    this.pending.set(delivery.agentId, delivery);
    const busy = await this.deps.sessionBusy(delivery.agentId, paseo).catch(() => false);
    if (!busy) await this.turnEnded(delivery.agentId, paseo);
  }

  /** A session's turn ended: start the review of its delivery, if one waits. */
  turnEnded(agentId: string, paseo: PaseoApi) {
    const delivery = this.pending.get(agentId);
    if (!delivery) return Promise.resolve();
    this.pending.delete(agentId);
    return this.enqueue(delivery.projectId, delivery.taskId, () => this.review(delivery, false, paseo));
  }

  /** A person's Rerun from the drawer (§7): the card is in In review, round starts at 1. */
  async rerun(taskId: string, paseo: PaseoApi) {
    const board = await this.store.read();
    const task = board.tasks.find((t) => t.id === taskId);
    const project = task && board.projects.find((p) => p.id === task.projectId);
    if (!task || !project || task.archivedAt || project.archivedAt) throw new Error("Task is unavailable or archived.");
    if (task.status !== "in_review") throw new Error("Only a card in In review can be reviewed again.");
    if (!autoReviewRuns(project)) throw new Error("Turn on Auto review in the project settings first.");
    if (task.review?.state === "running") throw new Error("A review of this card is already running.");
    const delivery = latestDelivery(board, task);
    if (!delivery) throw new Error("No agent delivered this card to In review, so there is no session to send rework to.");
    void this.enqueue(project.id, task.id, () => this.review(delivery, true, paseo));
    return { ok: true as const };
  }

  /** At plugin start: a review that was running when Flowly stopped never finishes, so it becomes Unavailable (§3.2). */
  recover() {
    return this.store.transaction((b) => {
      let changed = false;
      for (const t of b.tasks) {
        if (t.review?.state !== "running") continue;
        const reason = "Flowly restarted during the review.";
        t.review = {
          ...t.review,
          state: "unavailable",
          reason,
          finishedAt: this.now(),
          items: t.review.items.map((r) => (r.state === "queued" || r.state === "running" ? { ...r, state: "unavailable" as const, reason } : r)),
        };
        this.store.event(b, { taskId: t.id, actor: "system", action: reviewFinishedAction, agentId: t.review.trigger.agentId, note: "Auto review unavailable: Flowly restarted during the review." });
        changed = true;
      }
      return { value: changed, changed };
    });
  }

  /** Waits for every queued review; for tests and shutdown. */
  async idle() {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }

  /** One review at a time per project: its cards may share a working directory. */
  private enqueue(key: string, taskId: string, job: () => Promise<void>) {
    const run = (this.chains.get(key) ?? Promise.resolve()).then(job).catch((e) => logFailure("Flowly auto review failed:", e, taskId));
    this.chains.set(key, run);
    void run.then(() => {
      if (this.chains.get(key) === run) this.chains.delete(key);
    });
    return run;
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }

  private async review(delivery: DeliveredReview, manual: boolean, paseo: PaseoApi) {
    const board = await this.store.read();
    const task = board.tasks.find((t) => t.id === delivery.taskId);
    const project = task && board.projects.find((p) => p.id === task.projectId);
    if (!task || !project || task.archivedAt || project.archivedAt || task.status !== "in_review" || !autoReviewRuns(project)) return;
    const where = await this.deps.workspace(task, paseo).catch(() => null);
    let head = where ? await readHead(where.directory, this.git, this.now()) : null;
    // A workspace that is not a Git repository itself reads the repositories in it (a linked root, §6.2).
    const linked = where && !head ? await linkedRepos(where.directory) : [];
    let repoShas: Record<string, string> | undefined;
    if (linked.length) ({ head, repos: repoShas } = await linkedHead(linked, this.git, this.now()));
    const measured = !where
      ? null
      : linked.length
        ? await linkedShape(linked, task.baseRef, this.git).catch(() => null)
        : await (this.deps.shape ?? ((d: string, base?: string) => reviewShape(d, base, this.git)))(where.directory, task.baseRef).catch(() => null);
    const config = autoReviewOf(project);
    // What is checked is fixed when it starts; editing the guardrails meanwhile does not change this review (§4.3).
    const guard = this.deps.guardrails
      ? await this.deps.guardrails.reviewInput(task, project, measured?.shape.size).catch((e) => {
          logFailure("Flowly auto review could not read the guardrails:", e, task.id);
          return null;
        })
      : null;
    const words = guard?.words ?? new Map<string, string>();
    const startedAt = this.now();
    const started = await this.store.transaction<{ previous?: Task["review"]; round: number } | null>((b) => {
      const t = b.tasks.find((x) => x.id === delivery.taskId);
      if (!t || t.archivedAt || t.status !== "in_review") return { value: null, changed: false };
      const previous = t.review;
      const round = !manual && continuesRound(b.events, t.id, previous) ? previous!.round + 1 : 1;
      const disputes = new Map((t.disputes || []).map((d) => [d.id, d.reason]));
      // A disputed finding is not checked again: it is recorded as disputed with the agent's reason (§6.3, B7).
      const queued = (id: string) =>
        disputes.has(id) ? { state: "disputed" as const, disputeReason: clip(disputes.get(id)!, 300) } : { state: "queued" as const };
      const items: ReviewItem[] = [
        ...(guard?.commands || []).map((c) => ({
          id: c.id,
          kind: "command" as const,
          name: clip(c.text, 200),
          // An observing command runs and shows its result but never decides the review (§4.5).
          gating: c.state === "active",
          argv: [...(c.argv || [])],
          ...queued(c.id),
        })),
        { id: GOAL_ID, kind: "goal" as const, name: GOAL_NAME, gating: true, ...queued(GOAL_ID) },
        ...(guard?.guidelines || []).map((g) => ({ id: g.id, kind: "guideline" as const, name: clip(g.text, 200), gating: true, ...queued(g.id) })),
        ...(guard?.items || []).map((i) => ({ id: i.id, kind: "item" as const, name: clip(i.text, 200), gating: true, ...queued(i.id) })),
      ].slice(0, 40);
      t.review = {
        trigger: { eventId: manual ? "" : delivery.eventId, agentId: delivery.agentId, from: delivery.from },
        round,
        maxRounds: config.maxRounds,
        state: "running",
        fingerprint: {
          taskRevision: t.revision,
          workpadRevision: b.workpads.find((w) => w.taskId === t.id)?.revision ?? 0,
          ...(head?.sha ? { sha: head.sha } : {}),
          ...(repoShas && Object.keys(repoShas).length ? { repos: repoShas } : {}),
          dirty: !!head?.dirty,
        },
        shared: !where?.worktree,
        ...(measured ? { shape: measured.shape } : {}),
        items,
        startedAt,
      };
      this.store.event(b, { taskId: t.id, actor: "system", action: reviewStartedAction, agentId: delivery.agentId, note: `Auto review started (round ${round})` });
      return { value: { previous, round }, changed: true };
    });
    if (!started) return;
    const items = (await this.current(delivery.taskId, startedAt))?.items ?? [];
    const set = (id: string, patch: Partial<ReviewItem>) => this.updateItems(delivery.taskId, startedAt, [id], patch);
    if (!where) {
      await this.updateItems(delivery.taskId, startedAt, items.filter((i) => i.state === "queued").map((i) => i.id), { state: "unavailable", reason: "The card's workspace directory is unavailable." });
    } else {
      // Every active and observing command runs, in list order; each result shows as soon as it is in (§6.3 step 1).
      const runIn = linked.length ? await changedRepos(linked, task.createdAt, this.git) : [];
      for (const item of items) {
        if (item.kind !== "command" || item.state !== "queued") continue;
        const entry = guard?.commands.find((c) => c.id === item.id);
        await set(item.id, { state: "running" });
        const timeout = (entry?.timeoutSec ?? defaultCheckTimeoutSec) * 1000;
        const run: (CheckRun & { ran?: string[] }) | null = linked.length ? await runInRepos(this.run, item.argv || [], runIn, timeout) : await this.run(item.argv || [], where.directory, timeout);
        if (!run) {
          await set(item.id, { state: "skipped", reason: runIn.length < linked.length ? "No repository this delivery changed has this command." : "No repository in this workspace has this command." });
          continue;
        }
        const tail = outputTail(run.output, autoReviewLimits.tail);
        const passed = run.exitCode === 0 && !run.timedOut && !run.spawnError;
        // A command that cannot start or times out is the review's problem, not the agent's (§3.2 Unavailable).
        const state = passed ? "passed" : run.spawnError || run.timedOut ? "unavailable" : "failed";
        await set(item.id, {
          state,
          exitCode: run.exitCode,
          ...(run.timedOut ? { timedOut: true } : {}),
          ms: Math.max(0, Math.round(run.ms)),
          ...(!passed && tail ? { tail } : {}),
          ...(run.ran ? { detail: `Ran in ${run.ran.join(", ")}.`.slice(0, autoReviewLimits.detail) } : {}),
          ...(run.spawnError ? { reason: `Could not start: ${run.spawnError}`.slice(0, autoReviewLimits.reason) } : {}),
          ...(run.timedOut ? { reason: `Timed out after ${timeout / 1000} s.` } : {}),
        });
      }
      await this.judge(delivery, startedAt, task, started.round > 1 && !manual ? started.previous : undefined, guard, where, linked, measured?.paths ?? new Set(), paseo);
    }
    const after = !where ? null : linked.length ? (await linkedHead(linked, this.git, this.now())).head : await readHead(where.directory, this.git, this.now());
    const outcome = await this.finish(delivery.taskId, startedAt, where ? after : undefined);
    if (!outcome) return;
    // The three signals and retirement (§6.6, §6.7); a failure here never changes the review.
    if (this.deps.guardrails)
      await this.deps.guardrails
        .reviewed({ projectId: outcome.task.projectId, taskId: outcome.task.id, items: outcome.review.items, previous: started.previous?.items, disputed: (outcome.task.disputes || []).map((d) => d.id) })
        .catch((e) => logFailure("Flowly guardrail counts not updated:", e, outcome.task.id));
    if (!outcome.rework) return;
    const live = await this.deps.sessionLive(outcome.review.trigger.agentId, outcome.task, paseo).catch(() => false);
    const sent = live
      ? await this.deps.send({ taskId: outcome.task.id, agentId: outcome.review.trigger.agentId, text: reworkMessage(outcome.review, words) }, paseo).then(
          () => true,
          (e) => {
            logFailure("Flowly auto review rework not sent:", e, outcome.task.id);
            return false;
          },
        )
      : false;
    if (!sent) await this.markUnavailable(delivery.taskId, startedAt, "The delivering session is no longer available, so the rework message was not sent.");
  }

  private async current(taskId: string, startedAt: string) {
    const review = (await this.store.read()).tasks.find((t) => t.id === taskId)?.review;
    return review?.startedAt === startedAt ? review : null;
  }

  /**
   * The review session (§6.3 step 2): one session judges the built-in check, the guidelines and the card's items,
   * only when every gating command passed (D9). A `fail` without evidence becomes `na` (B1). From round 2 it reads
   * only the changes since the previous delivery and the previous results.
   */
  private async judge(
    delivery: DeliveredReview,
    startedAt: string,
    task: Task,
    previous: Task["review"] | undefined,
    guard: Awaited<ReturnType<ReviewGuardrails["reviewInput"]>> | null,
    where: { directory: string; worktree: boolean },
    linked: readonly LinkedRepo[],
    diffFiles: ReadonlySet<string>,
    paseo: PaseoApi,
  ) {
    const now = await this.current(delivery.taskId, startedAt);
    if (!now) return;
    const judged = now.items.filter((i) => i.kind !== "command" && i.state === "queued");
    if (!judged.length) return;
    const ids = judged.map((i) => i.id);
    const gating = now.items.filter((i) => i.kind === "command" && i.gating);
    if (gating.some((r) => r.state === "failed")) {
      await this.updateItems(delivery.taskId, startedAt, ids, { state: "skipped", reason: "A command failed." });
      return;
    }
    if (gating.some((r) => r.state === "unavailable")) {
      await this.updateItems(delivery.taskId, startedAt, ids, { state: "skipped", reason: "A command could not run." });
      return;
    }
    if (!this.deps.llm) {
      await this.updateItems(delivery.taskId, startedAt, ids, { state: "unavailable", reason: "The review session is unavailable in this Flowly build." });
      return;
    }
    await this.updateItems(delivery.taskId, startedAt, ids, { state: "running" });
    const board = await this.store.read();
    const deliveryEvent = board.events.find((e) => e.id === delivery.eventId);
    const before = new Map((previous?.items || []).map((i) => [i.id, i]));
    const incremental = !!previous?.fingerprint.sha;
    const text = (i: ReviewItem) =>
      i.kind === "goal" ? goalPrompt : i.kind === "guideline" ? [guard?.guidelines.find((g) => g.id === i.id)?.text ?? i.name, guard?.guidelines.find((g) => g.id === i.id)?.body].filter(Boolean).join("\n") : i.name;
    const input: LlmReviewInput = {
      task: { id: task.id, title: task.title, description: task.description, type: task.type, workspaceId: task.workspaceId },
      checks: judged.map((i) => {
        const quote = guard?.words.get(i.id);
        const prior = incremental ? before.get(i.id) : undefined;
        return {
          id: i.id,
          kind: i.kind as JudgedCheck["kind"],
          text: text(i),
          ...(quote ? { quote } : {}),
          ...(prior ? { previous: { state: prior.state, ...(prior.detail ? { detail: prior.detail } : {}) } } : {}),
        };
      }),
      ...(ids.includes(GOAL_ID) ? { conversation: this.deps.conversation ? await this.deps.conversation(task, paseo).catch(() => null) : null } : {}),
      ...(where.worktree ? {} : { shared: true }),
      acceptance: board.workpads.find((w) => w.taskId === task.id)?.acceptance ?? [],
      deliveryNote: deliveryEvent?.note ?? "",
      outputs: board.artifacts.filter((a) => a.taskId === task.id && a.role === "output").map((a) => a.target),
      commands: now.items.filter((r) => r.kind === "command").map((r) => `${r.name}: ${r.state}${r.gating ? "" : " (observing)"}`),
      diff: linked.length
        ? await linkedReviewDiff(linked, { since: incremental ? previous!.fingerprint.repos : undefined, baseRef: task.baseRef }, this.git)
        : await (this.deps.diff ?? ((d: string, since?: string, baseRef?: string) => reviewDiff(d, { since, baseRef }, this.git)))(
            where.directory,
            incremental ? previous!.fingerprint.sha : undefined,
            task.baseRef,
          ),
      ...(incremental ? { incremental: true } : {}),
      parentAgentId: delivery.agentId,
    };
    const started = this.clock();
    let result: Awaited<ReturnType<LlmReview>>;
    try {
      result = await this.deps.llm(input, paseo);
    } catch (e) {
      const reason = `The review session failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, autoReviewLimits.reason);
      await this.updateItems(delivery.taskId, startedAt, ids, { state: "unavailable", reason });
      return;
    }
    const ms = Math.max(0, Math.round(this.clock() - started));
    // B1: a cited file outside the diff counts when it exists in the repository (a missing entry, say).
    const exists = this.deps.exists ?? fileExists;
    const verdicts = new Map<string, LlmVerdict & { file?: string }>();
    const existing = new Set<string>();
    for (const v of result.verdicts) {
      const file = v.file ? repoPath(where.directory, v.file) ?? undefined : undefined;
      verdicts.set(v.id, { ...v, ...(file ? { file } : { file: undefined }) });
      if (v.verdict === "fail" && file && !diffFiles.has(file) && (await exists(resolve(where.directory, file)))) existing.add(file);
    }
    await this.store.transaction((b) => {
      const t = b.tasks.find((x) => x.id === delivery.taskId);
      if (!t?.review || t.review.startedAt !== startedAt || t.review.state !== "running") return { value: null, changed: false };
      t.review = {
        ...t.review,
        model: result.model.slice(0, 200),
        items: t.review.items.map((r) => {
          if (!ids.includes(r.id)) return r;
          const v = verdicts.get(r.id);
          if (!v) {
            // Round ≥ 2 re-checks only what failed; a check that passed before and was not judged again keeps its pass.
            const prior = incremental ? before.get(r.id) : undefined;
            if (prior && itemPassed(prior)) return { ...r, state: prior.state, ms, ...(prior.detail ? { detail: prior.detail } : {}), reason: "Passed in the previous round; not judged again." };
            return { ...r, state: "unavailable" as const, ms, reason: "The review session gave no verdict for this check." };
          }
          const quoteSources = [task.title, task.description, ...(input.conversation ?? []), guard?.words.get(r.id)];
          const evidence = v.verdict !== "fail" || hasEvidence(v, diffFiles, existing, quoteSources);
          return {
            ...r,
            state: v.verdict === "pass" ? ("passed" as const) : v.verdict === "fail" && evidence ? ("failed" as const) : ("na" as const),
            ms,
            detail: v.detail.slice(0, autoReviewLimits.detail),
            ...(v.file ? { file: v.file.slice(0, 300) } : {}),
            ...(v.line ? { line: v.line } : {}),
            ...(v.quote ? { quote: clip(v.quote, 300) } : {}),
            ...(!evidence ? { reason: "no evidence" } : {}),
          };
        }),
      };
      return { value: null, changed: true };
    });
  }

  /** Writes item results of the running review; no task revision, so the fingerprint is untouched (§12.5). */
  private updateItems(taskId: string, startedAt: string, ids: readonly string[], patch: Partial<ReviewItem>) {
    if (!ids.length) return Promise.resolve(null);
    return this.store.transaction((b) => {
      const t = b.tasks.find((x) => x.id === taskId);
      if (!t?.review || t.review.startedAt !== startedAt || t.review.state !== "running") return { value: null, changed: false };
      t.review = { ...t.review, items: t.review.items.map((r) => (ids.includes(r.id) ? { ...r, ...patch } : r)) };
      return { value: null, changed: true };
    });
  }

  /**
   * Writes the result; a card that changed meanwhile drops it (§3.2 Cancelled). Returns the finished review (null when
   * cancelled or gone) and whether rework goes out.
   */
  private async finish(taskId: string, startedAt: string, after: GitHead | null | undefined) {
    return this.store.transaction<{ task: Task; review: NonNullable<Task["review"]>; rework: boolean } | null>((b) => {
      const t = b.tasks.find((x) => x.id === taskId);
      const project = t && b.projects.find((p) => p.id === t.projectId);
      const r = t?.review;
      if (!t || !project || !r || r.startedAt !== startedAt || r.state !== "running") return { value: null, changed: false };
      const finishedAt = this.now();
      const pad = b.workpads.find((w) => w.taskId === t.id);
      const changed =
        t.archivedAt ||
        t.status !== "in_review" ||
        t.revision !== r.fingerprint.taskRevision ||
        (pad?.revision ?? 0) !== r.fingerprint.workpadRevision ||
        (after !== undefined && ((after?.sha || undefined) !== r.fingerprint.sha || !!after?.dirty !== r.fingerprint.dirty));
      // Each item's result and kind go with the event, for Insights (§6.4, §7.5).
      const event = (note: string) =>
        this.store.event(b, { taskId: t.id, actor: "system", action: reviewFinishedAction, agentId: r.trigger.agentId, note, results: r.items.map((x) => ({ id: x.id, state: x.state, kind: x.kind, ...(x.gating ? {} : { gating: false as const }) })) });
      if (changed) {
        t.review = { ...r, state: "cancelled", reason: "The card, its workpad or its code changed during the review.", finishedAt };
        // No results: a cancelled review judged nothing.
        this.store.event(b, { taskId: t.id, actor: "system", action: reviewFinishedAction, agentId: r.trigger.agentId, note: "Auto review cancelled: the card changed during the review" });
        return { value: null, changed: true };
      }
      const verdict = reviewVerdict(r.items);
      const done = (review: NonNullable<Task["review"]>, rework = false) => ({ value: { task: { ...t, review }, review, rework }, changed: true });
      if (verdict === "passed") {
        t.review = { ...r, state: "passed", finishedAt };
        const n = r.items.filter((x) => x.gating).length;
        event(`Auto review passed (${n} check${n === 1 ? "" : "s"})`);
        return done(t.review);
      }
      if (verdict === "unavailable") {
        const unavailable = r.items.find((x) => x.gating && (x.state === "unavailable" || x.state === "queued" || x.state === "running"))!;
        const reason = `${unavailable.kind === "goal" ? GOAL_NAME : unavailable.name}: ${unavailable.reason || "could not run"}`.slice(0, autoReviewLimits.reason);
        t.review = { ...r, state: "unavailable", reason, finishedAt };
        event(`Auto review unavailable: ${reason}`);
        return done(t.review);
      }
      const findings = failureSummary(r);
      const move = (to: Task["status"], rule: string, note: string) => {
        t.status = to;
        t.revision++;
        t.updatedAt = finishedAt;
        this.store.event(b, { taskId: t.id, actor: "system", action: "status_changed", agentId: r.trigger.agentId, rule, from: "in_review", to, note });
      };
      // Status first, then the message (§3.2): the rework turn then starts on a work stage, so A1 leaves it alone.
      const stage = r.round - 1 < r.maxRounds ? reworkStage(b.events, t, project, r.trigger.from) : null;
      if (stage) {
        t.review = { ...r, state: "rework", finishedAt };
        event(`Auto review failed: ${findings}`);
        move(stage, reworkRule, `Auto review failed; back to rework (${r.round}/${r.maxRounds})`);
        return done(t.review, true);
      }
      t.review = { ...r, state: "failed", finishedAt };
      event(`Auto review failed: ${findings}`);
      if (laneEnabled(project, "blocked")) move("blocked", reviewFailedRule, `Auto review failed after ${r.round - 1} rework round${r.round - 1 === 1 ? "" : "s"}`);
      return done(t.review);
    });
  }

  private markUnavailable(taskId: string, startedAt: string, reason: string) {
    return this.store.transaction((b) => {
      const t = b.tasks.find((x) => x.id === taskId);
      if (!t?.review || t.review.startedAt !== startedAt) return { value: null, changed: false };
      t.review = { ...t.review, state: "unavailable", reason, finishedAt: t.review.finishedAt ?? this.now() };
      this.store.event(b, { taskId, actor: "system", action: reviewFinishedAction, agentId: t.review.trigger.agentId, note: `Auto review unavailable: ${reason}` });
      return { value: null, changed: true };
    });
  }
}

/** The latest agent delivery of the card to In review, for a person's Rerun. */
function latestDelivery(board: Board, task: Task): DeliveredReview | null {
  for (let i = board.events.length - 1; i >= 0; i--) {
    const e = board.events[i];
    if (e.taskId === task.id && e.action === "status_changed" && e.to === "in_review" && e.actor === "agent" && e.agentId && e.from)
      return { taskId: task.id, projectId: task.projectId, eventId: e.id, agentId: e.agentId, from: e.from };
  }
  if (task.review) return { taskId: task.id, projectId: task.projectId, eventId: task.review.trigger.eventId, agentId: task.review.trigger.agentId, from: task.review.trigger.from };
  return null;
}
