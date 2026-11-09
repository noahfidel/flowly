import { expect, test } from "vitest";
import { sessionContext } from "./scope";
import { deliveryLine } from "./delivery-mode";
import { setupContextLine, setupMissing } from "./card-setup";
import type { Project, Task } from "./model";

const project = { id: "p", title: "P", primaryPath: "/r", repos: ["/r"] } as Project;
const task = { id: "t", title: "Fix login", description: "Steps", repoPaths: [] } as unknown as Task;

test("session context names the task type only when the card has one", () => {
  const paths = [{ repo: "/r", directory: "/r" }];
  expect(sessionContext(task, project, paths, "/r")).not.toContain("Task type:");
  expect(sessionContext({ ...task, type: "bugfix" }, project, paths, "/r")).toContain("Task ID: t\nTask type: Bug fix\nSteps");
});

test("session context lists the card's tags only when it has some", () => {
  const paths = [{ repo: "/r", directory: "/r" }];
  expect(sessionContext(task, project, paths, "/r")).not.toContain("Tags:");
  const tagged = { ...task, type: "bugfix", tags: [{ tag: "drawer", by: "human", at: "x" }, { tag: "perf", by: "agent", at: "x" }] } as Task;
  expect(sessionContext(tagged, project, paths, "/r")).toContain("Task type: Bug fix\nTags: drawer, perf\nSteps");
});

test("session context names missing card setup, and only what is missing (CARD-SETUP-SPEC §3.2)", () => {
  const paths = [{ repo: "/r", directory: "/r" }];
  const typed = { ...task, type: "bugfix" } as Task;
  const line = setupContextLine(setupMissing(typed, null, true));
  expect(line).toMatch(/^Card setup missing: tags, workpad\. /);
  expect(line).not.toContain("flowly_set_type");
  expect(sessionContext(typed, project, paths, "/r", [], [], line)).toContain(`Task type: Bug fix\n${line}\nSteps`);
  expect(setupContextLine([])).toBe("");
  expect(sessionContext(typed, project, paths, "/r", [], [], "")).not.toContain("Card setup missing");
});

test("session context names the card's delivery mode", () => {
  const paths = [{ repo: "/r", directory: "/r" }];
  const lineOf = (mode: string) => sessionContext({ ...task, deliveryMode: mode } as Task, project, paths, "/r").split("\n").find((l) => l.startsWith("Delivery:"));
  expect(lineOf("branch")).toBe(deliveryLine("branch"));
  expect(lineOf("draft_pr")).toBe(deliveryLine("draft_pr"));
  expect(lineOf("ready_pr")).toBe(deliveryLine("ready_pr"));
  // The last line, after the scope and permission notes.
  expect(sessionContext({ ...task, deliveryMode: "ready_pr" } as Task, project, paths, "/r").endsWith(`\n${deliveryLine("ready_pr")}`)).toBe(true);
});

test("a card without a mode uses the default", () => {
  const paths = [{ repo: "/r", directory: "/r" }];
  expect(sessionContext(task, project, paths, "/r")).toContain(deliveryLine("branch"));
  expect(sessionContext(task, project, paths, "/r", [], [], "", [], [], "draft_pr")).toContain(deliveryLine("draft_pr"));
  expect(sessionContext({ ...task, deliveryMode: "ready_pr" } as Task, project, paths, "/r", [], [], "", [], [], "draft_pr")).toContain(deliveryLine("ready_pr"));
});

test("an unknown stored mode is treated as the default", () => {
  const paths = [{ repo: "/r", directory: "/r" }];
  const text = sessionContext({ ...task, deliveryMode: "from_the_future" } as unknown as Task, project, paths, "/r", [], [], "", [], [], "draft_pr");
  expect(text).toContain(deliveryLine("draft_pr"));
  expect(text).not.toContain("from_the_future");
});
