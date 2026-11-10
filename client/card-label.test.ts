import { expect, test } from "vitest";
import { taskCardLabel } from "./card-label";

const base = {
  title: "Add rate limiting to POST /shorten",
  lane: "Todo",
  questions: 0,
  ideas: 0,
  waiting: 0,
  waitingTitles: "",
  progress: null,
  workpad: null,
  attentionDismissed: false,
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
