import type { PaseoApi } from "@getpaseo/client";
import { isResolved, linksOf } from "../shared/links";
import type { Board, BranchedFrom, FollowUpBase, Project, Task } from "../shared/model";
import { baseRefProblem } from "../shared/worktree-base";
import { branchAhead, projectWorktreeBase, refResolves, remoteBase, worktreeBranch } from "./base-ref";
import { logFailure } from "./error-report";
import { ToolError } from "./tool-error";

/**
 * Where a follow-up card's new worktree branches from (START-CARD-SPEC §11): the project's base, or an open parent
 * card's branch when that parent has commits the base lacks. Used by flowly_start_card and flowly_create_card only.
 */

/** The project's choice; absent (and anything unknown) reads as "parent" (§11.1). */
export const followUpSetting = (project: Pick<Project, "followUpBase">): FollowUpBase =>
  project.followUpBase === "base" || project.followUpBase === "ask" ? project.followUpBase : "parent";

/** A ref as people write it: `main`, `origin/dev`. */
export const shortRef = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");

const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

/** Why a tool's `baseRef` is refused (BASE_INVALID), or null; "parent" is always valid (§11.5). */
export function baseChoiceProblem(value: string | undefined): string | null {
  const ref = value?.trim();
  if (ref === undefined || ref === "parent") return null;
  if (!ref || baseRefProblem(ref)) return `baseRef ${JSON.stringify(value)} is not "parent" or a valid branch name.`;
  return null;
}

/**
 * The open parents of a card (§11.2): the other ends of its follow_up_of links, plus `extra` (the card a new card is
 * created as a follow-up of). Done, Cancelled, archived and missing parents do not count.
 */
export function openParents(board: Pick<Board, "links" | "tasks">, taskId: string | null, extra?: string): Task[] {
  const ids = new Set<string>(taskId ? linksOf(board, taskId).filter((v) => v.relation === "follow_up_of").map((v) => v.link.to) : []);
  if (extra) ids.add(extra);
  return [...ids].map((id) => board.tasks.find((t) => t.id === id)).filter((t): t is Task => !!t && !isResolved(t));
}

/** How the branch is made (§11.3): the ref it branches off, the base the card stores, and why. */
export type BaseChoice = {
  /** `refName` of the branch-off request. */
  refName: string;
  /** `Task.baseRef`: the project base when branched from a parent, else `refName` (§11.4). */
  taskBaseRef: string;
  from: "explicit" | "parent" | "project";
  branchedFrom?: BranchedFrom;
  warnings: string[];
};

type ParentBranch = { task: Task; branch: string };
type Measured = ParentBranch & { ahead: number; commit: string };

/** Each parent's branch (§11.2): only a worktree of the same repository on a named branch has one. */
async function parentBranches(parents: readonly Task[], root: string, paseo: PaseoApi, warnings: string[]): Promise<ParentBranch[]> {
  const found: ParentBranch[] = [];
  for (const task of parents) {
    const branch = await branchOf(task, root, paseo).catch((e: unknown) => {
      logFailure("Flowly follow-up parent branch not read:", e, `card ${task.id} workspace ${task.workspaceId}`);
      warnings.push(`The workspace of parent "${task.title}" could not be read; its branch was not considered.`);
      return null;
    });
    if (branch) found.push({ task, branch });
  }
  return found;
}

async function branchOf(task: Task, root: string, paseo: PaseoApi) {
  const workspace = await paseo.workspaces.ref(task.workspaceId).refresh();
  if (!workspace) throw new Error("workspace not found");
  if (workspace.workspaceKind !== "worktree" || !workspace.workspaceDirectory) return null;
  return worktreeBranch(workspace.workspaceDirectory, root);
}

async function measure(root: string, base: string, parent: ParentBranch, warnings: string[]): Promise<Measured | null> {
  try {
    return { ...parent, ...(await branchAhead(root, base, parent.branch)) };
  } catch (e) {
    logFailure("Flowly follow-up parent branch not compared:", e, `card ${parent.task.id} branch ${parent.branch}`);
    warnings.push(`Parent "${parent.task.title}" (${parent.branch}) could not be compared with ${shortRef(base)}; its branch was not considered.`);
    return null;
  }
}

const fromParent = (p: Measured, base: string, from: BaseChoice["from"], warnings: string[]): BaseChoice => ({
  refName: `refs/heads/${p.branch}`,
  taskBaseRef: base,
  from,
  branchedFrom: { taskId: p.task.id, branch: p.branch, commit: p.commit, ahead: p.ahead },
  warnings,
});

