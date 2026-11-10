import { expect, test } from "vitest";
import { setupContext, setupIncompleteMessage, setupMissing, setupReminder } from "./card-setup";

const tag = { tag: "drawer", by: "human" as const, at: "x" };
const filled = { acceptance: [{ id: "a", text: "Works", done: false, by: "agent" as const, at: "x" }] };
const empty = { acceptance: [] };

test("setupMissing lists type, tags and workpad in a fixed order; anyone's type or tags count", () => {
  expect(setupMissing({}, null, true)).toEqual(["type", "tags", "workpad"]);
  expect(setupMissing({ type: "feature", tags: [tag] }, filled, true)).toEqual([]);
  expect(setupMissing({ type: "docs", tags: [] }, filled, true)).toEqual(["tags"]);
  expect(setupMissing({ tags: [{ ...tag, by: "agent" }] }, filled, true)).toEqual(["type"]);
});

test("no acceptance list is missing; a project without the workpad never misses it", () => {
  expect(setupMissing({ type: "feature", tags: [tag] }, empty, true)).toEqual(["workpad"]);
  // GUARDRAILS-SPEC §6.1: a workpad written before guardrails with only checks or confusions has no acceptance list.
  expect(setupMissing({ type: "feature", tags: [tag] }, { acceptance: [], validation: [{ id: "v" }] } as never, true)).toEqual(["workpad"]);
  expect(setupMissing({ type: "feature", tags: [tag] }, null, false)).toEqual([]);
});

test("setupContext flags and texts name only the missing items", () => {
  expect(setupContext(["tags"], "development")).toEqual({ typeMissing: false, tagsMissing: true, workpadMissing: false, stage: "development", missing: ["tags"] });
  const r = setupReminder(["type", "workpad"]);
  expect(r).toContain("no type (flowly_set_type");
  expect(r).toContain("; no acceptance list (flowly_update_workpad");
  expect(r).not.toContain("flowly_set_tags");
  expect(r).toMatch(/This write already succeeded\.$/);
  expect(setupIncompleteMessage(["tags"])).toMatch(/^Card setup is incomplete: no tags .*acknowledgeOpen=true/);
});
