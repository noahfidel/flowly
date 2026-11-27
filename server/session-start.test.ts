import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { agentFixture } from "./agent-fixture";
import { projectEdit } from "../shared/model";

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

test("a Start prompt that does not parse, or is over the cap, is refused and the project keeps its text; the cap is on the trimmed text (START-PROMPT-TEMPLATE-SPEC §5)", async () => {
  const x = await agentFixture();
  roots.push(x.root);
  await x.store.updateProject({ id: "p", revision: 1, sessionStartText: "Keep." });
  await expect(x.store.updateProject({ id: "p", revision: 2, sessionStartText: "a\n{{#if planApproved}}open" })).rejects.toThrow("Start prompt: Unclosed {{#if}} (line 2)");
  await expect(x.store.updateProject({ id: "p", revision: 2, sessionStartText: "x".repeat(4001) })).rejects.toThrow(/4000/);
  expect((await x.store.read()).projects[0].sessionStartText).toBe("Keep.");
  // Exactly the cap fits, also with surrounding whitespace.
  const full = await x.store.updateProject({ id: "p", revision: 2, sessionStartText: `  ${"x".repeat(4000)}\n` });
  expect(full.sessionStartText).toHaveLength(4000);
});

test("the projects.update schema refuses a Start prompt that does not parse, naming the line", async () => {
  const bad = projectEdit.safeParse({ id: "p", revision: 1, sessionStartText: "{{nope}}" });
  expect(bad.success ? "" : bad.error.issues[0].message).toBe('Start prompt: Unknown variable "nope" (line 1)');
  expect(projectEdit.safeParse({ id: "p", revision: 1, sessionStartText: "{{title}}" }).success).toBe(true);
});

test("the projects.update schema caps the trimmed Start prompt, as the store does", () => {
  expect(projectEdit.safeParse({ id: "p", revision: 1, sessionStartText: `  ${"x".repeat(4000)}\n` }).success).toBe(true);
  expect(projectEdit.safeParse({ id: "p", revision: 1, sessionStartText: "x".repeat(4001) }).success).toBe(false);
});