/** BASE_CHOICE_NEEDED naming each parent ahead (§11.3). */
function choiceNeeded(ahead: readonly Measured[], base: string) {
  const named = ahead.map((p) => `Parent "${p.task.title}" (${p.branch}) has ${commits(p.ahead)} not in ${shortRef(base)}.`).join(" ");
  const how = ahead.length === 1 ? '"parent" or a branch' : "one of these branches, or another branch";
  return new ToolError("BASE_CHOICE_NEEDED", `${named} Ask the user where to branch from and pass baseRef (${how}).`);
}

/**
 * The decision of §11.3, first match wins: an explicit `baseRef`, no parent ahead, then the project's setting. Throws
 * BASE_CHOICE_NEEDED or BASE_INVALID before anything is made. `projectBase` resolves the project's base (§4.1) and
 * throws the caller's own error when it can't.
 */
export async function chooseBase(options: {
  project: Project;
  root: string;
  parents: readonly Task[];
  explicit?: string;
  /** The user's own Start again: "ask" acts as "base", the user is the one who would be asked. */
  human?: boolean;
  projectBase: () => Promise<string>;
  paseo: PaseoApi;
}): Promise<BaseChoice> {
  const { project, root, paseo } = options;
  const warnings: string[] = [];
  const branches = options.parents.length ? await parentBranches(options.parents, root, paseo, warnings) : [];
  const explicit = options.explicit?.trim();
  if (explicit === "parent") {
    if (branches.length !== 1)
      throw new ToolError(
        "BASE_CHOICE_NEEDED",
        branches.length
          ? `The card has ${branches.length} open parent cards with a branch (${branches.map((b) => `"${b.task.title}" on ${b.branch}`).join(", ")}). Pass one of their branches as baseRef.`
          : 'The card has no open parent card with a branch, so baseRef "parent" has nothing to branch from. Pass a branch as baseRef, or leave it out for the project\'s base.',
      );
    const base = await options.projectBase();
    const measured = await measure(root, base, branches[0], warnings);
    if (!measured) throw new ToolError("BASE_CHOICE_NEEDED", `${warnings.at(-1)} Pass a branch as baseRef, or leave it out for the project's base.`);
    return fromParent(measured, base, "explicit", warnings);
  }
  if (explicit) {
    const named = branches.find((b) => explicit === b.branch || explicit === `refs/heads/${b.branch}`);
    if (named) {
      const base = await options.projectBase();
      const measured = await measure(root, base, named, warnings);
      if (measured) return fromParent(measured, base, "explicit", warnings);
    }
    let ref: string;
    try {
      ref = await projectWorktreeBase(root, project.baseRef, explicit);
    } catch (e) {
      throw new ToolError("BASE_INVALID", `baseRef ${explicit} was not found: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!remoteBase(ref) && !(await refResolves(root, ref))) throw new ToolError("BASE_INVALID", `baseRef ${explicit} is not a branch or commit in this repository.`);
    return { refName: ref, taskBaseRef: ref, from: "explicit", warnings };
  }
  const base = await options.projectBase();
  const onBase = { refName: base, taskBaseRef: base, from: "project" as const };
  const ahead: Measured[] = [];
  for (const b of branches) {
    const m = await measure(root, base, b, warnings);
    if (m && m.ahead > 0) ahead.push(m);
  }
  if (!ahead.length) return { ...onBase, warnings };
  const setting = followUpSetting(project);
  if (setting === "parent") {
    if (ahead.length === 1) return fromParent(ahead[0], base, "parent", warnings);
    throw choiceNeeded(ahead, base);
  }
  if (setting === "ask" && !options.human) throw choiceNeeded(ahead, base);
  return {
    ...onBase,
    warnings: [...warnings, ...ahead.map((p) => `Parent "${p.task.title}" has ${commits(p.ahead)} not in ${shortRef(base)}; the card branched from ${shortRef(base)}.`)],
  };
}

/** The session's extra first-message line for a card branched from its parent (§11.4). */
export function rebaseLine(branchedFrom: BranchedFrom, parentTitle: string, baseRef: string) {
  const base = shortRef(baseRef);
  return `This card branched from ${branchedFrom.branch} (card "${parentTitle}"), which has ${commits(branchedFrom.ahead)} not in ${base}. Before shipping, rebase onto ${base} once the parent has landed: git rebase --onto ${base} ${branchedFrom.commit}.`;
}
