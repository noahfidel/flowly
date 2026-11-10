import type { BoardStore } from "./store";
import type { ToolIdentity } from "../shared/tools";
import type { Workpad, WorkpadCheck } from "../shared/model";
import { planFromTimeline, workpadCheckedAction, workpadEnabled } from "../shared/workpad";

/**
 * A person's ticks on a card's acceptance list and the plans read from session timelines (WORKPAD-SPEC §2.2, §6.3,
 * GUARDRAILS-SPEC §7.1). Neither changes the task revision; a tick bumps the workpad revision.
 */
export class WorkpadService {
  constructor(
    readonly store: BoardStore,
    readonly clock = () => Date.now(),
  ) {}

  check(input: WorkpadCheck): Promise<Workpad> {
    return this.store.mutate((board) => {
      const { task, workpad } = editable(board, input.taskId);
      const now = new Date(this.clock()).toISOString();
      const item = workpad.acceptance.find((a) => a.id === input.itemId);
      if (!item) throw new Error("This item is no longer in the workpad.");
      item.done = input.done;
      item.by = "human";
      item.at = now;
      touch(workpad, now);
      this.store.event(board, { taskId: task.id, actor: "human", action: workpadCheckedAction, note: `Acceptance: ${clip(item.text)} → ${item.done ? "met" : "not met"}` });
      return workpad;
    });
  }

  /** A Kanban-managed session finished a turn: keep its latest native todo list as the card's plan (§2.2). */
  async recordTurn(identity: ToolIdentity, timeline: readonly { type: string }[] | undefined) {
    const items = planFromTimeline(timeline);
    if (items === undefined) return;
    const board = await this.store.read();
    // Off for the project: nothing is recorded (WORKPAD-SPEC §9).
    const task = board.tasks.find((t) => t.id === identity.taskId);
    if (!workpadEnabled(board.projects.find((p) => p.id === task?.projectId))) return;
    await this.store.transaction((b) => {
      const task = b.tasks.find((t) => t.id === identity.taskId);
      if (!task || task.workspaceId !== identity.workspaceId) return { value: undefined, changed: false };
      const at = new Date(this.clock()).toISOString();
      const index = b.plans.findIndex((p) => p.taskId === task.id && p.agentId === identity.agentId);
      const previous = index >= 0 ? b.plans[index] : undefined;
      if (!items.length) {
        if (!previous) return { value: undefined, changed: false };
        b.plans.splice(index, 1);
        return { value: undefined, changed: true };
      }
      if (previous && JSON.stringify(previous.items) === JSON.stringify(items)) return { value: undefined, changed: false };
      const plan = { taskId: task.id, agentId: identity.agentId, items, at };
      if (previous) b.plans[index] = plan;
      else b.plans.push(plan);
      return { value: undefined, changed: true };
    });
  }
}

const clip = (text: string) => (text.length > 80 ? `${text.slice(0, 80)}…` : text);

function editable(board: Awaited<ReturnType<BoardStore["read"]>>, taskId: string) {
  const task = board.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error("Task not found.");
  const project = board.projects.find((p) => p.id === task.projectId);
  if (task.archivedAt || project?.archivedAt) throw new Error("Archived cards can't be changed.");
  if (!workpadEnabled(project)) throw new Error("The workpad is turned off for this project.");
  const workpad = board.workpads.find((w) => w.taskId === taskId);
  if (!workpad) throw new Error("This card has no workpad.");
  return { task, workpad };
}

function touch(workpad: Workpad, now: string) {
  workpad.revision++;
  workpad.updatedAt = now;
  workpad.updatedBy = "human";
  delete workpad.agentId;
}
