import type { PaseoApi } from "@getpaseo/client";
import type { Dispatcher, GroupDeleted } from "./dispatcher";
import { logFailure } from "./error-report";
import type { BoardStore } from "./store";
import type { GroupEdit, GroupInput, GroupMembersEdit, GroupRemoval, Group } from "../shared/model";

/** The board group writes of flowly_manage_groups (DISPATCHER-SPEC §5.2): the same store and dispatcher calls as the groups.* RPCs. */
export interface GroupWriter {
  create(input: GroupInput): Promise<Group>;
  update(input: GroupEdit): Promise<Group>;
  /** `set_members`: the members that moved get their pending dispatcher notes moved with them (§7). */
  setMembers(input: GroupMembersEdit): Promise<Group>;
  /** `groups.delete` on the dispatcher's queue; a live session is refused (GROUP_BUSY), never archived by the tool. */
  delete(paseo: PaseoApi, input: GroupRemoval): Promise<GroupDeleted>;
}

export function groupWriter(store: BoardStore, dispatcher: Dispatcher, forgetChanges: (groupId: string) => void): GroupWriter {
  return {
    create: (input) => store.createGroup(input),
    update: (input) => store.updateGroup(input),
    async setMembers(input) {
      const { group, moved } = await store.setGroupMembers(input);
      for (const { projectId, groupId } of moved)
        await dispatcher
          .projectMoved(projectId, groupId)
          .catch((e) => logFailure("Flowly dispatcher notes not moved with their project:", e, projectId));
      return group;
    },
    async delete(paseo, input) {
      const deleted = await dispatcher.deleteGroup(paseo, input, store, { refuseLive: true });
      forgetChanges(deleted.id);
      return deleted;
    },
  };
}
