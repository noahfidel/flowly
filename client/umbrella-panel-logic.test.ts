import { expect, test } from "vitest";
import type { UmbrellaEntry } from "../shared/model";
import type { UmbrellaMember, UmbrellaSummary } from "../shared/umbrella";
import {
  acceptanceInput, editAfterSave, editBase, errorCode, feedRows, listedUmbrellas, memberInput, moveMember, openQuestions, pickableCards, pipelineRows, revisionToSend, umbrellaWritable,
} from "./umbrella-panel-logic";

const member = (title: string, order?: number): UmbrellaMember => ({
  taskId: title, projectId: "p", projectTitle: "P", title, status: "todo", laneName: "Todo", archived: false, ...(order === undefined ? {} : { order }),
});
const human = { kind: "human" as const };
const entry = (id: string, kind: UmbrellaEntry["kind"], status: UmbrellaEntry["status"], minute: number): UmbrellaEntry => ({
  id, umbrellaId: "u", kind, title: id, body: "", status, by: human,
  createdAt: `2026-11-25T10:${String(minute).padStart(2, "0")}:00.000Z`, updatedAt: `2026-11-25T10:${String(minute).padStart(2, "0")}:00.000Z`,
});
const summary = (id: string, over: Partial<UmbrellaSummary> = {}): UmbrellaSummary => ({
  id, groupId: "g", title: id, status: "open", members: 0, openQuestions: 0, pendingChanges: 0, revision: 1, feedRevision: 0, archivedAt: null, ...over,
});

test("pipeline sorts by order then title", () => {
  const rows = pipelineRows([member("Zeta"), member("Beta", 2), member("Alpha", 2), member("Gamma", 1), member("Delta")]);
  expect(rows.map((r) => r.title)).toEqual(["Gamma", "Alpha", "Beta", "Delta", "Zeta"]);
});

test("feed filters by kind and hides superseded", () => {
  const entries = [
    entry("old-decision", "decision", "superseded", 1),
    entry("decision", "decision", "active", 2),
    entry("question", "question", "open", 3),
    entry("withdrawn", "finding", "withdrawn", 4),
    entry("answered", "question", "answered", 5),
    entry("ruling", "ruling", "active", 6),
  ];
  expect(feedRows(entries, "all").map((e) => e.id)).toEqual(["ruling", "answered", "question", "decision"]);
  expect(feedRows(entries, "decision").map((e) => e.id)).toEqual(["decision"]);
  expect(feedRows(entries, "question").map((e) => e.id)).toEqual(["answered", "question"]);
  // Asked for: superseded and withdrawn come back.
  expect(feedRows(entries, "decision", { closed: true }).map((e) => e.id)).toEqual(["decision", "old-decision"]);
  expect(feedRows(entries, "all", { closed: true })).toHaveLength(6);
});

test("open questions list only open questions", () => {
  const entries = [
    entry("q2", "question", "open", 5),
    entry("answered", "question", "answered", 2),
    entry("finding", "finding", "active", 3),
    entry("q1", "question", "open", 1),
    entry("superseded", "question", "superseded", 4),
  ];
  // Oldest first: the order they were asked in.
  expect(openQuestions(entries).map((e) => e.id)).toEqual(["q1", "q2"]);
});

test("the list shows the group's open umbrellas and, apart, the closed ones; archived ones leave it", () => {
  const all = [
    summary("b", { title: "Beta" }),
    summary("a", { title: "Alpha" }),
    summary("c", { title: "Closed", status: "closed" }),
    summary("x", { title: "Archived", status: "closed", archivedAt: "2026-11-25T00:00:00.000Z" }),
    summary("o", { title: "Other group", groupId: "h" }),
  ];
  const listed = listedUmbrellas(all, "g");
  expect(listed.open.map((u) => u.id)).toEqual(["a", "b"]);
  expect(listed.closed.map((u) => u.id)).toEqual(["c"]);
});

test("only an open, unarchived umbrella takes writes", () => {
  expect(umbrellaWritable({ status: "open", archivedAt: null })).toBe(true);
  expect(umbrellaWritable({ status: "closed", archivedAt: null })).toBe(false);
  expect(umbrellaWritable({ status: "closed", archivedAt: "2026-11-25T00:00:00.000Z" })).toBe(false);
});

test("a refusal's code is read from its message", () => {
  expect(errorCode(new Error("REVISION_CONFLICT: the umbrella changed"))).toBe("REVISION_CONFLICT");
  expect(errorCode(new Error("UMBRELLA_CLOSED: closed"))).toBe("UMBRELLA_CLOSED");
  expect(errorCode(new Error("Network down"))).toBeNull();
  expect(errorCode("nope")).toBeNull();
});

