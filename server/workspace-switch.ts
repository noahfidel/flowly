import type { PaseoApi } from "@getpaseo/client";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { BoardStore } from "./store";
import type { Board, Project, Task } from "../shared/model";
import { switchLimits } from "../shared/model";
import type { ReleaseCheck, SwitchCheck, SwitchCompare } from "../shared/rpc";
import { isSummarizer, truncateTranscript, turnText } from "../shared/summary";
import type { SummaryEntry } from "../shared/summary";
import { folderOf, handoverPrompt } from "../shared/workspace-switch";
import { putArtifact } from "./artifacts";
import { generatedBranchName } from "./service";
import { ToolError } from "./tool-error";
import {
  applyCopyBack,
  applyRelease,
  changedPaths,
  checkCopyBack,
  checkedOutBranch,
  checkRelease,
  commitsNotIn,
  copySnapshot,
  GitStepError,
  headCommit,
  integrate,
  isGitRoot,
  operationInProgress,
  overwriteFiles,
  recentCommits,
  releasePatch,
  snapshot,
  uncommittedCount,
  undoRelease,
  type CopyBackCheck,
  type Snapshot,
} from "./workspace-git";

/** Untracked files above this block a switch, above the warning size they warn (§3.2). */
export const COPY_LIMIT_BYTES = 500 * 1024 * 1024;
export const COPY_WARN_BYTES = 50 * 1024 * 1024;
const TRANSCRIPT_BYTES = 2 * 1024 * 1024;
/** Folder rows of the Switch to local overview (§9.1); the totals still count every file. */
const COMPARE_ROWS = 300;
const HINT_SESSIONS = 20;

type Session = { id: string; title: string; status: string; updatedAt: string; archived: boolean };
/** A worktree's uncommitted changes against its HEAD, and what Copy would do with each file (§9). */
type Kept = { patch: Buffer; head: string; apply: string[]; present: string[]; conflicts: string[] };

const finished = (status: string) => status === "done" || status === "cancelled";
const running = (s: Session) => !s.archived && (s.status === "running" || s.status === "initializing");
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex").slice(0, 24);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const withFiles = (message: string, files: string[]) => (files.length ? `${message} (${files.slice(0, 8).join(", ")}${files.length > 8 ? ", …" : ""})` : message);

/** Sessions of a workspace (summarizer children left out); archived ones only when asked. */
export async function workspaceSessions(paseo: PaseoApi, workspaceId: string, includeArchived = false): Promise<Session[]> {
  const sessions: Session[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({ filter: { includeArchived }, page: { limit: 200, cursor } });
    for (const { agent } of page.entries)
      if (agent.workspaceId === workspaceId && !isSummarizer(agent))
        sessions.push({ id: agent.id, title: agent.title || agent.id.slice(0, 8), status: agent.status, updatedAt: agent.updatedAt, archived: !!agent.archivedAt });
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return sessions;
}

type TimelineItem = { type: string; text?: unknown; name?: unknown; message?: unknown; detail?: unknown };

/** A session's timeline: its plain dialogue and the files its edit/write calls named. */
async function sessionRecord(paseo: PaseoApi, agentId: string, limit = 0) {
  const response = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit, projection: "canonical" });
  const items = (response.entries || []).map((e) => e.item as unknown as TimelineItem);
  const files = new Set<string>();
  let lastAssistant = "";
  for (const item of items) {
    const detail = item.detail as { type?: unknown; filePath?: unknown } | undefined;
    if (item.type === "tool_call" && (detail?.type === "edit" || detail?.type === "write") && typeof detail.filePath === "string") files.add(detail.filePath);
    if (item.type === "assistant_message" && typeof item.text === "string" && item.text.trim()) lastAssistant = item.text.trim();
  }
  return { text: turnText(items), files: [...files], lastAssistant };
}

/** A path relative to the repository root, or null outside it. */
function inRepo(root: string, path: string) {
  const rel = relative(root, isAbsolute(path) ? path : resolve(root, path));
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split("\\").join("/") : null;
}

export type SwitchDeps = {
  /** The card's latest summary (TASK-SUMMARY-SPEC), for the handoff. */
  latestSummary?: (taskId: string) => Promise<SummaryEntry | null>;
};

/**
 * Switching a card between the main checkout and its own worktree
 * (WORKSPACE-SWITCH-SPEC): preflight and run in both directions, the handover
 * request, the release from the main checkout and its undo, and the git part of
 * flowly_integrate. Switch, release, undo and integrate run one at a time per project.
 */
export class WorkspaceSwitchService {
  constructor(
    readonly store: BoardStore,
    /** Plugin data folder; release backups go to `releases/` (§5.2). */
    readonly dataDirectory: string,
    readonly deps: SwitchDeps = {},
  ) {}

