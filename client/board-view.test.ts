import { expect, test } from "vitest";
import { saveMerged } from "./board-view";
import { boardViewValues, type BoardView } from "../shared/settings";

/** A settings document whose revision another writer can bump. */
function store(initial: Partial<BoardView>) {
  let doc = boardViewValues(initial);
  let revision = 1;
  let shown = { values: doc, revision: String(revision) };
  const api = {
    get state() {
      return {
        status: "ready",
        values: shown.values,
        revision: shown.revision,
        save: async (values: BoardView, rev: string) => {
          if (rev !== String(revision)) return false;
          doc = values;
          revision++;
          shown = { values: doc, revision: String(revision) };
          return true;
        },
        reload: async () => {
          shown = { values: doc, revision: String(revision) };
        },
      };
    },
    /** Another part of the plugin saves without this reader noticing. */
    external(patch: Partial<BoardView>) {
      doc = { ...doc, ...patch };
      revision++;
    },
    get doc() {
      return doc;
    },
  };
  return api;
}

test("a stale save is merged into the latest values instead of being lost", async () => {
  const s = store({ boardSort: "manual" });
  s.external({ sendBehavior: "queue" }); // our view is now one revision behind
  expect(await saveMerged(() => s.state, { boardSort: "priority" }, async () => undefined)).toBe(true);
  expect(s.doc).toMatchObject({ boardSort: "priority", sendBehavior: "queue" });
});

test("an unchanged value does not write", async () => {
  const s = store({ boardSort: "title" });
  const before = s.state.revision;
  expect(await saveMerged(() => s.state, { boardSort: "title" }, async () => undefined)).toBe(true);
  expect(s.state.revision).toBe(before);
});

// BOARD-GROUPS-SPEC §7 step 1: the migration reads the v1 `boardGroups` from the stored file, which the typed schema
// no longer has. A save of another field must keep it (and any other key this version does not know) in place.
test("a save keeps stored keys the schema does not know, such as the legacy boardGroups", async () => {
  const s = store({ boardSort: "manual" });
  const legacy = [{ id: "g1", name: "Work", projectIds: ["p1"] }];
  s.external({ boardGroups: legacy, futureKey: 7 } as unknown as Partial<BoardView>);
  await s.state.reload();
  expect(await saveMerged(() => s.state, { boardSort: "priority" }, async () => undefined)).toBe(true);
  expect(s.doc).toMatchObject({ boardSort: "priority", boardGroups: legacy, futureKey: 7 });
});
