import { laneName, laneProblem } from "../shared/lanes";
import { linkContextLines, linksOf } from "../shared/links";
import { artifactContextLines, artifactsOf } from "../shared/artifacts";
import { addLink } from "./links";
import { putArtifact } from "./artifacts";
import type { ConnectorService } from "./connectors/service";
import type { PaseoApi } from "@getpaseo/client";
import { cpSync, existsSync, renameSync, rmSync } from "node:fs";
import { lstat, mkdir, readlink, realpath, rmdir, stat, symlink, unlink } from "node:fs/promises";
import { basename, join, relative, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BoardStore } from "./store";
import { checkGroup } from "./tool-error";
import { readSnapshot, SnapshotInvalidError, type ProjectSnapshot } from "./project-folder";
import { linkLimits } from "../shared/model";
import type { ProjectInput, TaskInput, Board, LinkedProjectInput, ProjectLinksEdit, Project, ProjectRemoval } from "../shared/model";
import { groupOfProject } from "../shared/groups";
import { effectiveRepos, sessionContext } from "../shared/scope";
import type { DeliveryMode } from "../shared/delivery-mode";
import { setupContextLine, setupMissing } from "../shared/card-setup";
import { linearTicketLines } from "../shared/linear-ticket";
import { isPrReviewCard } from "../shared/pr-review";
import { workpadEnabled, workpadOf } from "../shared/workpad";
import { normalizeTags } from "../shared/tags";
import { tagLimits } from "../shared/model";
import { repoMatcher } from "./repos";
import { memoryContext } from "./memory";
import type { z } from "zod";
import type { removeProject as removeProjectRpc, restoreProjectCheck as restoreProjectCheckRpc } from "../shared/rpc";
import { logFailure } from "./error-report";
import { ToolError } from "./tool-error";
import { runPaseo } from "./paseo-cli";
import { columnEnd } from "../shared/group-order";

const execute = promisify(execFile);
type RemoveResult = z.infer<typeof removeProjectRpc.output>;
type RestoreCheck = z.infer<typeof restoreProjectCheckRpc.output>;
export async function resolveWorktreeBaseRef(
  sourcePath: string,
  requested: string,
): Promise<string> {
  const explicit = requested.trim();
  if (explicit && explicit !== "HEAD") return explicit;
  try {
    const { stdout } = await execute(
      "git",
      ["-C", sourcePath, "symbolic-ref", "--quiet", "HEAD"],
      { timeout: 10000 },
    );
    const branch = stdout.trim();
    if (!branch.startsWith("refs/heads/")) throw new Error("No named branch");
    return branch;
  } catch {
    throw new Error(
      "Cannot determine the selected repository's current named branch. Enter a valid base ref (such as main or origin/main); detached HEAD and non-Git directories have no automatic branch.",
    );
  }
}
export const paseoHome = () =>
  process.env.PASEO_HOME || resolve(homedir(), ".paseo");
/**
 * Branch for a worktree card created without an explicit name. Derived from the
 * operation ID (not Math.random) so a retried create reuses the same branch and
 * idempotency key instead of provisioning a second worktree.
 */
export function generatedBranchName(title: string, operationId: string) {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const suffix = createHash("sha256").update(operationId).digest("hex").slice(0, 6);
  return `kanban/${slug || "task"}-${suffix}`;
}
export const PLUGIN_ID = "flowly";
/** Plugin id before the rename to match the product name. */
export const LEGACY_PLUGIN_ID = "paseo-ultra-kanban";
export const dataDirectory = () =>
  process.env.FLOWLY_DATA_DIR ||
  process.env.ULTRA_KANBAN_DATA_DIR ||
  resolve(paseoHome(), "plugin-data", PLUGIN_ID);

/**
 * One-time, non-destructive carry-over of data and host settings stored under
 * the legacy plugin id. Copies into a temp sibling then renames, so a crash
 * never leaves a half-copied directory; the legacy directories are left intact.
 */
