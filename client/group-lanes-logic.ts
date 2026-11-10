import { laneKey } from "../shared/group-lanes";
import type { Lane } from "../shared/model";

/**
 * The group settings page's lane editor (BOARD-GROUPS-SPEC §5): `seed` is the group's lanes the edits started from,
 * `draft` the edited list. Lanes are compared by content, so a revision bump that leaves them unchanged (a rename, a
 * defaults change, a project move) neither drops the edits nor blocks Save.
 */
export type LaneEditState = { seed: Lane[]; draft: Lane[] };

export const laneEdit = (lanes: Lane[]): LaneEditState => ({ seed: lanes, draft: lanes });

export const laneEditDirty = (state: LaneEditState) => laneKey(state.draft) !== laneKey(state.seed);

/**
 * The group's lanes as the server has them now. Unchanged: nothing happens. The saved edits came back, or nothing is
 * edited: reseed. Edited and changed elsewhere: the edits stay; Save reports the conflict (`laneEditSave`).
 */
export function laneEditServer(state: LaneEditState, server: Lane[]): LaneEditState {
  if (laneKey(server) === laneKey(state.seed)) return state;
  if (!laneEditDirty(state) || laneKey(server) === laneKey(state.draft)) return laneEdit(server);
  return state;
}

/**
 * Save: refused once when the server's lanes differ from the seed (changed elsewhere since editing began); the seed
 * moves to the server's lanes and the edits stay, so a second Save is a deliberate overwrite.
 */
export function laneEditSave(state: LaneEditState, server: Lane[]): { kind: "save"; lanes: Lane[] } | { kind: "conflict"; next: LaneEditState } {
  if (laneKey(server) !== laneKey(state.seed)) return { kind: "conflict", next: { seed: server, draft: state.draft } };
  return { kind: "save", lanes: state.draft };
}