  private chains = new Map<string, Promise<unknown>>();
  private serialize<T>(projectId: string, job: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(projectId) || Promise.resolve()).then(job, job);
    this.chains.set(projectId, run.catch(() => undefined));
    return run;
  }

  private async card(id: string, board?: Board): Promise<{ task: Task; project: Project; board: Board }> {
    const b = board || (await this.store.read());
    const task = b.tasks.find((t) => t.id === id);
    const project = b.projects.find((p) => p.id === task?.projectId);
    if (!task || !project) throw new Error("Card not found.");
    return { task, project, board: b };
  }

  /** Files that live sessions of other cards edited in the main checkout (a hint, §3.4, §5.1). */
  private async otherCardsFiles(paseo: PaseoApi, board: Board, task: Task, project: Project): Promise<Map<string, string>> {
    const owners = new Map<string, string>();
    for (const other of board.tasks)
      if (other.projectId === project.id && other.id !== task.id && !other.archivedAt) owners.set(other.workspaceId, other.title);
    const byFile = new Map<string, string>();
    const sessions: { id: string; card: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, cursor } });
      for (const { agent } of page.entries)
        if (agent.workspaceId && owners.has(agent.workspaceId) && !isSummarizer(agent) && resolve(agent.cwd) === resolve(project.primaryPath))
          sessions.push({ id: agent.id, card: owners.get(agent.workspaceId)! });
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    for (const s of sessions.slice(0, HINT_SESSIONS)) {
      const record = await sessionRecord(paseo, s.id, 2000).catch(() => null);
      for (const file of record?.files || []) {
        const rel = inRepo(project.primaryPath, file);
        if (rel && !byFile.has(rel)) byFile.set(rel, s.card);
      }
    }
    return byFile;
  }

  async check(input: { id: string; direction: "to_worktree" | "to_local" }, paseo: PaseoApi): Promise<SwitchCheck & { snapshot?: Snapshot; kept?: Kept }> {
    const { task, project } = await this.card(input.id);
    const blockers: string[] = [],
      warnings: string[] = [];
    if (task.archivedAt || project.archivedAt) blockers.push("The card or its project is archived.");
    if (finished(task.status)) blockers.push("The card is finished (Done or Cancelled).");
    const workspace = await paseo.workspaces.ref(task.workspaceId).refresh().catch(() => null);
    if (!workspace || workspace.archivingAt) blockers.push("The card's workspace is unavailable or archived.");
    const kind = workspace?.workspaceKind || "unknown";
    const sessions = workspace ? await workspaceSessions(paseo, task.workspaceId) : [];
    const live = sessions.filter((s) => !s.archived);
    const busy = live.filter(running).length;
    if (busy) blockers.push(`${busy} session${busy === 1 ? " is" : "s are"} still running. Stop or wait for ${busy === 1 ? "it" : "them"} first.`);
    const owned = !!workspace && (task.ownsWorkspace ?? (workspace.title || workspace.name || "").trim() === task.title.trim());
    const root = project.primaryPath;
    const gitRoot = await isGitRoot(root);
    const mainBranch = gitRoot ? await checkedOutBranch(root) : null;
    let base: string | null = null;
    let copy: SwitchCheck["copy"] = null;
    let snap: Snapshot | undefined;
    let worktree: SwitchCheck["worktree"] = null;
    let compare: SwitchCompare | null = null;
    let kept: Kept | undefined;
    if (input.direction === "to_worktree") {
      if (kind === "worktree") blockers.push("The card already works in a worktree.");
      if (project.links?.length) blockers.push("A linked multi-repo project can't switch a card to a worktree.");
      if (!gitRoot) blockers.push("The project root is not a Git repository.");
      else if (!mainBranch) blockers.push("The main checkout has a detached HEAD.");
      if (gitRoot) {
        const busyOp = await operationInProgress(root);
        if (busyOp) blockers.push(`The main checkout is in the middle of a ${busyOp}.`);
        snap = await snapshot(root);
        base = snap.base;
        copy = {
          tracked: snap.tracked.length,
          untracked: snap.untracked.length,
          bytes: snap.untrackedBytes,
          files: [...snap.tracked, ...snap.untracked].slice(0, 200),
        };
        if (snap.untrackedBytes > COPY_LIMIT_BYTES) blockers.push("The untracked files to copy are larger than 500 MB.");
        else if (snap.untrackedBytes > COPY_WARN_BYTES) warnings.push(`The untracked files to copy are ${Math.round(snap.untrackedBytes / 1048576)} MB.`);
        if (snap.submodules.length) warnings.push(withFiles("Submodule changes are not copied", snap.submodules));
      }
      const lastTurn = live.reduce((max, s) => (s.updatedAt > max ? s.updatedAt : max), "");
      if (!task.handover) warnings.push("No handover yet: the next session works out this card's changes from the transcripts.");
      else if (lastTurn && lastTurn > task.handover.at) warnings.push("The handover is older than the card's last session turn.");
      const others = await this.othersRunning(paseo, task, project).catch(() => 0);
      if (others) warnings.push(`Sessions of other cards are running in the main checkout: changes they write after the switch are not copied.`);
    } else {
      if (kind !== "worktree") blockers.push("The card already works in the main checkout.");
      else if (workspace?.workspaceDirectory) {
        const dir = workspace.workspaceDirectory;
        const branch = (await checkedOutBranch(dir)) || "";
        const head = await headCommit(dir);
        const files = await changedPaths(dir).catch(() => new Set<string>());
        const uncommitted = files.size;
        const notIntegrated = branch && mainBranch ? await commitsNotIn(root, branch, mainBranch).catch(() => 0) : 0;
        let copyBack: NonNullable<SwitchCheck["worktree"]>["copyBack"] = null;
        let copy: CopyBackCheck | null = null;
        // Uncommitted changes (staged, unstaged, untracked) need the user's choice:
        // copy, overwrite or discard them; a patch is kept either way (§9).
        if (uncommitted && gitRoot) {
          const patch = await releasePatch(dir, "HEAD");
          copy = await checkCopyBack(root, patch);
          kept = { patch, head, apply: copy.apply, present: copy.present, conflicts: copy.conflicts };
          copyBack = { files: copy.apply.length, present: copy.present.length, conflicts: copy.conflicts, busy: copy.busy };
        }
        worktree = { branch, uncommitted, notIntegrated, copyBack };
        if (gitRoot) compare = await this.compare(root, dir, { branch, head, mainBranch }, files, copy).catch(() => null);
        if (notIntegrated)
          warnings.push(`${notIntegrated} commit${notIntegrated === 1 ? "" : "s"} on ${branch} ${notIntegrated === 1 ? "is" : "are"} not in ${mainBranch}. They stay on the branch; integrate first (flowly_integrate) to bring them into the main checkout.`);
      }
      if (!gitRoot) blockers.push("The project root is not a Git repository.");
      if (task.switch?.release === "pending") warnings.push("The main checkout still holds this card's copied changes; nothing is removed.");
    }
    const handoverSession = task.handover ? sessions.find((s) => s.id === task.handover!.agentId)?.title || task.handover.agentId.slice(0, 8) : "";
    return {
      taskId: task.id,
      revision: task.revision,
      direction: input.direction,
      workspace: workspace ? { id: task.workspaceId, kind, directory: workspace.workspaceDirectory || "" } : null,
      archiveWorkspace: kind === "worktree" || owned,
      sessions: live.length,
      idleSessions: live.filter((s) => s.status === "idle").map((s) => ({ id: s.id, title: s.title })),
      mainBranch,
      base,
      branchName: generatedBranchName(task.title, `${task.id}:${task.revision}`),
      copy,
      handover: task.handover ? { at: task.handover.at, files: task.handover.files.length, session: handoverSession } : null,
      worktree,
      compare,
      blockers,
      warnings,
      ...(snap ? { snapshot: snap } : {}),
      ...(kept ? { kept } : {}),
    };
  }

  /** The worktree and the main checkout side by side for Switch to local (§9.1): branches, last commits, changes per folder. */
  private async compare(
    root: string,
    dir: string,
    at: { branch: string; head: string; mainBranch: string | null },
    worktreeFiles: Set<string>,
    copy: CopyBackCheck | null,
  ): Promise<SwitchCompare> {
    const mainFiles = await changedPaths(root);
    const outcome = new Map<string, "apply" | "present" | "conflicts">();
    for (const path of copy?.apply || []) outcome.set(path, "apply");
    for (const path of copy?.present || []) outcome.set(path, "present");
    for (const path of copy?.conflicts || []) outcome.set(path, "conflicts");
    const paths = new Set([...worktreeFiles, ...mainFiles]);
    const folders = new Map<string, SwitchCompare["folders"][number]>();
    for (const path of paths) {
      const key = folderOf(path);
      const folder = folders.get(key) ?? { path: key, worktree: 0, main: 0, apply: 0, present: 0, conflicts: 0 };
      if (worktreeFiles.has(path)) folder.worktree++;
      if (mainFiles.has(path)) folder.main++;
      const result = outcome.get(path);
      if (result) folder[result]++;
      folders.set(key, folder);
    }
    const rank = (f: SwitchCompare["folders"][number]) => (f.conflicts ? 0 : f.worktree && f.main ? 1 : f.worktree ? 2 : 3);
    const rows = [...folders.values()].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
    const mainRef = at.mainBranch || "HEAD";
    const side = async (cwd: string, label: string, ref: string, other: string) => ({
      branch: label,
      notInOther: await commitsNotIn(root, ref, other).catch(() => 0),
      commits: await recentCommits(cwd, ref).catch(() => []),
    });
    return {
      worktree: await side(dir, at.branch || at.head.slice(0, 7), at.branch || at.head, mainRef),
      main: await side(root, mainRef, mainRef, at.branch || at.head),
      folders: rows.slice(0, COMPARE_ROWS),
      totals: {
        worktree: worktreeFiles.size,
        main: mainFiles.size,
        both: [...worktreeFiles].filter((path) => mainFiles.has(path)).length,
        files: paths.size,
        folders: rows.length,
      },
    };
  }

  private async othersRunning(paseo: PaseoApi, task: Task, project: Project) {
    const board = await this.store.read();
    const others = new Set(board.tasks.filter((t) => t.projectId === project.id && t.id !== task.id && !t.archivedAt).map((t) => t.workspaceId));
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, cursor } });
      for (const { agent } of page.entries)
        if (agent.workspaceId && others.has(agent.workspaceId) && (agent.status === "running" || agent.status === "initializing") && resolve(agent.cwd) === resolve(project.primaryPath))
          count++;
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return count;
  }

  /** Sends the fixed handover prompt to an idle session of the card (§2.2). */
  async askHandover(input: { id: string; agentId: string }, paseo: PaseoApi) {
    const { task } = await this.card(input.id);
    const agent = await paseo.agents.ref(input.agentId).refresh().catch(() => null);
    if (!agent?.agent || agent.agent.workspaceId !== task.workspaceId || agent.agent.archivedAt) throw new Error("This session does not belong to the card.");
    if (agent.agent.status !== "idle") throw new Error("This session is busy; ask again when it is idle.");
    await paseo.agents.ref(input.agentId).send(handoverPrompt);
    return { sent: true };
  }

  async run(
    input: {
      id: string;
      revision: number;
      operationId: string;
      direction: "to_worktree" | "to_local";
      branchName?: string;
      uncommitted?: "copy" | "overwrite" | "discard";
    },
    paseo: PaseoApi,
  ) {
    const { project } = await this.card(input.id);
    return this.serialize(project.id, async () => {
      const { task: current } = await this.card(input.id);
      if (current.switch?.id === input.operationId)
        return { workspaceId: current.workspaceId, directory: "", branch: current.switch.branch ?? null, copied: 0, warnings: [] };
      const check = await this.check({ id: input.id, direction: input.direction }, paseo);
      if (check.revision !== input.revision) throw new Error("Revision conflict: this card changed. Review the switch again.");
      if (check.blockers.length) throw new Error(`Cannot switch: ${check.blockers.join(" ")}`);
      const copyBack = check.worktree?.copyBack;
      if (input.direction === "to_local" && copyBack) {
        if (!input.uncommitted) throw new Error("The worktree has uncommitted changes: choose whether to copy, overwrite or discard them.");
        if (input.uncommitted !== "discard" && copyBack.busy) throw new Error(`Cannot copy: the main checkout is in the middle of a ${copyBack.busy}.`);
        if (input.uncommitted === "copy" && copyBack.conflicts.length)
          throw new Error(withFiles("Cannot copy: these changes don't apply cleanly to the main checkout; choose Overwrite or Discard", copyBack.conflicts));
      }
      return input.direction === "to_worktree" ? this.toWorktree(input, check, paseo) : this.toLocal(input, check, paseo);
    });
  }

  private async toWorktree(
    input: { id: string; revision: number; operationId: string; branchName?: string },
    check: SwitchCheck & { snapshot?: Snapshot },
    paseo: PaseoApi,
  ) {
    const { task, project, board } = await this.card(input.id);
    const root = project.primaryPath;
    const snap = check.snapshot!;
    const mainBranch = check.mainBranch!;
    const branchName = input.branchName?.trim() || check.branchName;
    const exported = await this.exportSessions(paseo, task, project, board);
    const created = await paseo.workspaces.create({
      title: task.title,
      idempotencyKey: `flowly-switch:${input.operationId}`,
      source: { kind: "worktree", cwd: root, projectId: project.paseoProjectId, action: "branch-off", refName: `refs/heads/${mainBranch}`, branchName },
    });
    const directory = (await paseo.workspaces.ref(created.id).refresh())?.workspaceDirectory;
    if (!directory) throw new Error(`Card was not moved. Workspace ${created.id} was created but has no folder yet; retry.`);
    try {
      await copySnapshot(snap, root, directory);
    } catch (e) {
      throw new Error(`Card was not moved. Workspace ${created.id} remains available. ${errorText(e)}`);
    }
    const folder = join(".flowly", "handoff", input.operationId);
    await this.writeHandoff(directory, folder, {
      title: `${task.title}: moved to worktree ${branchName}`,
      lines: [
        `From: the main checkout ${root} (${check.workspace?.kind || "local"}), branch ${mainBranch}`,
        `To: worktree ${directory}, branch ${branchName}, started at ${snap.base}`,
        "",
        "The worktree holds a copy of ALL uncommitted changes of the main checkout, not only this card's. Before anything else: keep exactly this card's changes (the handover below), revert everything else in the worktree, change nothing in this card's own lines, then ask the user to press Release from main on the card. The release removes exactly what the worktree holds from the main checkout; lines you edit first no longer match and the release is refused for them.",
      ],
      handover: task.handover,
      copied: [...snap.tracked.map((f) => `M ${f}`), ...snap.untracked.map((f) => `A ${f}`)],
      ...exported,
      summary: await this.deps.latestSummary?.(task.id).catch(() => null),
      patch: snap.diff,
      untracked: snap.untracked,
    });
    const target = `./${folder.split("\\").join("/")}/handoff.md`;
    const now = new Date().toISOString();
    await this.store.mutate((b) => {
      const t = b.tasks.find((x) => x.id === task.id);
      if (!t) throw new Error(`Card was not moved: it was deleted. Workspace ${created.id} remains available.`);
      if (t.revision !== input.revision) throw new Error(`Card was not moved: it changed meanwhile. Workspace ${created.id} remains available; switch again.`);
      t.previousWorkspaces = [
        ...(t.previousWorkspaces || []),
        { id: t.workspaceId, kind: check.workspace?.kind || "directory", directory: check.workspace?.directory || root, switchedAt: now },
      ].slice(-switchLimits.previousWorkspaces);
      t.workspaceId = created.id;
      t.ownsWorkspace = true;
      t.switch = {
        id: input.operationId,
        at: now,
        direction: "to_worktree",
        base: snap.base,
        mainBranch,
        branch: branchName,
        release: snap.diff.length || snap.untracked.length ? "pending" : "none",
      };
      t.revision++;
      t.updatedAt = now;
      this.store.event(b, {
        taskId: t.id,
        actor: "human",
        action: "workspace_switched",
        note: `${check.workspace?.kind || "local"} → worktree ${branchName}, ${snap.tracked.length + snap.untracked.length} files copied`,
      });
      putArtifact(this.store, b, { taskId: t.id, role: "input", kind: "file", target, title: "Handoff", note: "Read first: what moved, the handover, and how to trim this worktree.", createdBy: "human" }, now);
    });
    const warnings = await this.archiveOld(paseo, check);
    return { workspaceId: created.id, directory, branch: branchName, copied: snap.tracked.length + snap.untracked.length, warnings };
  }

  private async toLocal(
    input: { id: string; revision: number; operationId: string; uncommitted?: "copy" | "overwrite" | "discard" },
    check: SwitchCheck & { kept?: Kept },
    paseo: PaseoApi,
  ) {
    const { task, project, board } = await this.card(input.id);
    const root = project.primaryPath;
    const folder = join(".flowly", "handoff", task.id, input.operationId);
    const branch = check.worktree?.branch || "";
    const keptName = "worktree-uncommitted.patch";
    // Uncommitted worktree changes (§9): saved as a patch against the worktree's
    // HEAD before anything moves, then copied (or copied and overwritten) to the
    // main checkout when chosen.
    const kept = check.kept;
    const choice = kept ? input.uncommitted : undefined;
    const copy = kept && (choice === "copy" || choice === "overwrite") ? kept.apply : [];
    const overwrite = kept && choice === "overwrite" ? kept.conflicts : [];
    const backupName = "main-before";
    let added: string[] = [];
    if (kept) {
      await this.handoffFolder(root, folder);
      await writeFile(join(root, folder, keptName), kept.patch);
      await mkdir(join(this.dataDirectory, "releases"), { recursive: true });
      await writeFile(this.backup(task.id, `${input.operationId}-uncommitted`), kept.patch);
    }
    try {
      await applyCopyBack(root, kept?.patch ?? Buffer.alloc(0), copy);
      if (overwrite.length)
        added = await overwriteFiles(root, check.workspace?.directory || "", overwrite, [
          join(root, folder, backupName),
          join(this.dataDirectory, "releases", `${task.id}-${input.operationId.replace(/[^\w.-]/g, "_")}-${backupName}`),
        ]);
    } catch (e) {
      throw new Error(`Card was not moved. ${e instanceof GitStepError ? withFiles(e.message, e.files) : errorText(e)}`);
    }
    const uncommitted = check.worktree?.uncommitted ?? 0;
    const had = kept ? `The worktree had ${uncommitted} uncommitted change(s) (staged, unstaged and untracked) on top of ${kept.head}.` : "";
    const copied = kept ? `${copy.length} file(s) were applied to its working tree as unstaged changes${kept.present.length ? `, ${kept.present.length} file(s) were already there` : ""}` : "";
    const keptLines = !kept
      ? []
      : choice === "copy"
        ? ["", `${had} The user chose to copy them to the main checkout: ${copied}. A patch of all of them is saved in ${keptName} next to this file.`, ...copy.map((f) => `- ${f}`)]
        : choice === "overwrite"
          ? [
              "",
              `${had} The user chose to overwrite: ${copied}; ${overwrite.length} file(s) the main checkout had changed too were replaced by the worktree's version. The main checkout's versions of those files are saved in ${backupName}/ next to this file${added.length ? ` (${added.length} did not exist there)` : ""}. A patch of all worktree changes is saved in ${keptName}.`,
              "",
              "Overwritten:",
              ...overwrite.map((f) => `- ${f}`),
              "",
              "Copied:",
              ...copy.map((f) => `- ${f}`),
            ]
          : [
              "",
              `${had} The user chose to discard them; they are saved in ${keptName} next to this file and were not applied to the main checkout. To restore them, run \`git apply ${keptName}\` in a checkout of ${branch || "the branch"} at that commit; apply them here only when the user asks.`,
            ];
    const exported = await this.exportSessions(paseo, task, project, board);
    const created = await paseo.workspaces.create({
      title: task.title,
      idempotencyKey: `flowly-switch:${input.operationId}`,
      source: { kind: "directory", path: root, projectId: project.paseoProjectId },
    });
    await this.writeHandoff(root, folder, {
      title: `${task.title}: moved back to the main checkout`,
      lines: [
        `From: worktree ${check.workspace?.directory || ""}, branch ${branch}`,
        `To: the main checkout ${root}${check.mainBranch ? `, branch ${check.mainBranch}` : ""}`,
        "",
        check.worktree?.notIntegrated
          ? `${check.worktree.notIntegrated} commit(s) on ${branch} are not in ${check.mainBranch}. They stay on the branch; integrate them only when the user asks.`
          : `The branch ${branch} is kept.`,
        ...keptLines,
      ],
      handover: task.handover,
      copied: [],
      ...exported,
      summary: await this.deps.latestSummary?.(task.id).catch(() => null),
    });
    const target = `./${folder.split("\\").join("/")}/handoff.md`;
    const now = new Date().toISOString();
    await this.store.mutate((b) => {
      const t = b.tasks.find((x) => x.id === task.id);
      if (!t) throw new Error(`Card was not moved: it was deleted. Workspace ${created.id} remains available.`);
      if (t.revision !== input.revision) throw new Error(`Card was not moved: it changed meanwhile. Workspace ${created.id} remains available; switch again.`);
      t.previousWorkspaces = [
        ...(t.previousWorkspaces || []),
        { id: t.workspaceId, kind: "worktree", directory: check.workspace?.directory || "", ...(branch ? { branch } : {}), switchedAt: now },
      ].slice(-switchLimits.previousWorkspaces);
      t.workspaceId = created.id;
      t.ownsWorkspace = true;
      t.switch = { id: input.operationId, at: now, direction: "to_local", ...(branch ? { branch } : {}), ...(check.mainBranch ? { mainBranch: check.mainBranch } : {}), release: "none" };
      t.revision++;
      t.updatedAt = now;
      this.store.event(b, {
        taskId: t.id,
        actor: "human",
        action: "workspace_switched",
        note: `worktree ${branch} → main checkout${
          !kept
            ? ""
            : choice === "copy"
              ? `, ${copy.length} file${copy.length === 1 ? "" : "s"} with uncommitted changes copied to the main checkout`
              : choice === "overwrite"
                ? `, ${copy.length} file${copy.length === 1 ? "" : "s"} copied and ${overwrite.length} overwritten in the main checkout (backup in the handoff folder)`
                : `, ${uncommitted} uncommitted change${uncommitted === 1 ? "" : "s"} discarded (saved as a patch)`
        }`,
      });
      putArtifact(this.store, b, { taskId: t.id, role: "input", kind: "file", target, title: "Handoff", note: "Read first: what moved and where the earlier branch is.", createdBy: "human" }, now);
    });
    const warnings = await this.archiveOld(paseo, check);
    return { workspaceId: created.id, directory: root, branch: null, copied: copy.length + overwrite.length, warnings };
  }

  /** Archives the card's old workspace, or only the card's sessions when it does not own it (§3.3 step 8). */
  private async archiveOld(paseo: PaseoApi, check: SwitchCheck): Promise<string[]> {
    if (!check.workspace) return [];
    const failures: string[] = [];
    if (check.archiveWorkspace) {
      const result = await paseo.workspaces
        .archive(check.workspace.id)
        .catch((e: unknown) => ({ error: errorText(e), archivedAt: null }));
      if (result.error || !result.archivedAt) failures.push(`The old workspace was not archived (${result.error || "no reason given"}); archive it in Paseo.`);
    } else
      for (const session of await workspaceSessions(paseo, check.workspace.id).catch(() => []))
        if (!session.archived)
          await paseo.agents
            .ref(session.id)
            .archive()
            .catch((e: unknown) => failures.push(`Session ${session.title} was not archived (${errorText(e)}); archive it in Paseo.`));
    return failures;
  }

  /** The old sessions' conversations and file hints for the handoff folder (§3.3 step 3, §3.4). */
  private async exportSessions(paseo: PaseoApi, task: Task, project: Project, board: Board) {
    const sessions = await workspaceSessions(paseo, task.workspaceId, true).catch(() => []);
    const transcripts: { id: string; title: string; text: string; last: string }[] = [];
    const edited = new Set<string>();
    for (const s of sessions) {
      const record = await sessionRecord(paseo, s.id).catch(() => null);
      if (!record) continue;
      for (const f of record.files) {
        const rel = inRepo(project.primaryPath, f);
        if (rel) edited.add(rel);
      }
      transcripts.push({ id: s.id, title: s.title, text: truncateTranscript(record.text, TRANSCRIPT_BYTES, TRANSCRIPT_BYTES / 4), last: record.lastAssistant });
    }
    const others = await this.otherCardsFiles(paseo, board, task, project).catch(() => new Map<string, string>());
    return { transcripts, edited: [...edited], others };
  }

  /** Creates a handoff folder under `.flowly/`, which git ignores (§3.3 step 6). */
  private async handoffFolder(directory: string, folder: string) {
    await mkdir(join(directory, folder), { recursive: true });
    const ignore = join(directory, ".flowly", ".gitignore");
    if (!existsSync(ignore)) await writeFile(ignore, "*\n");
  }

  private async writeHandoff(
    directory: string,
    folder: string,
    content: {
      title: string;
      lines: string[];
      handover?: Task["handover"];
      copied: string[];
      transcripts: { id: string; title: string; text: string; last: string }[];
      edited: string[];
      others: Map<string, string>;
      summary?: SummaryEntry | null;
      patch?: Buffer;
      untracked?: string[];
    },
  ) {
    await this.handoffFolder(directory, folder);
    await mkdir(join(directory, folder, "sessions"), { recursive: true });
    const section = (title: string, body: string[]) => [`## ${title}`, "", ...(body.length ? body : ["(none)"]), ""];
    const md = [
      `# ${content.title}`,
      "",
      ...content.lines,
      "",
      ...section(
        "Handover (this card's changes, written by its session)",
        content.handover
          ? [`Written ${content.handover.at} by session ${content.handover.agentId}.`, "", ...content.handover.files.map((f) => `- ${f}`), "", content.handover.notes]
          : ["No handover was written. Work out this card's changes from the transcripts below and ask the user when unsure."],
      ),
      ...section("Copied from the main checkout", content.copied.map((f) => `- ${f}`)),
      ...section("Files this card's sessions edited with edit/write tools (hint; script edits are not listed)", content.edited.map((f) => `- ${f}`)),
      ...section("Files other cards' sessions edited in the main checkout (hint)", [...content.others].map(([f, card]) => `- ${f} (${card})`)),
      ...section(
        "Latest card summary",
        content.summary ? [`State: ${content.summary.state}`, `Recap: ${content.summary.recap}`, `Next: ${content.summary.next}`] : [],
      ),
      ...section(
        "Earlier sessions",
        content.transcripts.map((t) => `- ${t.title} (sessions/${t.id}.md)${t.last ? `: last message "${t.last.slice(0, 300).replace(/\s+/g, " ")}"` : ""}`),
      ),
    ].join("\n");
    await writeFile(join(directory, folder, "handoff.md"), md);
    for (const t of content.transcripts) await writeFile(join(directory, folder, "sessions", `${t.id}.md`), `# ${t.title}\n\n${t.text}\n`);
    if (content.patch) await writeFile(join(directory, folder, "snapshot.patch"), content.patch);
    if (content.untracked) await writeFile(join(directory, folder, "untracked.txt"), content.untracked.join("\n") + "\n");
  }

  /** The release patch and its checks, for both the preflight and the run (§5). */
  private async releaseState(id: string, paseo: PaseoApi) {
    const { task, project, board } = await this.card(id);
    const blockers: string[] = [],
      warnings: string[] = [];
    const s = task.switch;
    if (!s || s.direction !== "to_worktree" || s.release !== "pending" || !s.base) {
      blockers.push("Nothing to release for this card.");
      return { task, project, patch: Buffer.alloc(0), staged: [] as string[], files: [], blockers, warnings };
    }
    const workspace = await paseo.workspaces.ref(task.workspaceId).refresh().catch(() => null);
    if (!workspace?.workspaceDirectory) {
      blockers.push("The card's worktree is unavailable.");
      return { task, project, patch: Buffer.alloc(0), staged: [] as string[], files: [], blockers, warnings };
    }
    const busy = (await workspaceSessions(paseo, task.workspaceId)).filter(running).length;
    if (busy) blockers.push(`${busy} session${busy === 1 ? " is" : "s are"} still running and may be editing these files. Wait for ${busy === 1 ? "it" : "them"} first.`);
    const patch = await releasePatch(workspace.workspaceDirectory, s.base);
    const result = await checkRelease(project.primaryPath, patch);
    for (const b of result.blockers) blockers.push(withFiles(b.message, b.files));
    if (!patch.length) warnings.push("The worktree holds no changes: nothing will be removed from the main checkout.");
    const paths = result.files.map((f) => f.path);
    if (task.handover) {
      const listed = new Set(task.handover.files);
      const extra = paths.filter((p) => !listed.has(p));
      const missing = task.handover.files.filter((f) => !paths.includes(f));
      if (extra.length) warnings.push(withFiles("Files in the release that the handover does not list", extra));
      if (missing.length) warnings.push(withFiles("Handover files that are not in the release", missing));
    }
    const others = await this.otherCardsFiles(paseo, board, task, project).catch(() => new Map<string, string>());
    const shared = paths.filter((p) => others.has(p));
    if (shared.length) warnings.push(withFiles("Files that sessions of other cards edited", shared.map((p) => `${p}: ${others.get(p)}`)));
    return { task, project, patch, staged: result.staged, files: result.files, blockers, warnings };
  }

  async releaseCheck(id: string, paseo: PaseoApi): Promise<ReleaseCheck> {
    const state = await this.releaseState(id, paseo);
    return {
      taskId: state.task.id,
      revision: state.task.revision,
      files: state.files,
      patchHash: hash(state.patch),
      blockers: state.blockers,
      warnings: state.warnings,
    };
  }

  private backup(taskId: string, switchId: string) {
    return join(this.dataDirectory, "releases", `${taskId}-${switchId.replace(/[^\w.-]/g, "_")}.patch`);
  }

  async release(input: { id: string; revision: number; operationId: string; patchHash: string; acknowledgeWarnings: boolean }, paseo: PaseoApi) {
    const { project } = await this.card(input.id);
    return this.serialize(project.id, async () => {
      const state = await this.releaseState(input.id, paseo);
      if (state.task.revision !== input.revision) throw new Error("Revision conflict: this card changed. Review the release again.");
      if (state.blockers.length) throw new Error(`Cannot release: ${state.blockers.join(" ")}`);
      if (hash(state.patch) !== input.patchHash) throw new Error("The worktree's changes changed since you reviewed them. Review the release again.");
      if (state.warnings.length && !input.acknowledgeWarnings) throw new Error(`Confirm the warnings first: ${state.warnings.join(" ")}`);
      const s = state.task.switch!;
      const workspace = await paseo.workspaces.ref(state.task.workspaceId).refresh();
      const folder = join(workspace!.workspaceDirectory!, ".flowly", "handoff", s.id);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "released.patch"), state.patch);
      await mkdir(join(this.dataDirectory, "releases"), { recursive: true });
      await writeFile(this.backup(state.task.id, s.id), state.patch);
      try {
        await applyRelease(project.primaryPath, state.patch, state.staged);
      } catch (e) {
        throw new Error(e instanceof GitStepError ? withFiles(e.message, e.files) : errorText(e));
      }
      const now = new Date().toISOString();
      await this.store.mutate((b) => {
        const t = b.tasks.find((x) => x.id === input.id);
        if (!t?.switch) return;
        t.switch = { ...t.switch, release: "released", releasedAt: now };
        t.revision++;
        t.updatedAt = now;
        this.store.event(b, { taskId: t.id, actor: "human", action: "changes_released", note: `${state.files.length} file${state.files.length === 1 ? "" : "s"}` });
      });
      return { files: state.files.length };
    });
  }

  async releaseUndo(input: { id: string; revision: number; operationId: string }) {
    const { task, project } = await this.card(input.id);
    return this.serialize(project.id, async () => {
      const { task: current } = await this.card(input.id);
      const s = current.switch;
      if (current.revision !== input.revision) throw new Error("Revision conflict: this card changed. Try again.");
      if (!s || s.release !== "released") throw new Error("Nothing to undo: no release is recorded for this card.");
      if (s.integratedAt) throw new Error("The card's branch was already integrated; the release can no longer be undone.");
      const patch = await readFile(this.backup(task.id, s.id)).catch(() => {
        throw new Error("The release backup is missing.");
      });
      try {
        await undoRelease(project.primaryPath, patch);
      } catch (e) {
        throw new Error(e instanceof GitStepError ? withFiles(e.message, e.files) : errorText(e));
      }
      const files = patch.length ? (patch.toString().match(/^diff --git /gm) || []).length : 0;
      await this.store.mutate((b) => {
        const t = b.tasks.find((x) => x.id === input.id);
        if (!t?.switch) return;
        const { releasedAt: _released, ...rest } = t.switch;
        t.switch = { ...rest, release: "pending" };
        t.revision++;
        t.updatedAt = new Date().toISOString();
        this.store.event(b, { taskId: t.id, actor: "human", action: "release_undone", note: `${files} file${files === 1 ? "" : "s"}` });
      });
      return { files };
    });
  }

  /**
   * The git part of flowly_integrate (§6): the card's branch (or `ref`) into
   * the main checkout. The agent then sets `integrated` itself.
   */
  async integrateCard(input: { taskId: string; agentId: string; workspaceDirectory: string; workspaceKind: string; ref?: string }) {
    const { task, project } = await this.card(input.taskId);
    if (task.switch?.direction === "to_worktree" && task.switch.release === "pending")
      throw new ToolError("RELEASE_PENDING", "The main checkout still holds a copy of this card's changes. Ask the user to press Release from main on the card first.");
    if (input.workspaceKind !== "worktree") throw new ToolError("NOT_WORKTREE", "This card does not work in a worktree; commit in the main checkout instead.");
    const ref = input.ref?.trim() || (await checkedOutBranch(input.workspaceDirectory));
    if (!ref) throw new ToolError("DETACHED_HEAD", "The worktree has a detached HEAD; pass ref.");
    return this.serialize(project.id, async () => {
      let result;
      try {
        result = await integrate(project.primaryPath, ref);
      } catch (e) {
        if (e instanceof GitStepError) throw new ToolError(e.code, withFiles(e.message, e.files), e.code === "GIT_BUSY");
        throw e;
      }
      const uncommitted = await uncommittedCount(input.workspaceDirectory).catch(() => 0);
      if (result.commits)
        await this.store.mutate((b) => {
          const t = b.tasks.find((x) => x.id === task.id);
          if (!t) return;
          if (t.switch) t.switch = { ...t.switch, integratedAt: new Date().toISOString() };
          this.store.event(b, {
            taskId: t.id,
            actor: "agent",
            agentId: input.agentId,
            action: "branch_integrated",
            note: `${result.commits} commit${result.commits === 1 ? "" : "s"} of ${ref} → ${result.to.slice(0, 7)}`,
          });
        });
      return { ...result, ref, uncommitted };
    });
  }
}