export function migrateLegacyPluginData(home = paseoHome()) {
  const moved: string[] = [];
  for (const area of ["plugin-data", "plugin-settings"]) {
    const from = resolve(home, area, LEGACY_PLUGIN_ID);
    const to = resolve(home, area, PLUGIN_ID);
    if (!existsSync(from) || existsSync(to)) continue;
    const tmp = `${to}.migrating`;
    rmSync(tmp, { recursive: true, force: true });
    cpSync(from, tmp, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    renameSync(tmp, to);
    moved.push(area);
  }
  return moved;
}
/** Fixed parent of plugin-created linked multi-repo project roots (PROJECT-PICKER-SPEC). */
export const linkedDirectory = () =>
  process.env.FLOWLY_LINKED_DIR || process.env.ULTRA_KANBAN_LINKED_DIR || resolve(dataDirectory(), "projects");
/** Folder/link name: letters, digits, `-`, `_`, `.`; never empty, hidden or a path. */
export function folderName(text: string, fallback = "project") {
  const name = text
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 60)
    .replace(/[-.]+$/, "");
  return name || fallback;
}
function uniqueName(base: string, taken: Set<string>) {
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}-${i}`;
  taken.add(name.toLowerCase());
  return name;
}
const inside = (parent: string, child: string) => {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
/** Canonical, distinct link targets outside the linked-project parent. */
async function linkTargets(paths: string[]) {
  const parent = await realpath(linkedDirectory()).catch(() => resolve(linkedDirectory()));
  const targets: string[] = [];
  for (const path of paths) {
    const target = await directory(path).catch(() => {
      throw new Error(`Not an existing directory: ${path}`);
    });
    if (inside(parent, target) || inside(target, parent))
      throw new Error(`Cannot link a directory inside or containing the linked projects folder: ${target}`);
    if (targets.includes(target)) throw new Error(`Directory added twice: ${target}`);
    targets.push(target);
  }
  return targets;
}
export async function directory(path: string): Promise<string> {
  const expanded = path.startsWith("~/")
    ? resolve(homedir(), path.slice(2))
    : path;
  // A missing path is the caller's mistake (a typed or stale folder), answered like a file is.
  const canonical = await realpath(resolve(expanded)).catch((e: NodeJS.ErrnoException) => {
    throw e.code === "ENOENT" || e.code === "ENOTDIR" ? new Error("Expected an existing directory.") : e;
  });
  if (!(await stat(canonical)).isDirectory())
    throw new Error("Expected an existing directory.");
  return canonical;
}

export class BoardService {
  private provision = Promise.resolve<unknown>(undefined);
  /** Reads external items added at creation (EXTERNAL-TRACKER-SPEC §5.4); set by the plugin entry. */
  connectors?: ConnectorService;
  /** Workflow-insights suggestions a card can be created from (WORKFLOW-INSIGHTS-SPEC §5.2); set by the plugin entry. */
  insightFindings?: { check(projectId: string, id: string): Promise<void>; accept(projectId: string, id: string, taskId: string): Promise<void> };
  /** Workspaces no card may be bound to: the dispatcher's (DISPATCHER-SPEC §2); set by the plugin entry. */
  reservedWorkspace: (workspaceId: string) => boolean | Promise<boolean> = () => false;
  /** Folders that never become a Flowly project: the dispatcher's (DISPATCHER-SPEC §2); set by the plugin entry. */
  reservedRoot: (path: string) => boolean | Promise<boolean> = () => false;
  constructor(readonly store: BoardStore) {}
  private serialize<T>(action: () => Promise<T>) {
    const result = this.provision.then(action);
    this.provision = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async resources(paseo: PaseoApi) {
    const listed = (await paseo.projects.list()).projects;
    // The dispatcher's own Paseo project and workspace are not offered to Add project or New task.
    const reserved = await Promise.all(listed.map((p) => this.reservedRoot(p.projectRootPath)));
    const hidden = new Set(listed.filter((_, i) => reserved[i]).map((p) => p.projectId));
    const projects = listed.filter((p) => !hidden.has(p.projectId));
    const board = await this.store.read();
    const match = repoMatcher([
      ...new Set(board.projects.flatMap((p) => p.repos)),
    ]);
    const workspaces = [];
    let cursor: string | undefined;
    do {
      // Background (hidden) workspaces, such as PR-review ones, are listed too: a card may be bound to one.
      // They carry `background` so pickers can leave them out.
      const page = await paseo.workspaces.list({
        filter: { includeBackground: true },
        page: { limit: 200, cursor },
      });
      for (const w of page.entries) if (!hidden.has(w.projectId) && !(await this.reservedWorkspace(w.id))) workspaces.push(w);
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return {
      projects: projects.map((p) => ({
        id: p.projectId,
        name: p.projectDisplayName,
        path: p.projectRootPath,
      })),
      workspaces: await Promise.all(
        workspaces.map(async (w) => ({
          id: w.id,
          projectId: w.projectId,
          name: w.name || w.id,
          path: w.workspaceDirectory,
          status: w.status,
          kind: w.workspaceKind,
          ...(w.background ? { background: true } : null),
          repoPaths: await match(w.workspaceDirectory),
          owner:
            projects.find((p) => p.projectId === w.projectId)
              ?.projectDisplayName || w.projectId,
        })),
      ),
    };
  }
  createProject(input: ProjectInput, paseo: PaseoApi) {
    return this.serialize(() => this.registerProject(input, paseo));
  }
  /**
   * Linked multi-repo project: a new, plugin-owned directory holding one
   * symlink per chosen directory, registered as the native project root.
   */
  createLinked(input: LinkedProjectInput, paseo: PaseoApi) {
    return this.serialize(async () => {
      const targets = await linkTargets(input.links);
      const parent = linkedDirectory();
      await mkdir(parent, { recursive: true });
      const taken = new Set<string>();
      let root = "";
      for (const base = folderName(input.title); ; ) {
        root = join(parent, uniqueName(base, taken));
        // Exclusive create: never reuse or write into an existing directory.
        const created = await mkdir(root).then(() => true, (e: NodeJS.ErrnoException) => {
          if (e.code === "EEXIST") return false;
          throw e;
        });
        if (created) break;
      }
      const names = new Set<string>(),
        links = targets.map((target) => ({ name: uniqueName(folderName(basename(target), "repo"), names), target }));
      let registered = false;
      try {
        for (const link of links) await symlink(link.target, join(root, link.name), "dir");
        return await this.registerProject(
          { title: input.title, description: input.description, primaryPath: root },
          paseo,
          links,
          () => (registered = true),
        );
      } catch (e) {
        if (!registered) {
          for (const link of links) await unlink(join(root, link.name)).catch(() => undefined);
          await rmdir(root).catch(() => undefined);
        }
        throw e;
      }
    });
  }
  /** Adds/removes symlinks of a linked project; only entries the plugin recorded are removed. */
  setLinks(input: ProjectLinksEdit) {
    return this.serialize(async () => {
      const board = await this.store.read();
      const project = board.projects.find((p) => p.id === input.id);
      if (!project) throw new Error("Project not found.");
      if (!project.links) throw new Error("Only linked multi-repo projects have editable repositories.");
      if (project.revision !== input.revision)
        throw new Error("Revision conflict: reload the project before saving.");
      const targets = await linkTargets(input.links);
      const root = project.primaryPath;
      const kept = project.links.filter((l) => targets.includes(l.target)),
        removed = project.links.filter((l) => !targets.includes(l.target));
      for (const link of removed) {
        const path = join(root, link.name);
        const entry = await lstat(path).catch(() => null);
        if (!entry) continue;
        if (!entry.isSymbolicLink() || (await readlink(path)) !== link.target)
          throw new Error(`${path} is no longer the link Kanban created; remove it yourself or restore it.`);
      }
      for (const link of removed) await unlink(join(root, link.name)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      });
      const taken = new Set(kept.map((l) => l.name.toLowerCase()));
      const added: { name: string; target: string }[] = [];
      for (const target of targets.filter((t) => !kept.some((l) => l.target === t))) {
        let name = uniqueName(folderName(basename(target), "repo"), taken);
        // Skip names a user created inside the root by hand.
        while (await lstat(join(root, name)).then(() => true, () => false))
          name = uniqueName(folderName(basename(target), "repo"), taken);
        await symlink(target, join(root, name), "dir");
        added.push({ name, target });
      }
      const links = targets.map((t) => kept.find((l) => l.target === t) || added.find((l) => l.target === t)!);
      return this.store.mutate((board) => {
        const p = board.projects.find((p) => p.id === input.id);
        if (!p) throw new Error("Project not found.");
        p.links = links;
        p.revision++;
        p.updatedAt = new Date().toISOString();
        return p;
      });
    });
  }
  /** What removing a project touches in Paseo (PROJECT-REMOVE-SPEC). Read-only. */
  async removeCheck(id: string, paseo: PaseoApi) {
    const board = await this.store.read();
    const project = board.projects.find((p) => p.id === id);
    if (!project) throw new Error("Project not found.");
    const native = (await paseo.projects.list()).projects.find((p) => p.projectId === project.paseoProjectId);
    const workspaces = new Set<string>();
    if (native) {
      let cursor: string | undefined;
      do {
        // Removing the project removes its background workspaces too.
        const page = await paseo.workspaces.list({ filter: { includeBackground: true }, page: { limit: 200, cursor } });
        for (const w of page.entries) if (w.projectId === project.paseoProjectId) workspaces.add(w.id);
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
    }
    let runningSessions = 0,
      cursor: string | undefined;
    if (workspaces.size)
      do {
        const page = await paseo.agents.list({ filter: { includeArchived: false, includeBackground: true }, page: { limit: 200, cursor } });
        for (const { agent } of page.entries)
          if (!!agent.workspaceId && workspaces.has(agent.workspaceId) && !agent.archivedAt && (agent.status === "running" || agent.status === "initializing"))
            runningSessions++;
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
    return {
      cards: board.tasks.filter((t) => t.projectId === id).length,
      paseoProjectId: project.paseoProjectId,
      paseoExists: !!native,
      workspaces: workspaces.size,
      runningSessions,
    };
  }
  /**
   * Removes the board project; with `alsoPaseo` then removes the native
   * project too (Paseo has no project archive; its removal keeps all files).
   * The board removal comes first so a failed Paseo step never strands cards.
   */
  removeProject(input: ProjectRemoval, paseo: PaseoApi) {
    return this.serialize(async (): Promise<RemoveResult> => {
      let check: Awaited<ReturnType<BoardService["removeCheck"]>> | null = null;
      if (input.alsoPaseo) {
        check = await this.removeCheck(input.id, paseo);
        if (check.runningSessions)
          throw new Error(
            `${check.runningSessions} session${check.runningSessions === 1 ? " is" : "s are"} still running in this Paseo project. Stop ${check.runningSessions === 1 ? "it" : "them"} first, or keep the project in Paseo.`,
          );
      }
      const removed = await this.store.removeProject(input);
      if (!check) return removed;
      if (!check.paseoExists) return { ...removed, paseo: { removed: false, workspaces: 0, error: "" } };
      try {
        const stdout = await runPaseo(
          ["project", "delete", check.paseoProjectId, "--home", paseoHome(), "--json"],
          { timeout: 60000, maxBuffer: 1024 * 1024 },
        );
        const ids = (JSON.parse(stdout) as { removedWorkspaceIds?: string[] }).removedWorkspaceIds ?? [];
        return { ...removed, paseo: { removed: true, workspaces: ids.length, error: "" } };
      } catch (e) {
        const reason = String((e as { stderr?: string }).stderr || (e as Error).message || e).trim().split("\n").pop() || "unknown error";
        return { ...removed, paseo: { removed: false, workspaces: 0, error: reason } };
      }
    });
  }
  /** Finds the native project at a folder, or creates it as Add project does. */
  private async nativeProject(primaryPath: string, paseo: PaseoApi, paseoProjectId?: string, onRegistered?: () => void) {
    if (await this.reservedRoot(primaryPath)) throw new Error("This is the Flowly dispatcher's folder; it can't be a Flowly project.");
    const findNative = async () => {
      const projects = (await paseo.projects.list()).projects;
      if (paseoProjectId) return projects.find((p) => p.projectId === paseoProjectId);
      const paths = await Promise.all(projects.map((p) => directory(p.projectRootPath).catch(() => null)));
      return projects.find((_, i) => paths[i] === primaryPath);
    };
    let native = await findNative();
    if (paseoProjectId && !native) throw new Error("Paseo project not found.");
    if (!native) {
      // From here on the directory may be referenced by a native project; keep it on failure.
      onRegistered?.();
      await runPaseo(["project", "create", primaryPath, "--home", paseoHome(), "--json"], {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      native = await findNative();
    }
    if (!native || (await directory(native.projectRootPath)) !== primaryPath)
      throw new Error("Native project root does not match the selected primary directory.");
    return native;
  }
  /** Read-only: whether a folder holds a saved Flowly project (PROJECT-FOLDER-SPEC §3). */
  async restoreCheck(path: string): Promise<RestoreCheck> {
    const root = await directory(path).catch(() => null);
    if (!root) return { found: false };
    let snapshot: ProjectSnapshot | null;
    try {
      snapshot = await readSnapshot(root);
    } catch {
      return { found: true, title: "", cards: 0, savedAt: "", conflict: "invalid", unbound: 0 };
    }
    if (!snapshot) return { found: false };
    const board = await this.store.read();
    const bound = new Set(board.tasks.map((t) => t.workspaceId));
    const base = { found: true as const, title: snapshot.project.title, cards: snapshot.tasks.length, savedAt: snapshot.savedAt };
    if (board.projects.some((p) => p.id === snapshot.project.id))
      return { ...base, conflict: "on-board" as const, unbound: 0 };
    return { ...base, conflict: "" as const, unbound: snapshot.tasks.filter((t) => bound.has(t.workspaceId)).length };
  }
  /** Puts a folder's saved project back on the board; the native project is found or created first. */
  restoreProject(input: { path: string }, paseo: PaseoApi) {
    return this.serialize(async () => {
      const primaryPath = await directory(input.path);
      const snapshot = await readSnapshot(primaryPath).catch((e) => {
        throw new Error(e instanceof SnapshotInvalidError ? "The project file in this folder is invalid; it was left unchanged." : String(e));
      });
      if (!snapshot) throw new Error("This folder has no saved Flowly project.");
      const board = await this.store.read();
      if (board.projects.some((p) => p.id === snapshot.project.id)) throw new Error("This project is already on the board.");
      const native = await this.nativeProject(primaryPath, paseo);
      const restored = await this.store.restoreProject(snapshot, { primaryPath, paseoProjectId: native.projectId });
      // Linked projects: drop recorded links whose symlink is gone.
      if (restored.project.links?.length) {
        const kept: NonNullable<Project["links"]> = [];
        for (const link of restored.project.links)
          if (await lstat(join(primaryPath, link.name)).then((s) => s.isSymbolicLink(), () => false)) kept.push(link);
        if (kept.length !== restored.project.links.length)
          await this.store.mutate((b) => {
            const p = b.projects.find((x) => x.id === restored.project.id);
            if (p) p.links = kept;
          });
      }
      return { ...restored, snapshot };
    });
  }
  private async registerProject(
    input: ProjectInput,
    paseo: PaseoApi,
    links?: Project["links"],
    onRegistered?: () => void,
  ) {
    {
      const primaryPath = await directory(input.primaryPath);
      // Checked before Paseo registers anything; checked again in the write below.
      if (input.groupId !== undefined && !(await this.store.read()).groups.some((g) => g.id === input.groupId))
        throw new ToolError("GROUP_NOT_FOUND", "No board group with that id.");
      const native = await this.nativeProject(primaryPath, paseo, input.paseoProjectId, onRegistered);
      const paseoProjectId = native.projectId;
      return this.store.mutate((board) => {
        if (board.projects.some((p) => p.paseoProjectId === paseoProjectId))
          throw new Error(
            "Paseo project is already linked; open or restore its board project.",
          );
        // A chosen group must exist; without one the commit places the project in the default group (BOARD-GROUPS-SPEC §2).
        if (input.groupId !== undefined && !board.groups.some((g) => g.id === input.groupId))
          throw new ToolError("GROUP_NOT_FOUND", "No board group with that id.");
        const now = new Date().toISOString();
        const project = {
          ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
          id: randomUUID(),
          title: input.title,
          description: input.description,
          paseoProjectId,
          primaryPath,
          repos: [primaryPath],
          ...(links ? { links } : {}),
          // Auto review is on for new projects (GUARDRAILS-SPEC D1); existing projects keep what they stored.
          autoReview: { enabled: true, maxRounds: 2 },
          revision: 1,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        };
        board.projects.push(project);
        return project;
      });
    }
  }
  /**
   * A suggestion is checked before any workspace exists and marked accepted once
   * the card is written; the two live in different files, so a failed accept
   * leaves the card and the suggestion open (logged). `by`: an agent creates
   * the card (AGENT-CARDS-SPEC §3.3); its activity, tags and follow-up link say so.
   */
  async createTask(input: TaskInput, paseo: PaseoApi, by?: { agentId: string; groupId?: string }) {
    const findingId = input.insightFindingId;
    if (findingId) {
      if (!this.insightFindings) throw new Error("Workflow insights are unavailable.");
      if (input.ideaId || input.followUpOf) throw new Error("A card comes from one suggestion, idea or source card.");
      const board = await this.store.read();
      if (!board.tasks.some((t) => t.operationId === input.operationId)) await this.insightFindings.check(input.projectId, findingId);
    }
    const task = await this.createCard(input, paseo, by);
    if (findingId)
      await this.insightFindings!.accept(input.projectId, findingId, task.id).catch((e) =>
        logFailure("Workflow insights suggestion not marked accepted:", e),
      );
    return task;
  }
  private createCard(input: TaskInput, paseo: PaseoApi, by?: { agentId: string; groupId?: string }) {
    return this.serialize(async () => {
      const board = await this.store.read();
      const previous = board.tasks.find(
        (t) => t.operationId === input.operationId,
      );
      if (previous) return previous;
      const project = board.projects.find((p) => p.id === input.projectId);
      if (!project || project.archivedAt)
        throw new Error("Project is unavailable or archived.");
      // A dispatcher's card (`by.groupId`): checked before the workspace is made and again when the card is written.
      checkGroup(project, by?.groupId);
      const laneError = laneProblem(project, input.status);
      if (laneError) throw new Error(laneError);
      // Validated before any workspace exists (CARD-TAGS-SPEC §3).
      const tags = normalizeTags(input.tags || []);
      if (tags.length > tagLimits.perTask) throw new Error(`A card can have at most ${tagLimits.perTask} tags.`);
      // Checked before any workspace exists, and again when the card is written (IDEAS-SPEC §6).
      if (input.ideaId) openIdea(board, input.ideaId, project.id);
      if (input.ideaId && input.followUpOf) throw new Error("A card comes from an idea or follows up a card, not both.");
      if (input.followUpOf) followUpSource(board, input.followUpOf, project.id);
      // Each external item is read before any workspace exists; one that can't be read refuses the card.
      const externals = input.externals?.length
        ? await (async () => {
            const service = this.connectors;
            if (!service) throw new Error("Connectors are unavailable.");
            const seen = new Set<string>();
            const list = [];
            for (const t of input.externals!) {
              const found = await service.resolve(t.connectionId, t.key, t.itemType);
              if (seen.has(found.url)) continue;
              seen.add(found.url);
              list.push(found);
            }
            return list;
          })()
        : [];
      const repoPaths = [project.primaryPath];
      const sourcePath = project.primaryPath;
      let workspaceId = input.workspaceId;
      let baseRef: string | undefined;
      if (input.mode === "existing") {
        if (!workspaceId) throw new Error("Select a workspace.");
        if (await this.reservedWorkspace(workspaceId)) throw new Error("This is the Flowly dispatcher's workspace; a card can't use it.");
        const workspace = await paseo.workspaces.ref(workspaceId).refresh();
        // Also one in the dispatcher's folder that is no longer its stored workspace (the old in-data one, §2).
        if (workspace && (await this.reservedRoot(workspace.workspaceDirectory)))
          throw new Error("This is the Flowly dispatcher's workspace; a card can't use it.");
        const matching = workspace
          ? await repoMatcher([project.primaryPath])(
              workspace.workspaceDirectory,
            )
          : [];
        if (!workspace || !matching.length)
          throw new Error(
            "Workspace is unavailable or outside this project's repositories.",
          );
        if (board.tasks.some((t) => t.workspaceId === workspaceId))
          throw new Error("Workspace is already bound to another card.");
      } else {
        const branchName =
          input.mode === "worktree"
            ? input.branchName?.trim() || generatedBranchName(input.title, input.operationId)
            : undefined;
        baseRef =
          input.mode === "worktree"
            ? await resolveWorktreeBaseRef(sourcePath, input.baseRef)
            : undefined;
        const intent = createHash("sha256")
          .update(
            JSON.stringify({
              projectId: project.paseoProjectId,
              sourcePath,
              mode: input.mode,
              baseRef,
              branchName,
              title: input.title,
            }),
          )
          .digest("hex")
          .slice(0, 24);
        const created = await paseo.workspaces.create({
          title: input.title,
          idempotencyKey: `ultra-kanban:${input.operationId}:${intent}`,
          source:
            input.mode === "directory"
              ? {
                  kind: "directory",
                  path: sourcePath,
                  projectId: project.paseoProjectId,
                }
              : {
                  kind: "worktree",
                  cwd: sourcePath,
                  projectId: project.paseoProjectId,
                  action: "branch-off",
                  refName: baseRef,
                  branchName,
                },
        });
        workspaceId = created.id;
      }
      const id = workspaceId!;
      try {
        return await this.store.mutate((current) => {
          const duplicate = current.tasks.find(
            (t) => t.operationId === input.operationId,
          );
          if (duplicate) return duplicate;
          const p = current.projects.find((p) => p.id === project.id);
          if (!p || p.archivedAt || p.primaryPath !== sourcePath)
            throw new Error("Project changed during workspace creation.");
          checkGroup(p, by?.groupId);
          const idea = input.ideaId ? openIdea(current, input.ideaId, project.id) : undefined;
          if (input.followUpOf) followUpSource(current, input.followUpOf, project.id);
          const now = new Date().toISOString();
          const task = {
            id: randomUUID(),
            projectId: project.id,
            workspaceId: id,
            sourcePath,
            repoPaths,
            title: input.title,
            description: input.description,
            status: input.status,
            priority: input.priority,
            ...(input.type ? { type: input.type } : {}),
            ...(input.deliveryMode ? { deliveryMode: input.deliveryMode } : {}),
            ...(tags.length
              ? { tags: tags.map((tag) => (by ? { tag, by: "agent" as const, agentId: by.agentId, at: now } : { tag, by: "human" as const, at: now })) }
              : {}),
            // Last in its column of the group's manual order, so last on the project's own order too (BOARD-GROUPS-SPEC §1).
            position: columnEnd(current, project.id, input.status),
            revision: 1,
            operationId: input.operationId,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            ownsWorkspace: input.mode !== "existing",
            ...(baseRef ? { baseRef } : {}),
            ...(idea ? { origin: { ...(idea.taskId ? { taskId: idea.taskId } : {}), ideaId: idea.id } } : {}),
          };
          current.tasks.push(task);
          this.store.event(current, {
            taskId: task.id,
            actor: by ? "agent" : "human",
            ...(by ? { agentId: by.agentId } : {}),
            action: "created",
          });
          // The new card follows up its source (CARD-LINKS-SPEC §3); a project idea has none (PROJECT-IDEAS-SPEC §3).
          if (idea?.taskId)
            addLink(this.store, current, { kind: "derived", from: task.id, to: idea.taskId, ideaId: idea.id, createdBy: "system" }, { events: false, limit: false, archived: true });
          if (input.followUpOf && by) {
            addLink(this.store, current, { kind: "derived", from: task.id, to: input.followUpOf, createdBy: "system" }, { events: false });
            this.store.event(current, { taskId: input.followUpOf, actor: "agent", agentId: by.agentId, action: "card_created", note: task.title });
          } else if (input.followUpOf)
            addLink(this.store, current, { kind: "derived", from: task.id, to: input.followUpOf });
          // In the same write, so the first session's context already lists them.
          for (const t of externals)
            putArtifact(this.store, current, { taskId: task.id, role: "input", kind: "url", target: t.url, title: t.title, createdBy: "human", external: t.external }, now);
          if (idea) {
            idea.status = "accepted";
            idea.acceptedTaskId = task.id;
            idea.updatedAt = now;
            if (idea.taskId)
              this.store.event(current, {
                taskId: idea.taskId,
                actor: "human",
                action: "idea_accepted",
                note: `${idea.title} → ${task.title}`,
              });
          }
          return task;
        });
      } catch (error) {
        if (error instanceof ToolError)
          throw new ToolError(error.code, `Card was not saved. Workspace ${id} remains available. ${error.message}`);
        throw new Error(
          `Card was not saved. Workspace ${id} remains available; retry with the same operation or link it. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }
  /** External inputs whose connection was removed (EXTERNAL-TRACKER-SPEC §2); unreadable stays empty on failure. */
  private async unreadableExternals(board: Board, taskId: string) {
    const list = board.artifacts.filter((a) => a.taskId === taskId && a.external);
    if (!list.length || !this.connectors) return new Set<string>();
    const located = await this.connectors.locate(list).catch(() => new Map<string, null>());
    return new Set(list.filter((a) => located.has(a.id) && !located.get(a.id)).map((a) => a.id));
  }
  /** `artifactsOn`: whether agents may add artifacts now (Settings → AI features); decides how the Linear block links (LINEAR-TICKET-SPEC §3). */
  async context(id: string, paseo: PaseoApi, snapshot?: Board, options: { artifactsOn?: boolean; deliveryDefault?: DeliveryMode } = {}) {
    const board = snapshot || (await this.store.read());
    const task = board.tasks.find((t) => t.id === id);
    const project = board.projects.find((p) => p.id === task?.projectId);
    if (!task || !project) throw new Error("Task or project not found.");
    const workspace = await paseo.workspaces.ref(task.workspaceId).refresh();
    const matches = workspace
      ? await repoMatcher(project.repos)(workspace.workspaceDirectory)
      : [];
    const available =
      !!workspace &&
      !!matches.length &&
      !task.archivedAt &&
      !project.archivedAt;
    // Project memory for the first instructions (PROJECT-MEMORY-SPEC §6.1); unreadable memory never blocks a session.
    const memory = await memoryContext(this.store.directory, task, project, board).catch(() => ({ lines: [] as string[], ids: [] as string[] }));
    const directories = effectiveRepos(task, project).map((repo) => ({
      repo,
      directory:
        workspace?.workspaceKind === "worktree" && matches.includes(repo)
          ? workspace.workspaceDirectory
          : repo,
    }));
    return {
      available,
      reason:
        task.archivedAt || project.archivedAt
          ? "Task or project is archived."
          : !workspace
            ? "Workspace is unavailable or archived."
            : !matches.length
              ? "Workspace is outside this project's repositories."
              : "",
      context: sessionContext(
        task,
        project,
        directories,
        workspace?.workspaceDirectory || task.sourcePath,
        linkContextLines(linksOf(board, task.id), (t) => laneName(project, t.status)),
        artifactContextLines(artifactsOf(board.artifacts, task.id), 10, await this.unreadableExternals(board, task.id)),
        setupContextLine(setupMissing(task, workpadOf(board.workpads, task.id), workpadEnabled(project))),
        memory.lines,
        // A PR review card reviews someone else's PR; it is never asked for a Linear ticket (PR-REVIEW-CARDS-SPEC §5).
        isPrReviewCard(task) ? [] : linearTicketLines(project, artifactsOf(board.artifacts, task.id), { title: task.title, canLink: options.artifactsOn ?? true }),
        options.deliveryDefault,
        groupOfProject(board, project)?.defaults?.deliveryMode,
      ),
      memoryIds: memory.ids,
      directories,
      workspaceRepoPaths: matches,
      owner:
        workspace?.projectDisplayName || workspace?.projectId || "Unavailable",
    };
  }
}

/** The live card a new follow-up card links to, or an error (CARD-LINKS-SPEC §3). */
export function followUpSource(board: Board, id: string, projectId: string) {
  const source = board.tasks.find((t) => t.id === id);
  if (!source || source.projectId !== projectId) throw new Error("The card to follow up is no longer in this project.");
  if (source.archivedAt) throw new Error("Archived cards can't get new links.");
  if (board.links.filter((l) => l.from === id || l.to === id).length >= linkLimits.perTask)
    throw new Error(`A card can have at most ${linkLimits.perTask} links.`);
  return source;
}

/** The open idea `id` of this project, or an error (IDEAS-SPEC §6). */
export function openIdea(board: Board, id: string, projectId: string) {
  const idea = board.ideas.find((i) => i.id === id);
  if (!idea || idea.status !== "open" || idea.projectId !== projectId)
    throw new Error("This idea is no longer open.");
  return idea;
}
