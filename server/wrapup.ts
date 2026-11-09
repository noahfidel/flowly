import type { PaseoApi } from "@getpaseo/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BoardStore } from "./store";
import type { WrapupCheck, WrapupResult } from "../shared/rpc";
import { isSummarizer } from "../shared/summary";

const execute = promisify(execFile);
type Git = (cwd: string, args: string[]) => Promise<string>;
const defaultGit: Git = async (cwd, args) =>
  (await execute("git", ["-C", cwd, ...args], { timeout: 10000, maxBuffer: 1 << 20 })).stdout;

/**
 * The card workspace's user-facing sessions. The plugin's own short-lived
 * summarizer children are left out: they are archived when they finish, and
 * wrap-up waits for them first (`settle`), so they never block it.
 */
async function workspaceSessions(paseo: PaseoApi, workspaceId: string) {
  const sessions: { id: string; status: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({
      filter: { includeArchived: false, includeBackground: true },
      page: { limit: 200, cursor },
    });
    for (const { agent } of page.entries)
      if (agent.workspaceId === workspaceId && !agent.archivedAt && !isSummarizer(agent))
        sessions.push({ id: agent.id, status: agent.status });
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return sessions;
}

/** Explicit, user-confirmed cleanup of a finished card's Paseo resources. */
export class WrapupService {
  constructor(
    readonly store: BoardStore,
    readonly git: Git = defaultGit,
    /** Resolves once the card's in-flight summary run has finished. */
    readonly settle: (taskId: string) => Promise<void> = async () => undefined,
  ) {}

  /**
   * `delete` is the preflight for archiving before a permanent delete
   * (TASK-DELETE-SPEC): any lane, archived cards too.
   */
  async check(id: string, paseo: PaseoApi, purpose: "wrapup" | "delete" = "wrapup"): Promise<WrapupCheck> {
    const board = await this.store.read();
    const task = board.tasks.find((t) => t.id === id);
    if (!task) throw new Error("Task not found.");
    const blockers: string[] = [],
      warnings: string[] = [];
    if (purpose === "wrapup") {
      if (task.archivedAt) blockers.push("Card is already archived.");
      if (task.status !== "done" && task.status !== "cancelled")
        blockers.push("Only Done or Cancelled cards can be wrapped up.");
    }
    const workspace = await paseo.workspaces.ref(task.workspaceId).refresh();
    const kind = workspace?.workspaceKind ?? null;
    const directory = workspace?.workspaceDirectory ?? null;
    if (workspace?.archivingAt) blockers.push("Workspace is being archived.");
    const sessions = workspace
      ? await workspaceSessions(paseo, task.workspaceId)
      : [];
    const active = sessions.filter(
      (s) => s.status === "running" || s.status === "initializing",
    ).length;
    if (active)
      blockers.push(
        `${active} session${active === 1 ? " is" : "s are"} still running. Stop or wait for ${active === 1 ? "it" : "them"} first.`,
      );
    // Cards linked to an existing workspace (e.g. the project's main one) never
    // archive it unless it is a worktree. Older cards lack the flag; the plugin
    // titled the workspaces it created after the card.
    const owned =
      !!workspace &&
      (task.ownsWorkspace ??
        (workspace.title || workspace.name || "").trim() === task.title.trim());
    let git: WrapupCheck["git"] = null;
    if (kind === "worktree" && directory) {
      try {
        const [branch, status] = await Promise.all([
          this.git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]),
          this.git(directory, ["status", "--porcelain"]),
        ]);
        // Commits reachable from no other local branch or remote, e.g. not yet
        // merged into main and not pushed. Merged work is not reported.
        const unpushed = await this.git(directory, [
          "rev-list", "--count", "HEAD", "--not",
          `--exclude=${branch.trim()}`, "--branches", "--remotes",
        ]);
        git = {
          branch: branch.trim(),
          uncommitted: status.split("\n").filter((line) => line.trim()).length,
          unpushed: Number.parseInt(unpushed.trim(), 10) || 0,
        };
        if (git.uncommitted)
          warnings.push(
            `${git.uncommitted} uncommitted change${git.uncommitted === 1 ? "" : "s"} in the worktree will be lost if Paseo removes it.`,
          );
        if (git.unpushed)
          warnings.push(
            `${git.unpushed} commit${git.unpushed === 1 ? "" : "s"} exist${git.unpushed === 1 ? "s" : ""} only on ${git.branch} (not merged or pushed elsewhere). The branch is kept.`,
          );
      } catch {
        warnings.push("Git status of the worktree could not be read.");
      }
    }
    return {
      taskId: task.id,
      revision: task.revision,
      workspace: workspace
        ? { id: task.workspaceId, kind: kind || "unknown", directory: directory || "" }
        : null,
      archiveWorkspace: kind === "worktree" || owned,
      sessions: sessions.length,
      git,
      blockers,
      warnings,
    };
  }

  async run(
    input: { id: string; revision: number; acknowledgeWarnings: boolean; keepCard?: boolean; purpose?: "wrapup" | "delete" },
    paseo: PaseoApi,
  ): Promise<WrapupResult> {
    await this.settle(input.id).catch(() => undefined);
    const check = await this.check(input.id, paseo, input.purpose);
    if (check.revision !== input.revision)
      throw new Error("Revision conflict: this card changed. Review the wrap-up again.");
    if (check.blockers.length)
      throw new Error(`Cannot ${input.purpose === "delete" ? "archive" : "wrap up"}: ${check.blockers.join(" ")}`);
    if (check.warnings.length && !input.acknowledgeWarnings)
      throw new Error(`Confirm the warnings first: ${check.warnings.join(" ")}`);
    let archivedSessions = 0,
      archivedWorkspace = false;
    const failures: string[] = [];
    if (check.workspace) {
      if (check.archiveWorkspace) {
        const result = await paseo.workspaces
          .archive(check.workspace.id)
          .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e), archivedAt: null }));
        if (result.error || !result.archivedAt)
          failures.push(`Workspace: ${result.error || "not archived"}`);
        else {
          archivedWorkspace = true;
          archivedSessions = check.sessions;
        }
      } else {
        for (const session of await workspaceSessions(paseo, check.workspace.id)) {
          try {
            await paseo.agents.ref(session.id).archive();
            archivedSessions++;
          } catch (e) {
            failures.push(`Session ${session.id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
    if (failures.length)
      throw new Error(
        `${input.purpose === "delete" ? "Archive incomplete; the card was not deleted." : "Wrap-up incomplete; the card was not archived."} ${archivedSessions} session(s) archived. Failed: ${failures.join("; ")}. Retry to continue.`,
      );
    const note = [
      `${archivedSessions} session(s) archived`,
      archivedWorkspace ? "workspace archived" : "workspace kept",
      ...(check.warnings.length ? [`acknowledged: ${check.warnings.join(" ")}`] : []),
    ].join("; ");
    if (input.keepCard) {
      await this.store.mutate((board) => {
        if (board.tasks.some((t) => t.id === input.id))
          this.store.event(board, { taskId: input.id, actor: "human", action: "wrapped_up", note: `${note}; card kept` });
      });
      return { archivedSessions, archivedWorkspace, note };
    }
    await this.store.mutate((board) => {
      const task = board.tasks.find((t) => t.id === input.id);
      if (!task) throw new Error("Task not found.");
      if (task.revision !== input.revision)
        throw new Error("Revision conflict: this card changed during wrap-up. Resources were archived; archive the card manually.");
      const now = new Date().toISOString();
      task.archivedAt = now;
      task.revision++;
      task.updatedAt = now;
      this.store.event(board, {
        taskId: task.id,
        actor: "human",
        action: "wrapped_up",
        note,
      });
    });
    return { archivedSessions, archivedWorkspace, note };
  }

  /**
   * Runs after a human moves a card to Done or Cancelled with auto wrap-up on: archives the card's own workspace
   * (and with it its sessions) when the wrap-up preflight is fully clean. The
   * card itself stays on the board; anything else is left for manual Wrap up.
   */
  async autoArchive(id: string, paseo: PaseoApi): Promise<void> {
    const pending = this.autoRuns.get(id);
    if (pending) return pending;
    const run = this.autoArchiveOnce(id, paseo).finally(() => this.autoRuns.delete(id));
    this.autoRuns.set(id, run);
    return run;
  }

  private readonly autoRuns = new Map<string, Promise<void>>();

  private async autoArchiveOnce(id: string, paseo: PaseoApi) {
    const record = (action: string, note: string) =>
      this.store.mutate((board) => {
        if (board.tasks.some((t) => t.id === id))
          this.store.event(board, { taskId: id, actor: "system", action, note });
      });
    // A turn that just ended starts a summary run in this workspace; archiving
    // the workspace now would cut it off.
    await this.settle(id).catch(() => undefined);
    let check: WrapupCheck;
    try {
      check = await this.check(id, paseo);
    } catch (e) {
      await record("workspace_auto_archive_skipped", `Preflight failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!check.workspace) return;
    const reasons = [...check.blockers, ...check.warnings];
    if (!check.archiveWorkspace)
      reasons.push("The workspace is not owned by this card.");
    if (reasons.length) {
      await record("workspace_auto_archive_skipped", `${reasons.join(" ")} Use Wrap up when ready.`);
      return;
    }
    const current = (await this.store.read()).tasks.find((t) => t.id === id);
    if (!current || current.archivedAt || (current.status !== "done" && current.status !== "cancelled") || current.revision !== check.revision) return;
    const result = await paseo.workspaces
      .archive(check.workspace.id)
      .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e), archivedAt: null }));
    if (result.error || !result.archivedAt)
      await record("workspace_auto_archive_skipped", `Archiving failed: ${result.error || "not archived"}. Use Wrap up to retry.`);
    else
      await record(
        "workspace_auto_archived",
        `${check.workspace.kind === "worktree" ? "Worktree" : "Workspace"} and ${check.sessions} session(s) archived; the directory ${check.workspace.kind === "worktree" ? "may be removed by Paseo, the branch is kept" : "stays on disk"}.`,
      );
  }
}
