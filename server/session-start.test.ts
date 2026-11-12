import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { agentFixture } from "./agent-fixture";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

test("the project's New session starting text is saved trimmed, and an empty edit removes it (SESSION-START-TEXT-SPEC §2)", async () => {
  const x = await agentFixture();
  roots.push(x.root);
  const set = await x.store.updateProject({ id: "p", revision: 1, sessionStartText: "  Run the tests, then continue.\n" });
  expect(set.sessionStartText).toBe("Run the tests, then continue.");
  const cleared = await x.store.updateProject({ id: "p", revision: 2, sessionStartText: "   " });
  expect("sessionStartText" in cleared).toBe(false);
  // Other edits leave it alone.
  await x.store.updateProject({ id: "p", revision: 3, sessionStartText: "Go on." });
  const renamed = await x.store.updateProject({ id: "p", revision: 4, title: "Renamed" });
  expect(renamed.sessionStartText).toBe("Go on.");
});
