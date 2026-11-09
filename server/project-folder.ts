import { mkdir, readFile, writeFile, rename, unlink, copyFile, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { upgradeBoard } from "./migrate";
import type { Board, Project } from "../shared/model";
import type { SummaryEntry } from "../shared/summary";
import { summaryEntrySchema } from "../shared/summary";
import { logFailure } from "./error-report";

/** Per-project copy of the board in `<root>/.flowly/` (PROJECT-FOLDER-SPEC). */
export const FOLDER = ".flowly";
export const FILE = "project.json";
export const folderOf = (root: string) => join(root, FOLDER);
export const snapshotPath = (root: string) => join(root, FOLDER, FILE);

const snapshotShape = z.object({
  format: z.literal("flowly-project"),
  version: z.literal(1),
  savedAt: z.string(),
  boardVersion: z.number().int(),
  project: z.unknown(),
  tasks: z.array(z.unknown()),
  events: z.array(z.unknown()),
  ideas: z.array(z.unknown()).default([]),
  links: z.array(z.unknown()).default([]),
  artifacts: z.array(z.unknown()).default([]),
  workpads: z.array(z.unknown()).default([]),
  plans: z.array(z.unknown()).default([]),
  summaries: z.array(summaryEntrySchema).default([]),
});

export type ProjectSnapshot = {
  savedAt: string;
  project: Project;
  tasks: Board["tasks"];
  events: Board["events"];
  ideas: Board["ideas"];
  links: Board["links"];
  artifacts: Board["artifacts"];
  workpads: Board["workpads"];
  plans: Board["plans"];
  summaries: SummaryEntry[];
};

/** The project's records, exactly as stored on the board. */
export function projectRecords(board: Board, projectId: string, summaries: readonly SummaryEntry[] = []) {
  const project = board.projects.find((p) => p.id === projectId);
  if (!project) return null;
  const ids = new Set(board.tasks.filter((t) => t.projectId === projectId).map((t) => t.id));
  return {
    project,
    tasks: board.tasks.filter((t) => ids.has(t.id)),
    events: board.events.filter((e) => ids.has(e.taskId)),
    ideas: board.ideas.filter((i) => (i.taskId ? ids.has(i.taskId) : i.projectId === projectId)),
    links: board.links.filter((l) => ids.has(l.from) && ids.has(l.to)),
    artifacts: board.artifacts.filter((a) => ids.has(a.taskId)),
    workpads: board.workpads.filter((w) => ids.has(w.taskId)),
    plans: board.plans.filter((p) => ids.has(p.taskId)),
    summaries: summaries.filter((s) => ids.has(s.taskId)),
  };
}

/** Content key for change detection; chooser order is presentation only. */
function contentKey(records: Omit<ProjectSnapshot, "savedAt">) {
  const { position: _position, ...project } = records.project;
  const { tasks, events, ideas, links, artifacts, workpads, plans, summaries } = records;
  return JSON.stringify({ project, tasks, events, ideas, links, artifacts, workpads, plans, summaries });
}

export class SnapshotInvalidError extends Error {}

/** Reads and validates a folder's snapshot; null when there is none. */
export async function readSnapshot(root: string): Promise<ProjectSnapshot | null> {
  let text: string;
  try {
    text = await readFile(snapshotPath(root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SnapshotInvalidError((error as Error).message);
  }
  try {
    const raw = snapshotShape.parse(JSON.parse(text));
    // Parse the records with the board schemas (and their upgrades) as one-project board.
    const board = upgradeBoard({
      version: raw.boardVersion,
      revision: 0,
      projects: [raw.project],
      tasks: raw.tasks,
      events: raw.events,
      ideas: raw.ideas,
      links: raw.links,
      artifacts: raw.artifacts,
      workpads: raw.workpads,
      plans: raw.plans,
      agentReceipts: [],
    });
    const [project] = board.projects;
    if (!project || board.tasks.some((t) => t.projectId !== project.id))
      throw new Error("Cards do not belong to the project.");
    return { savedAt: raw.savedAt, project, tasks: board.tasks, events: board.events, ideas: board.ideas, links: board.links, artifacts: board.artifacts, workpads: board.workpads, plans: board.plans, summaries: raw.summaries };
  } catch (error) {
    throw new SnapshotInvalidError(error instanceof Error ? error.message : String(error));
  }
}
export type FolderState = { path: string; savedAt: string; error: string };

const stamp = (iso: string) => iso.replace(/[:.]/g, "-");

/**
 * Writes each project's snapshot after board commits, debounced and serialized.
 * Failures never reach the board write; they are kept per project for settings.
 */
export class ProjectFolders {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private written = new Map<string, string>();
  private states = new Map<string, FolderState>();
  private logged = new Set<string>();
  constructor(
    private readonly read: () => Promise<Board>,
    private readonly summaries: () => Promise<readonly SummaryEntry[]> = async () => [],
    readonly delay = 1000,
  ) {}
  /** Called after each board commit. */
  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => undefined);
    }, this.delay);
    (this.timer as { unref?: () => void }).unref?.();
  }
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  state(projectId: string) {
    return this.states.get(projectId) ?? null;
  }
  /** Writes every project whose content changed since its last write. */
  flush() {
    const run = this.tail.then(async () => {
      const board = await this.read();
      const summaries = await this.summaries().catch(() => []);
      for (const project of board.projects) await this.writeOne(board, project, summaries);
      const live = new Set(board.projects.map((p) => p.id));
      for (const id of this.written.keys()) if (!live.has(id)) this.written.delete(id);
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
  /**
   * Upgrade migration (PROJECT-FOLDER-SPEC §1.1): every project on the board
   * gets its folder copy. A folder that already holds this project's current
   * records is left untouched. The result is recorded in `<data>/folder-migration.json`;
   * failed projects are retried on later commits and at every start until they succeed.
   */
  migrate(dataDirectory: string) {
    const run = this.tail.then(async () => {
      const board = await this.read();
      const summaries = await this.summaries().catch(() => []);
      const projects: Record<string, { path: string; result: "written" | "current" | "failed"; error?: string }> = {};
      for (const project of board.projects) {
        const records = projectRecords(board, project.id, summaries)!;
        const path = snapshotPath(project.primaryPath);
        const existing = await readSnapshot(project.primaryPath).catch(() => null);
        if (existing?.project.id === project.id && contentKey(existing) === contentKey(records)) {
          this.written.set(project.id, contentKey(records));
          this.states.set(project.id, { path, savedAt: existing.savedAt, error: "" });
          projects[project.id] = { path, result: "current" };
          continue;
        }
        await this.writeOne(board, project, summaries);
        const state = this.states.get(project.id);
        projects[project.id] = state?.error ? { path, result: "failed", error: state.error } : { path, result: "written" };
      }
      const record = { version: 1, at: new Date().toISOString(), projects };
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      const target = join(dataDirectory, "folder-migration.json"),
        temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      const counts = Object.values(projects).reduce<Record<string, number>>((n, p) => ((n[p.result] = (n[p.result] ?? 0) + 1), n), {});
      console.log(`Flowly project folders: ${counts.written ?? 0} written, ${counts.current ?? 0} current, ${counts.failed ?? 0} failed.`);
      return record;
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
  /** Next write of this project happens even if its content looks unchanged. */
  forget(projectId: string) {
    this.written.delete(projectId);
  }
  private async writeOne(board: Board, project: Project, summaries: readonly SummaryEntry[]) {
    const records = projectRecords(board, project.id, summaries)!;
    const key = contentKey(records);
    if (this.written.get(project.id) === key) return;
    const root = project.primaryPath,
      path = snapshotPath(root),
      savedAt = new Date().toISOString();
    try {
      await prepareFolder(root);
      await setAsideForeign(root, project.id, savedAt);
      const temporary = `${path}.${randomUUID()}.tmp`;
      const body = { format: "flowly-project", version: 1, savedAt, boardVersion: board.version, ...records };
      try {
        await writeFile(temporary, JSON.stringify(body, null, 2), { mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      this.written.set(project.id, key);
      this.states.set(project.id, { path, savedAt, error: "" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.states.set(project.id, { path, savedAt: this.states.get(project.id)?.savedAt ?? "", error: reason });
      if (!this.logged.has(`${project.id}:${reason}`)) {
        this.logged.add(`${project.id}:${reason}`);
        logFailure("Kanban project folder not saved:", error, project.id);
      }
    }
  }
}

/** Creates `.flowly/` with a `*` .gitignore the first time only; refuses a symlinked folder. */
async function prepareFolder(root: string) {
  const folder = folderOf(root);
  const info = await lstat(folder).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (info && !info.isDirectory()) throw new Error(`${folder} is not a folder.`);
  if (info) return;
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new Error(`${root} is not a folder.`);
  await mkdir(folder, { mode: 0o700 });
  await writeFile(join(folder, ".gitignore"), "*\n", { mode: 0o644, flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
}

/** Another project's (or an unreadable) snapshot is kept as a dated copy, never overwritten. */
async function setAsideForeign(root: string, projectId: string, now: string) {
  let existing: ProjectSnapshot | null = null;
  try {
    existing = await readSnapshot(root);
    if (!existing || existing.project.id === projectId) return;
  } catch (error) {
    if (!(error instanceof SnapshotInvalidError)) throw error;
  }
  const label = existing ? stamp(existing.savedAt) : `invalid-${stamp(now)}`;
  await copyFile(snapshotPath(root), join(folderOf(root), `project.${label}.json`), constants.COPYFILE_EXCL).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
}
