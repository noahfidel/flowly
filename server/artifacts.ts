import { randomUUID } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { extraFolderIgnored } from "../shared/settings";
import { absoluteTarget, artifactNoteLine, defaultTitle, isUrlTarget, validUrl } from "../shared/artifacts";
import { artifactLimits, type Artifact, type ArtifactEdit, type ArtifactRole, type Board, type Project, type Task } from "../shared/model";
import { effectiveRepos } from "../shared/scope";
import type { BoardStore } from "./store";
import type { ExternalRef, ItemType } from "../shared/connectors";
import type { ConnectorService } from "./connectors/service";

/**
 * Card artifacts (CARD-ARTIFACTS-SPEC): references to files inside the card's
 * directories or to http(s) links. Files are never copied or changed.
 */

/** Where a card's files may live, and the directory "./" targets are relative to. */
/** `roots` are resolved through symlinks at each check; `resolved` (the extra folders) were resolved at the settings read and are compared as they are. */
export type ArtifactRoots = { workspace: string; roots: string[]; resolved?: string[] };

/**
 * Extra folders from Settings as absolute roots: `~` expanded, normalized (no trailing slash), duplicates dropped.
 * Empty and relative entries are ignored, and so are the filesystem root and the home directory (too broad to hand to agents).
 */
export function extraFolderRoots(folders: readonly string[], home = homedir()): string[] {
  const roots = new Set<string>();
  for (const raw of folders) {
    const value = raw.trim();
    if (extraFolderIgnored(value)) continue;
    const path = value === "~" || value.startsWith("~/") ? join(home, value.slice(1)) : value;
    if (!path || !isAbsolute(path)) continue;
    const root = resolve(path);
    if (root === parse(root).root || root === resolve(home)) continue;
    roots.add(root);
  }
  return [...roots];
}

/**
 * The card's workspace directory (or its source path) plus its scope directories and linked repositories,
 * and, apart in `resolved`, the extra folders set in Settings (textual cleanup only: pass `resolveExtraRoots` output).
 */
export function artifactRoots(
  task: Task,
  project: Project,
  workspaceDirectory?: string | null,
  extra: readonly string[] = [],
  /** The plugin data folder: the card's own plan copies (`planCopyFolder`) are one of its roots (CARD-PLAN-SPEC §1.2). */
  dataDirectory?: string,
): ArtifactRoots {
  const workspace = workspaceDirectory || task.sourcePath;
  return {
    workspace,
    roots: [
      ...new Set([
        workspace,
        task.sourcePath,
        project.primaryPath,
        ...effectiveRepos(task, project),
        ...(project.links || []).map((l) => l.target),
        ...(dataDirectory ? [planCopyFolder(dataDirectory, task.id)] : []),
      ]),
    ],
    resolved: extraFolderRoots(extra),
  };
}

/** Where Flowly keeps a card's plan copies, plans written from plan-mode text (CARD-PLAN-SPEC §1.2). */
export const planCopyFolder = (dataDirectory: string, taskId: string) => join(dataDirectory, "plans", taskId);

const real = (path: string) => realpath(path).catch(() => null);
const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * `extraFolderRoots` decided on real paths, which is what `withinRoots` compares: each folder is resolved through symlinks
 * (unresolvable ones are dropped), and a root that is `/`, the home directory or an ancestor of it is dropped, however it is spelled
 * (a link to `/`, a case variant of home on macOS, `~/..`). Build every card's roots with this, never with the raw setting.
 */
export async function resolveExtraRoots(folders: readonly string[], home = homedir()): Promise<string[]> {
  const candidates = extraFolderRoots(folders, home);
  if (!candidates.length) return [];
  const realHome = (await real(home)) ?? resolve(home);
  const roots = new Set<string>();
  for (const candidate of candidates) {
    const path = await real(candidate);
    if (!path || path === parse(path).root || inside(realHome, path)) continue;
    roots.add(path);
  }
  return [...roots];
}

/** The card's roots as real paths: `roots` resolved now, `resolved` as they are (never resolved again). */
async function realRoots(where: ArtifactRoots): Promise<string[]> {
  const card = await Promise.all(where.roots.map(real));
  return [...card.filter((r): r is string => !!r), ...(where.resolved ?? [])];
}

async function withinReal(path: string, roots: readonly string[]) {
  const target = await real(path);
  return target && roots.some((r) => inside(target, r)) ? target : null;
}

/** The real path of `path` when it lies within the card's directories (after resolving symlinks), else null. */
export async function withinRoots(path: string, where: ArtifactRoots) {
  return withinReal(path, await realRoots(where));
}

