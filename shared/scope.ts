import { enabledStatuses, laneName } from "./lanes";
import { taskTypeLabels, type Task, type Project } from "./model";
import { switchContextLine } from "./workspace-switch";

export function effectiveRepos(
  task: Pick<Task, "repoPaths">,
  project: Pick<Project, "repos">,
) {
  return task.repoPaths.length ? task.repoPaths : project.repos;
}
export function includesRepo(task: Pick<Task, "repoPaths">, repo: string) {
  return !task.repoPaths.length || task.repoPaths.includes(repo);
}
export function isLegacyScope(
  task: Pick<Task, "repoPaths">,
  project: Pick<Project, "primaryPath" | "repos">,
) {
  return task.repoPaths.length
    ? task.repoPaths.length !== 1 || task.repoPaths[0] !== project.primaryPath
    : project.repos.length > 1;
}
export function sessionContext(
  task: Task,
  project: Project,
  paths: { repo: string; directory: string }[],
  workspaceDirectory: string,
  /** The card's links, one per line (CARD-LINKS-SPEC §4). */
  links: readonly string[] = [],
  /** The card's inputs and outputs, one per line (CARD-ARTIFACTS-SPEC §4.2). */
  artifacts: readonly string[] = [],
  /** "Card setup missing: …" or "" (CARD-SETUP-SPEC §3.2). */
  setupLine = "",
  /** The project memory block (PROJECT-MEMORY-SPEC §6.1). */
  memory: readonly string[] = [],
  /** The Linear ticket block (LINEAR-TICKET-SPEC §3). */
  linear: readonly string[] = [],
) {
  return `Kanban task: ${task.title}\nTask ID: ${task.id}\n${task.type ? `Task type: ${taskTypeLabels[task.type]}\n` : ""}${task.tags?.length ? `Tags: ${task.tags.map((t) => t.tag).join(", ")}\n` : ""}${setupLine ? `${setupLine}\n` : ""}${switchContextLine(task) ? `${switchContextLine(task)}\n` : ""}${links.map((l) => `${l}\n`).join("")}${task.description}\n${artifacts.map((l) => `${l}\n`).join("")}${linear.map((l) => `${l}\n`).join("")}${memory.map((l) => `${l}\n`).join("")}Project: ${project.title}\nLanes (this project's workflow): ${enabledStatuses(project).map((s) => `${laneName(project, s)} [${s}]`).join(" → ")}\nNative Paseo project root: ${project.primaryPath}\n${isLegacyScope(task, project) ? "Legacy card scope retained from the previous board version." : "Project-root task scope."}${project.links?.length ? `\nLinked repositories (symlinks in the project root -> real directories; they are part of this task's directories):\n${project.links.map((l) => `${l.name} -> ${l.target}`).join("\n")}` : ""}\nWork directories for this task:\n${paths.map((p) => `${p.repo} -> ${p.directory}`).join("\n")}\nWorkspace starting directory: ${workspaceDirectory}\nWork only in the listed task directories. A common project root can contain multiple child repositories managed by the user. A worktree isolates only the Git project root. Provider permissions still apply; report denied access. Card business status is independent of session status.`;
}
