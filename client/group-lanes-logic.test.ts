import { describe, expect, test } from "vitest";
import { laneEdit, laneEditDirty, laneEditSave, laneEditServer } from "./group-lanes-logic";
import { statuses, type Lane, type Status } from "../shared/model";

/** The group settings page's lane editor state (BOARD-GROUPS-SPEC §5). */

const lanes = (on: (s: Status) => boolean): Lane[] => statuses.map((status) => ({ status, enabled: on(status) }));
const all = lanes(() => true);
const noBacklog = lanes((s) => s !== "backlog");
const noBlocked = lanes((s) => s !== "blocked");

describe("group lane editor", () => {
  test("starts clean from the group's lanes", () => {
    const state = laneEdit(all);
    expect(laneEditDirty(state)).toBe(false);
    expect(laneEditDirty({ ...state, draft: noBacklog })).toBe(true);
  });
  test("a server change with no edits reseeds", () => {
    const next = laneEditServer(laneEdit(all), noBlocked);
    expect(next).toEqual(laneEdit(noBlocked));
  });
  test("the same lanes again (a revision bump for something else) keep the edits and let Save through", () => {
    const edited = { ...laneEdit(all), draft: noBacklog };
    // Key order differs, content is the same.
    const same = all.map((l) => ({ enabled: l.enabled, status: l.status }));
    const kept = laneEditServer(edited, same);
    expect(kept).toBe(edited);
    expect(laneEditSave(kept, same)).toEqual({ kind: "save", lanes: noBacklog });
  });
  test("a server change while edited keeps the edits; Save is refused once, then overwrites deliberately", () => {
    const edited = { ...laneEdit(all), draft: noBacklog };
    const kept = laneEditServer(edited, noBlocked);
    expect(kept.draft).toEqual(noBacklog);
    const first = laneEditSave(kept, noBlocked);
    expect(first.kind).toBe("conflict");
    if (first.kind !== "conflict") return;
    expect(first.next.draft).toEqual(noBacklog);
    expect(laneEditDirty(first.next)).toBe(true);
    expect(laneEditSave(first.next, noBlocked)).toEqual({ kind: "save", lanes: noBacklog });
  });
  test("the saved lanes coming back reseed, so the editor is clean again", () => {
    const edited = { ...laneEdit(all), draft: noBacklog };
    const next = laneEditServer(edited, noBacklog);
    expect(laneEditDirty(next)).toBe(false);
    expect(next).toEqual(laneEdit(noBacklog));
  });
});
