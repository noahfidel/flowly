import type { PaseoApi } from "@getpaseo/client";
import type { BoardStore } from "./store";
import { paseoHome } from "./service";
import { resolvePaseoCli, runPaseo } from "./paseo-cli";

type Run = (file: string, args: string[]) => Promise<string>;
const defaultRun: Run = (file, args) => runPaseo(args, { timeout: 20000, maxBuffer: 1 << 20 }, file);

export type SessionSettingsInput = {
  taskId: string;
  agentId: string;
  thinkingOptionId?: string;
  modeId?: string;
  stop?: boolean;
  title?: string;
};

export type DispatcherSettingsInput = Omit<SessionSettingsInput, "taskId" | "title"> & { groupId: string };

/** Validated, card-scoped session setting changes for Kanban sessions, and the same for a group's dispatcher. */
export class SessionSettingsService {
  /** A group's stored dispatcher session and its workspace (DISPATCHER-SPEC §9.3); null while there is none. Set by the plugin entry. */
  dispatcher: (groupId: string) => Promise<{ agentId: string; workspaceId: string } | null> = async () => null;
  constructor(
    readonly store: BoardStore,
    readonly run: Run = defaultRun,
    readonly cli: () => Promise<string> = () => resolvePaseoCli(),
  ) {}

  async apply({ taskId, ...input }: SessionSettingsInput, paseo: PaseoApi) {
    const board = await this.store.read();
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("Task not found.");
    return this.applyIn(task.workspaceId, input, paseo);
  }

  /**
   * `dispatcher.configure` (DISPATCHER-SPEC §9.3; Ruling, Noah 2026-11-11): the same changes, only for the group's
   * stored dispatcher session in its stored workspace; any other session is refused. The guard is the stored start
   * mark (§3), so a mode change here never makes it unguarded.
   */
  async dispatcherApply({ groupId, ...input }: DispatcherSettingsInput, paseo: PaseoApi) {
    const own = await this.dispatcher(groupId);
    if (!own || own.agentId !== input.agentId) throw new Error("This session is not the dispatcher.");
    return this.applyIn(own.workspaceId, input, paseo);
  }

  private async applyIn(workspaceId: string, input: Omit<SessionSettingsInput, "taskId">, paseo: PaseoApi) {
    const snapshot = await paseo.agents.ref(input.agentId).refresh();
    const agent = snapshot?.agent;
    if (!agent || agent.workspaceId !== workspaceId)
      throw new Error("Session is unavailable or belongs to a different workspace.");
    if (agent.archivedAt) throw new Error("Restore the session before changing its settings.");
    if (input.modeId && !agent.availableModes?.some((m) => m.id === input.modeId))
      throw new Error("That permission mode is not available for this session.");
    const bin = await this.cli();
    const home = ["--home", paseoHome()];
    const applied: string[] = [];
    if (input.stop) {
      await this.run(bin, ["agent", "stop", agent.id, ...home]);
      applied.push("stopped");
    }
    if (input.title !== undefined) {
      // One `--name=` argument: a title starting with "-" is never read as an option.
      await this.run(bin, ["agent", "update", agent.id, `--name=${input.title}`, ...home]);
      applied.push("title");
    }
    if (input.thinkingOptionId) {
      await this.run(bin, ["agent", "update", agent.id, "--thinking", input.thinkingOptionId, ...home]);
      applied.push("reasoning");
    }
    if (input.modeId) {
      await this.run(bin, ["agent", "mode", agent.id, input.modeId, ...home]);
      applied.push("permissions");
    }
    return { applied };
  }
}
