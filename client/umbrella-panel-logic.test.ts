import { expect, test } from "vitest";
import type { UmbrellaEntry } from "../shared/model";
import type { UmbrellaMember, UmbrellaSummary } from "../shared/umbrella";
import {
  acceptanceInput, changedLines, linearChipUrl, alreadyKept, closeOffer, offerProject, editAfterSave, editBase, errorCode, feedRows, listedUmbrellas, memberInput, memberWrites, moveMember, openQuestions, pendingChanges, pickableCards, pipelineRows, proposedMembers, runMigration, startCards, readyToClose, revisionToSend, umbrellaWritable,
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

test("acceptance edits send text and order only, trimmed, without empty items", () => {
  const items = [
    { id: "a1", text: " Works end to end ", done: true },
    { text: "  ", done: false },
    { text: "New item", done: false },
  ];
  expect(acceptanceInput(items)).toEqual([{ id: "a1", text: "Works end to end" }, { text: "New item" }]);
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
  // An empty role is sent as null, which clears it (an omitted one would be kept); an order change keeps the role.
  expect(memberInput("u", m, { role: "  " })).toEqual({ taskId: "t", umbrellaId: "u", role: null, order: 2 });
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

test("member writes are built from the fresh members and send only rows that change", () => {
  const fresh = [
    { taskId: "A", role: "map", order: 1 },
    { taskId: "B", order: 2 },
    { taskId: "C", role: "scorer", order: 3 },
  ];
  const inUmbrella = new Set(["A", "B", "C"]);
  // Unchanged rows are skipped: A already has order 1, B already has order 2.
  expect(memberWrites("u", fresh, [{ taskId: "A", order: 1 }, { taskId: "B", order: 2 }, { taskId: "C", order: 4 }], inUmbrella)).toEqual([
    { taskId: "C", umbrellaId: "u", role: "scorer", order: 4 },
  ]);
  // A role-only change sends one row, with the fresh order.
  expect(memberWrites("u", fresh, [{ taskId: "B", role: "api" }], inUmbrella)).toEqual([{ taskId: "B", umbrellaId: "u", role: "api", order: 2 }]);
  // The same role (after trimming) is no change.
  expect(memberWrites("u", fresh, [{ taskId: "A", role: " map " }], inUmbrella)).toEqual([]);
});

test("member writes never pull back a card that left the umbrella", () => {
  const fresh = [{ taskId: "A", order: 1 }, { taskId: "C", order: 2 }];
  // C moved to another umbrella on the board: skipped even though the read still listed it.
  expect(memberWrites("u", fresh, [{ taskId: "A", order: 2 }, { taskId: "C", order: 1 }], new Set(["A"]))).toEqual([
    { taskId: "A", umbrellaId: "u", order: 2 },
  ]);
  // A card missing from the fresh members is skipped too.
  expect(memberWrites("u", fresh, [{ taskId: "Z", order: 3 }], new Set(["A", "C", "Z"]))).toEqual([]);
});

test("pending contract changes list only proposed ones, oldest first", () => {
  const change = (id: string, status: UmbrellaEntry["status"], minute: number) => ({
    ...entry(id, "contract_change", status, minute),
    change: { before: "", after: id, reason: id, baseRevision: 1 },
  });
  const entries = [change("late", "proposed", 5), change("done", "accepted", 1), change("early", "proposed", 2), entry("q", "question", "open", 0)];
  expect(pendingChanges(entries).map((e) => e.id)).toEqual(["early", "late"]);
});

test("the before/after view lists the lines only one side has", () => {
  expect(changedLines("a\nb\nc", "a\nc\nd")).toEqual({ removed: ["b"], added: ["d"] });
  expect(changedLines("", "new")).toEqual({ removed: [], added: ["new"] });
  expect(changedLines("same", "same")).toEqual({ removed: [], added: [] });
});

test("readyToClose needs every member finished and every item ticked", () => {
  const done = [{ done: true }, { done: true }];
  expect(readyToClose([{ status: "done" }, { status: "cancelled" }], done)).toBe(true);
  expect(readyToClose([{ status: "done" }, { status: "development" }], done)).toBe(false);
  expect(readyToClose([{ status: "done" }], [{ done: true }, { done: false }])).toBe(false);
  // No member means nothing was finished; an empty acceptance list is met.
  expect(readyToClose([], done)).toBe(false);
  expect(readyToClose([{ status: "done" }], [])).toBe(true);
});

test("the close offer lists active decisions, conventions and pitfalls", () => {
  const entries = [
    entry("d", "decision", "active", 1),
    entry("c", "convention", "active", 2),
    entry("p", "pitfall", "active", 3),
    entry("old", "decision", "superseded", 4),
    entry("f", "finding", "active", 5),
    entry("r", "ruling", "active", 6),
    entry("q", "question", "open", 7),
    entry("w", "pitfall", "withdrawn", 8),
  ];
  expect(closeOffer(entries).map((e) => e.id)).toEqual(["d", "c", "p"]);
});

test("an offered entry is kept in its writer's project, else the first member's", () => {
  const tasks = [{ id: "t1", projectId: "pa" }];
  const members = [{ projectId: "pm" }, { projectId: "pz" }];
  expect(offerProject({ sourceTaskId: "t1" }, tasks, members)).toBe("pa");
  expect(offerProject({ sourceTaskId: "gone" }, tasks, members)).toBe("pm");
  expect(offerProject({}, tasks, members)).toBe("pm");
  expect(offerProject({}, tasks, [])).toBeNull();
});

test("readyToClose ignores archived members", () => {
  const done = [{ done: true }];
  expect(readyToClose([{ status: "done" }, { status: "development", archived: true }], done)).toBe(true);
  expect(readyToClose([{ status: "development", archived: true }], done)).toBe(false);
  expect(readyToClose([{ status: "done" }, { status: "development", archived: false }], done)).toBe(false);
});

test("an entry already kept in the project is recognised by kind and title", () => {
  const existing = [
    { kind: "note", state: "active", text: "Use drafts", noteKind: "decision" },
    { kind: "note", state: "archived", text: "Old pitfall", noteKind: "pitfall" },
    { kind: "guideline", state: "active", text: "Use drafts", noteKind: undefined },
  ];
  expect(alreadyKept(existing, { kind: "decision", title: " use DRAFTS " }, 120)).toBe(true);
  expect(alreadyKept(existing, { kind: "convention", title: "Use drafts" }, 120)).toBe(false);
  expect(alreadyKept(existing, { kind: "pitfall", title: "Old pitfall" }, 120)).toBe(false);
  expect(alreadyKept(existing, { kind: "decision", title: "Use drafts and more".padEnd(130, "x") }, 120)).toBe(false);
});

test("start cards are the group's live cards in no umbrella, by title", () => {
  const tasks = [
    { id: "b", title: "Beta", projectId: "p", archivedAt: null },
    { id: "a", title: "Alpha", projectId: "p", archivedAt: null },
    { id: "in", title: "In umbrella", projectId: "p", archivedAt: null, umbrella: { id: "u" } },
    { id: "gone", title: "Gone", projectId: "p", archivedAt: "x" },
    { id: "far", title: "Far", projectId: "q", archivedAt: null },
  ];
  const projects = [{ id: "p", title: "P", groupId: "g", archivedAt: null }, { id: "q", title: "Q", groupId: "h", archivedAt: null }];
  expect(startCards(tasks, projects, "g", "").map((c) => c.taskId)).toEqual(["a", "b"]);
  expect(startCards(tasks, projects, "g", "bet").map((c) => c.taskId)).toEqual(["b"]);
});

test("proposed members put the start card first and stay within the limit", () => {
  expect(proposedMembers("s", [{ id: "a" }, { id: "b" }], 30)).toEqual(["s", "a", "b"]);
  expect(proposedMembers("s", [{ id: "a" }, { id: "b" }, { id: "c" }], 3)).toEqual(["s", "a", "b"]);
});

test("the migration creates the umbrella, the members, then the notes, and stops at the first failure", async () => {
  const log: string[] = [];
  const plan = {
    groupId: "g", title: " T ", brief: "  ", memberIds: ["s", "a", "b"],
    notes: [{ kind: "decision" as const, title: "n1", body: "" }, { kind: "finding" as const, title: "n2", body: "" }],
  };
  const ok = await runMigration(plan, {
    create: async (i) => (log.push(`create ${i.title}${i.brief ? " brief" : ""}`), { id: "u" }),
    setMember: async (i) => void log.push(`member ${i.taskId}`),
    addEntry: async (i) => void log.push(`note ${i.title}`),
  });
  expect(log).toEqual(["create T", "member s", "member a", "member b", "note n1", "note n2"]);
  expect(ok).toEqual({ umbrellaId: "u", missedMembers: [], missedNotes: [] });
  const boom = new Error("UMBRELLA_OUT_OF_GROUP: no");
  const partial = await runMigration(plan, {
    create: async () => ({ id: "u" }),
    setMember: async (i) => {
      if (i.taskId === "a") throw boom;
    },
    addEntry: async () => undefined,
  });
  expect(partial).toEqual({ umbrellaId: "u", missedMembers: ["a", "b"], missedNotes: ["n1", "n2"], error: boom });
  const noteFail = await runMigration(plan, {
    create: async () => ({ id: "u" }), setMember: async () => undefined,
    addEntry: async (i) => {
      if (i.title === "n2") throw boom;
    },
  });
  expect(noteFail).toMatchObject({ missedMembers: [], missedNotes: ["n2"] });
  await expect(runMigration(plan, { create: async () => Promise.reject(boom), setMember: async () => undefined, addEntry: async () => undefined })).rejects.toBe(boom);
});

test("the Linear chip opens the URL the read returned, else the stored link", () => {
  expect(linearChipUrl("P-ZEN-391", "https://linear.app/acme/project/fresh-1a2b")).toBe("https://linear.app/acme/project/fresh-1a2b");
  expect(linearChipUrl("https://linear.app/acme/project/fresh-1a2b", undefined)).toBe("https://linear.app/acme/project/fresh-1a2b");
  expect(linearChipUrl("https://linear.app/acme/project/fresh-1a2b", "")).toBe("https://linear.app/acme/project/fresh-1a2b");
});