/**
 * Validates a new target and returns its stored form (CARD-ARTIFACTS-SPEC §2.2):
 * links as given, files inside the workspace as "./relative", other files absolute.
 */
export async function normalizeTarget(raw: string, where: ArtifactRoots): Promise<{ kind: Artifact["kind"]; target: string }> {
  const value = raw.trim();
  if (isUrlTarget(value) || (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^file:\/\//i.test(value))) {
    if (!validUrl(value)) throw new Error("Only http and https links can be added.");
    return { kind: "url", target: value };
  }
  const path = value.replace(/^file:\/\//i, "").replace(/^~(?=\/|$)/, homedir());
  const absolute = isAbsolute(path) ? resolve(path) : resolve(where.workspace, path);
  if (!(await real(absolute))) throw new Error("This file doesn't exist.");
  if (!(await withinRoots(absolute, where))) throw new Error("Files outside this card's directories can't be added.");
  const fromWorkspace = relative(resolve(where.workspace), absolute);
  const target =
    fromWorkspace === "" ? "./" : !fromWorkspace.startsWith("..") && !isAbsolute(fromWorkspace) ? `./${fromWorkspace.split(sep).join("/")}` : absolute;
  if (target.length > artifactLimits.target) throw new Error("This path is too long.");
  return { kind: "file", target };
}

/** Whether each file artifact still exists (and stays inside the card's directories). Links are never missing. */
export async function missingArtifacts(list: readonly Artifact[], where: ArtifactRoots) {
  const missing = new Set<string>();
  if (!list.some((a) => a.kind === "file")) return missing;
  // The roots are resolved once for the whole list, not once per file.
  const roots = await realRoots(where);
  await Promise.all(
    list.map(async (a) => {
      if (a.kind === "file" && !(await withinReal(absoluteTarget(a.target, where.workspace), roots))) missing.add(a.id);
    }),
  );
  return missing;
}

export function liveCard(board: Board, taskId: string) {
  const task = board.tasks.find((t) => t.id === taskId);
  const project = board.projects.find((p) => p.id === task?.projectId);
  if (!task || !project) throw new Error("Task not found.");
  if (task.archivedAt || project.archivedAt) throw new Error("Archived cards can't be changed.");
  return { task, project };
}

export type NewArtifact = {
  taskId: string;
  role: ArtifactRole;
  kind: Artifact["kind"];
  target: string;
  title?: string;
  note?: string;
  createdBy: Artifact["createdBy"];
  agentId?: string;
  /** A recognized item link of a connection (CONNECTORS-SPEC §3.1); always an input. */
  external?: ExternalRef;
};

/**
 * An item link or bare key of a configured connection, checked with the
 * service, as an input artifact; null when `target` is not one.
 */
export async function externalArtifact(connectors: ConnectorService | undefined, target: string) {
  if (!connectors) return null;
  const found = await connectors.recognize(target);
  if (!found) return null;
  return { kind: "url" as const, target: found.url, external: found.external, title: found.title };
}

/**
 * Adds an artifact to `board`, or updates the card's existing one with the
 * same target (CARD-ARTIFACTS-SPEC §2.2). An agent never changes one a
 * person added; that one is returned as is, with a `notice` when the role
 * asked for differs, so the change is never silent.
 */
export function putArtifact(
  store: BoardStore,
  board: Board,
  input: NewArtifact,
  now = new Date().toISOString(),
): { artifact: Artifact; changed: boolean; eventId?: string; notice?: string } {
  const { task } = liveCard(board, input.taskId);
  const actor = input.createdBy === "agent" ? { actor: "agent" as const, agentId: input.agentId } : { actor: "human" as const };
  const existing = board.artifacts.find((a) => a.taskId === task.id && a.kind === input.kind && a.target === input.target);
  if (existing) {
    if (input.createdBy === "agent" && existing.createdBy === "human")
      return {
        artifact: existing,
        changed: false,
        ...(input.role !== existing.role ? { notice: `Already added by the user as ${existing.role}; role not changed. Their entries are not edited by agents.` } : {}),
      };
    const next = {
      role: input.role,
      title: input.title?.trim() || existing.title,
      note: input.note !== undefined ? input.note.trim() : existing.note,
    };
    const changed = next.role !== existing.role || next.title !== existing.title || next.note !== existing.note;
    if (changed) Object.assign(existing, next, { updatedAt: now });
    if (input.external && !existing.external) existing.external = input.external;
    return { artifact: existing, changed };
  }
  if (board.artifacts.filter((a) => a.taskId === task.id).length >= artifactLimits.perTask)
    throw new Error(`A card can have at most ${artifactLimits.perTask} artifacts.`);
  const artifact: Artifact = {
    id: randomUUID(),
    taskId: task.id,
    projectId: task.projectId,
    role: input.role,
    kind: input.kind,
    target: input.target,
    title: input.title?.trim() || defaultTitle(input.kind, input.target),
    note: input.note?.trim() || "",
    createdBy: input.createdBy,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    createdAt: now,
    updatedAt: now,
    ...(input.external ? { external: input.external } : {}),
  };
  board.artifacts.push(artifact);
  const event = store.event(board, { taskId: task.id, ...actor, action: "artifact_added", note: artifactNoteLine(artifact) });
  return { artifact, changed: true, eventId: event.id };
}

/** An agent's removal of the plan artifact (`ARTIFACT_FORBIDDEN`, CARD-PLAN-SPEC §6.1). */
export const planRemovalRefused = "This is the card's plan; use flowly_clear_plan.";

/** Removes an artifact; an agent may remove only artifacts agents added (CARD-ARTIFACTS-SPEC §4.1). */
export function dropArtifact(store: BoardStore, board: Board, id: string, by: { createdBy: Artifact["createdBy"]; agentId?: string; taskId?: string }) {
  const artifact = board.artifacts.find((a) => a.id === id && (!by.taskId || a.taskId === by.taskId));
  if (!artifact) throw new Error("This artifact no longer exists.");
  liveCard(board, artifact.taskId);
  if (by.createdBy === "agent" && artifact.createdBy === "human") throw new Error("Only the user can remove artifacts they added.");
  // An agent empties the plan slot with flowly_clear_plan; deleting the file record is the user's (CARD-PLAN-SPEC §6.1).
  if (by.createdBy === "agent" && artifact.plan) throw new Error(planRemovalRefused);
  board.artifacts = board.artifacts.filter((a) => a !== artifact);
  const actor = by.createdBy === "agent" ? { actor: "agent" as const, agentId: by.agentId } : { actor: "human" as const };
  if (artifact.plan) store.event(board, { taskId: artifact.taskId, ...actor, action: "plan_cleared", note: artifact.title });
  const event = store.event(board, {
    taskId: artifact.taskId,
    ...actor,
    action: "artifact_removed",
    note: artifactNoteLine(artifact),
  });
  return { artifact, eventId: event.id };
}

export function editArtifact(store: BoardStore, input: ArtifactEdit) {
  return store.transaction((board) => {
    const artifact = board.artifacts.find((a) => a.id === input.id);
    if (!artifact) throw new Error("This artifact no longer exists.");
    liveCard(board, artifact.taskId);
    if (artifact.updatedAt !== input.updatedAt) throw new Error("This artifact changed. Reload and try again.");
    const next = {
      role: input.role ?? artifact.role,
      title: input.title?.trim() || artifact.title,
      note: input.note !== undefined ? input.note : artifact.note,
    };
    const changed = next.role !== artifact.role || next.title !== artifact.title || next.note !== artifact.note;
    // A person who changes the role or title of a Flowly record takes it over: Flowly stops managing it (REVIEW-LEDGERS-SPEC §3).
    // Targets can't be edited (§3 of CARD-ARTIFACTS-SPEC), and the note is Flowly's summary, reset at the next sync.
    if (artifact.origin && (next.role !== artifact.role || next.title !== artifact.title)) delete artifact.origin;
    if (changed) Object.assign(artifact, next, { updatedAt: new Date().toISOString() });
    return { value: { ...artifact }, changed };
  });
}

const images: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_IMAGE = 8 * 1024 * 1024,
  MAX_TEXT = 256 * 1024,
  MAX_ENTRIES = 200;

export type ArtifactPreview =
  | { type: "image"; dataUri: string }
  | { type: "text"; text: string; markdown: boolean }
  | { type: "directory"; entries: { name: string; directory: boolean }[]; more: boolean }
  | { type: "unsupported"; size: number };

/**
 * Reads a registered file artifact for display (CARD-ARTIFACTS-SPEC §6.2). Only
 * the recorded target is read, and it is checked against the card's
 * directories again (a symlink may have been swapped since it was added).
 */
export async function previewFile(artifact: Artifact, where: ArtifactRoots): Promise<ArtifactPreview> {
  if (artifact.kind !== "file") throw new Error("Links open in the browser.");
  const path = await withinRoots(absoluteTarget(artifact.target, where.workspace), where);
  if (!path) throw new Error("This file no longer exists.");
  const info = await stat(path);
  if (info.isDirectory()) {
    const list = await readdir(path, { withFileTypes: true });
    const sorted = list
      .map((e) => ({ name: e.name, directory: e.isDirectory() }))
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return { type: "directory", entries: sorted.slice(0, MAX_ENTRIES), more: sorted.length > MAX_ENTRIES };
  }
  if (!info.isFile()) return { type: "unsupported", size: 0 };
  const ext = extname(path).toLowerCase();
  if (images[ext]) {
    if (info.size > MAX_IMAGE) return { type: "unsupported", size: info.size };
    const handle = await open(path, "r");
    try {
      return { type: "image", dataUri: `data:${images[ext]};base64,${(await handle.readFile()).toString("base64")}` };
    } finally {
      await handle.close();
    }
  }
  if (info.size > MAX_TEXT) return { type: "unsupported", size: info.size };
  const handle = await open(path, "r");
  try {
    const data = await handle.readFile();
    if (data.includes(0)) return { type: "unsupported", size: info.size };
    return { type: "text", text: data.toString("utf8"), markdown: ext === ".md" || ext === ".markdown" };
  } finally {
    await handle.close();
  }
}

type Paseo = { workspaces: { ref(id: string): { refresh(): Promise<{ workspaceDirectory: string } | null | undefined> } } };

/** Human RPCs for artifacts (CARD-ARTIFACTS-SPEC §3). */
export class ArtifactService {
  constructor(
    readonly store: BoardStore,
    readonly connectors?: ConnectorService,
    /** The extra folders from Settings, read at each use so a change applies at once. */
    private extraFolders: () => Promise<readonly string[]> = async () => [],
  ) {}

  private async extraRoots() {
    return resolveExtraRoots(await this.extraFolders());
  }

  /** The card's directories, from its live workspace when Paseo still knows it. */
  async where(taskId: string, paseo: Paseo, snapshot?: Board): Promise<ArtifactRoots> {
    const board = snapshot || (await this.store.read());
    const task = board.tasks.find((t) => t.id === taskId);
    const project = board.projects.find((p) => p.id === task?.projectId);
    if (!task || !project) throw new Error("Task not found.");
    const workspace = await paseo.workspaces
      .ref(task.workspaceId)
      .refresh()
      .catch(() => null);
    return artifactRoots(task, project, workspace?.workspaceDirectory, await this.extraRoots(), this.store.directory);
  }

  async create(
    input: { taskId: string; role: ArtifactRole; target: string; title?: string; note?: string; external?: { connectionId: string; key: string; itemType?: ItemType } },
    paseo: Paseo,
  ) {
    const { external: picked, ...rest } = input;
    // A picker names its connection; a pasted target is recognized against all of them.
    const external =
      picked && this.connectors
        ? await this.connectors.resolve(picked.connectionId, picked.key, picked.itemType).then((found) => ({ kind: "url" as const, target: found.url, ...found }))
        : await externalArtifact(this.connectors, rest.target);
    const { kind, target } = external || (await normalizeTarget(rest.target, await this.where(rest.taskId, paseo)));
    return this.store.transaction((board) => {
      const { artifact, changed } = putArtifact(this.store, board, {
        ...rest,
        kind,
        target,
        createdBy: "human",
        ...(external ? { external: external.external, title: rest.title?.trim() || external.title } : {}),
      });
      return { value: { ...artifact }, changed };
    });
  }

  update(input: ArtifactEdit) {
    return editArtifact(this.store, input);
  }

  delete(input: { id: string }) {
    return this.store.transaction((board) => ({
      value: { id: dropArtifact(this.store, board, input.id, { createdBy: "human" }).artifact.id },
      changed: true,
    }));
  }

  /** Ids of the card's file artifacts that no longer exist; cached briefly (CARD-ARTIFACTS-SPEC §9). */
  private cache = new Map<string, { at: number; key: string; missing: string[] }>();
  async status(input: { taskId: string }, paseo: Paseo) {
    const board = await this.store.read();
    const list = board.artifacts.filter((a) => a.taskId === input.taskId);
    const key = [...list.map((a) => `${a.id}:${a.target}`), ...(await this.extraRoots())].join("|");
    const hit = this.cache.get(input.taskId);
    if (hit && hit.key === key && Date.now() - hit.at < 15000) return { missing: hit.missing };
    const missing = [...(await missingArtifacts(list, await this.where(input.taskId, paseo, board)))];
    this.cache.set(input.taskId, { at: Date.now(), key, missing });
    return { missing };
  }

  async preview(input: { id: string }, paseo: Paseo) {
    const board = await this.store.read();
    const artifact = board.artifacts.find((a) => a.id === input.id);
    if (!artifact) throw new Error("This artifact no longer exists.");
    return previewFile(artifact, await this.where(artifact.taskId, paseo, board));
  }
}
