import { expect, test } from "vitest";
import { showsSubagents, taskCardLabel } from "./card-label";

const base = {
  title: "Add rate limiting to POST /shorten",
  lane: "Todo",
  questions: 0,
  ideas: 0,
  waiting: 0,
  waitingTitles: "",
  progress: null,
  workpad: null,
  attentionSnoozed: false,
  priority: "high",
  type: "feature",
  archivedAt: null,
  legacy: false,
  summaryState: "ready",
  summary: undefined,
  output: null,
  outputTime: "",
} as const;

test("the accessible name starts with the title and names the lane (automation names)", () => {
  const label = taskCardLabel({ ...base });
  expect(label.startsWith("Open task Add rate limiting to POST /shorten. Todo.")).toBe(true);
});

test("a snoozed card says so (ATTENTION-DISMISS-SPEC, Card and sidebar)", () => {
  expect(taskCardLabel({ ...base })).not.toContain("Snoozed");
  expect(taskCardLabel({ ...base, attentionSnoozed: true })).toContain("Snoozed.");
});

test("the lane segment is omitted when no lane is known", () => {
  expect(taskCardLabel({ ...base, lane: undefined })).not.toContain("Todo.");
});

test("empty signals stay out of the label; present ones appear in order", () => {
  const quiet = taskCardLabel({ ...base });
  expect(quiet).not.toContain("Needs you");
  expect(quiet).not.toContain("Waiting on");

  const busy = taskCardLabel({
    ...base,
    lane: "Development",
    questions: 2,
    waiting: 1,
    waitingTitles: "Fix the login crash",
  });
  const titleAt = busy.indexOf("Open task Add rate limiting");
  const laneAt = busy.indexOf("Development.");
  const questionsAt = busy.indexOf("Needs you: 2 open questions");
  const waitingAt = busy.indexOf("Waiting on 1 card: Fix the login crash");
  expect([titleAt, laneAt, questionsAt, waitingAt].every((at) => at >= 0)).toBe(true);
  expect(titleAt).toBeLessThan(laneAt);
  expect(laneAt).toBeLessThan(questionsAt);
  expect(questionsAt).toBeLessThan(waitingAt);
});

test("priority and type ride in one comma-joined segment", () => {
  const label = taskCardLabel({ ...base, priority: "urgent", type: "bugfix" });
  expect(label).toContain("Urgent priority, Bug fix");
});

test("the label names working subagents exactly when the card's signals show them (SUBAGENTS-SPEC §10)", () => {
  const idle = { total: 1, running: 0, starting: 0, finished: 0, unread: 0, attention: 0, permissions: 0, questions: 0, errors: 0, unknownRead: 0 };
  const card = { ...base, subagents: 2, available: true, running: 0, sessions: 1 };
  expect(taskCardLabel({ ...card, summary: idle })).toContain("2 subagents working.");
  // Last known state still shows them, and so does the count-only fallback.
  expect(taskCardLabel({ ...card, summaryState: "stale", summary: idle })).toContain("2 subagents working.");
  expect(taskCardLabel({ ...card, summary: undefined })).toContain("2 subagents working.");
  // Not while loading, unavailable, with the workspace gone, or with a session running.
  expect(taskCardLabel({ ...card, summaryState: "loading", summary: idle })).not.toContain("subagent");
  expect(taskCardLabel({ ...card, summaryState: "unavailable" })).not.toContain("subagent");
  expect(taskCardLabel({ ...card, available: false, summary: idle })).not.toContain("subagent");
  expect(taskCardLabel({ ...card, summary: { ...idle, running: 1 } })).not.toContain("subagent");
  expect(showsSubagents({ subagents: 0, available: true, summaryState: "ready", summary: idle, running: 0, sessions: 1 })).toBe(false);
});