test("acceptance edits send the whole list, trimmed, without empty items", () => {
  const items = [
    { id: "a1", text: " Works end to end ", done: true },
    { text: "  ", done: false },
    { text: "New item", done: false },
  ];
  expect(acceptanceInput(items)).toEqual([
    { id: "a1", text: "Works end to end", done: true },
    { text: "New item", done: false },
  ]);
});

test("an editor sends the revision it was opened on, not the umbrella's current one", () => {
  // Edit opened on revision 3; the dispatcher's edit moved the umbrella to 4 meanwhile: the save still sends 3, so it is refused.
  const base = editBase(3);
  expect(revisionToSend(base)).toBe(3);
  // Refused: the editor stays open, now based on the reloaded revision, so a second Save replaces the other edit on purpose.
  const after = editAfterSave(base, { status: "conflict", revision: 4 });
  expect(after).toEqual({ revision: 4, replace: true });
  expect(revisionToSend(after!)).toBe(4);
  // Saved: the editor closes. Failed for another reason: unchanged.
  expect(editAfterSave(after!, { status: "saved" })).toBeNull();
  expect(editAfterSave(base, { status: "failed" })).toBe(base);
});

test("a member change keeps the role and order it does not change", () => {
  const m = { taskId: "t", role: "map", order: 2 };
  expect(memberInput("u", m, {})).toEqual({ taskId: "t", umbrellaId: "u", role: "map", order: 2 });
  expect(memberInput("u", m, { role: " scorer " })).toEqual({ taskId: "t", umbrellaId: "u", role: "scorer", order: 2 });
  // An empty role clears it; an order change keeps the role.
  expect(memberInput("u", m, { role: "  " })).toEqual({ taskId: "t", umbrellaId: "u", order: 2 });
  expect(memberInput("u", { taskId: "t" }, { order: 1 })).toEqual({ taskId: "t", umbrellaId: "u", order: 1 });
});

test("moving a member renumbers the pipeline and changes only the orders that differ", () => {
  const rows = pipelineRows([member("A", 1), member("B", 2), member("C"), member("D")]);
  // C has no order: moving it up puts it before B; A keeps 1, B becomes 3, C gets 2, D gets 4.
  expect(moveMember(rows, "C", -1)).toEqual([
    { taskId: "C", order: 2 },
    { taskId: "B", order: 3 },
    { taskId: "D", order: 4 },
  ]);
  expect(moveMember(rows, "A", -1)).toEqual([]);
  expect(moveMember(rows, "D", 1)).toEqual([]);
  expect(moveMember(rows, "missing", 1)).toEqual([]);
});

test("the picker offers the group's live cards not in this umbrella, and says when a card moves", () => {
  const projects = [
    { id: "p1", title: "App", groupId: "g", archivedAt: null },
    { id: "p2", title: "Api", groupId: "g", archivedAt: null },
    { id: "p3", title: "Other", groupId: "h", archivedAt: null },
    { id: "p4", title: "Old", groupId: "g", archivedAt: "2026-11-01T00:00:00.000Z" },
  ];
  const card = (id: string, projectId: string, over: Record<string, unknown> = {}) => ({ id, title: id, projectId, archivedAt: null, ...over });
  const tasks = [
    card("Scorer", "p1"),
    card("Member", "p1", { umbrella: { id: "u" } }),
    card("Elsewhere", "p2", { umbrella: { id: "v" } }),
    card("Gone", "p2", { umbrella: { id: "deleted" } }),
    card("Archived", "p1", { archivedAt: "2026-11-01T00:00:00.000Z" }),
    card("Other group", "p3"),
    card("Old project", "p4"),
    card("api client", "p2"),
  ];
  const umbrellas = [{ id: "v", title: "Search" }];
  const all = pickableCards(tasks, projects, umbrellas, "g", "u", "");
  expect(all).toEqual([
    { taskId: "api client", title: "api client", projectTitle: "Api" },
    { taskId: "Elsewhere", title: "Elsewhere", projectTitle: "Api", moveFrom: "Search" },
    { taskId: "Gone", title: "Gone", projectTitle: "Api", moveFrom: "" },
    { taskId: "Scorer", title: "Scorer", projectTitle: "App" },
  ]);
  expect(pickableCards(tasks, projects, umbrellas, "g", "u", " API ").map((c) => c.taskId)).toEqual(["api client"]);
});
