import { expect, test } from "vitest";
import { boardSchema, emptyBoard, type Board, type Group, type Project, type Task, type Umbrella, type UmbrellaEntry } from "./model";
import {
  applyGroupMoves, countsTowardLimit, relatedComponent, noteEntryInput, notesToOffer, umbrellaEntryCreateInput, issuesWithoutCard, linearWorkspaceOf, memberRoleSignature, memberSignature, parseLinearProject, suggestedMembers, umbrellaCreateInput, umbrellaUpdateInput, leaveUmbrella, markConflicts, membersOf, rolesMentioned, repairUmbrellaGroups, umbrellaChipText, umbrellaContext, umbrellaLimits, recentEntries, umbrellaRefetchKey, umbrellaStartLine, umbrellaSummary, umbrellasLosingMembers, umbrellaViewOf,
} from "./umbrella";

const at = "2026-11-25T00:00:00.000Z";
const human = { kind: "human" as const };
const umbrella = (over: Partial<Umbrella> = {}): Umbrella => ({
  id: "u", groupId: "g", title: "Fresh context",
  brief: { text: "The goal", revision: 1, updatedAt: at, updatedBy: human },
  contract: { text: "Shapes", revision: 0, updatedAt: at, updatedBy: human },
  acceptance: [], status: "open", createdBy: human, createdAt: at, updatedAt: at,
  revision: 1, feedRevision: 0, archivedAt: null, ...over,
});
const entry = (id: string, kind: UmbrellaEntry["kind"], status: UmbrellaEntry["status"], umbrellaId = "u"): UmbrellaEntry => ({
  id, umbrellaId, kind, title: id, body: "", status, by: human, createdAt: at, updatedAt: at,
});
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, projectId: "p", workspaceId: `w-${id}`, sourcePath: "/p", repoPaths: ["/p"], title: id.toUpperCase(),
  description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: `o-${id}`,
  createdAt: at, updatedAt: at, archivedAt: null, ...extra,
});

test("an old board without umbrellas parses with empty collections", () => {
  const board = boardSchema.parse({ version: 5, revision: 3, projects: [], tasks: [], events: [] });
  expect(board.umbrellas).toEqual([]);
  expect(board.umbrellaEntries).toEqual([]);
  expect(board.version).toBe(5);
});

test("limits match the spec", () => {
  expect(umbrellaLimits).toEqual({
    openPerGroup: 50, members: 30, activeEntries: 300, writesPerHour: 20, relaysPerHour: 60,
    brief: 20000, contract: 10000, pendingChanges: 10,
    title: 120, role: 40, acceptance: 20, acceptanceText: 300, entryTitle: 120, entryBody: 2000, quote: 500,
    briefBudget: 8000, feedBudget: 6000, siblings: 30, ideas: 30,
  });
});

test("proposed entries do not count toward the 300 limit", () => {
  const counted = (["active", "open"] as const).map((s) => countsTowardLimit(entry(s, "decision", s)));
  const ignored = (["proposed", "superseded", "answered", "accepted", "rejected", "withdrawn"] as const).map((s) =>
    countsTowardLimit(entry(s, "contract_change", s)),
  );
  expect(counted).toEqual([true, true]);
  expect(ignored.every((x) => !x)).toBe(true);
});

test("a summary counts members, open questions and pending changes from the full board", () => {
  const board = {
    tasks: [task("a", { umbrella: { id: "u", joinedAt: at, by: human } }), task("b", { umbrella: { id: "u", joinedAt: at, by: human } }), task("c"), task("d", { umbrella: { id: "other", joinedAt: at, by: human } })],
    umbrellaEntries: [
      entry("q1", "question", "open"), entry("q2", "question", "answered"), entry("q3", "question", "open", "other"),
      entry("c1", "contract_change", "proposed"), entry("c2", "contract_change", "rejected"), entry("d1", "decision", "active"),
    ],
  };
  const summary = umbrellaSummary(umbrella({ feedRevision: 4, linearProject: { url: "https://linear.app/x/project/y", name: "Y" } }), board);
  expect(summary).toEqual({
    id: "u", groupId: "g", title: "Fresh context", status: "open", members: 2, openQuestions: 1, pendingChanges: 1,
    revision: 1, feedRevision: 4, archivedAt: null, linearProject: { url: "https://linear.app/x/project/y", name: "Y" },
  });
  expect(JSON.stringify(summary)).not.toContain("The goal");
});

test("members sort by order, then title; the view of an umbrella drops brief and contract text", () => {
  const board = {
    tasks: [
      task("z", { umbrella: { id: "u", joinedAt: at, by: human } }),
      task("b", { umbrella: { id: "u", order: 2, joinedAt: at, by: human } }),
      task("a", { umbrella: { id: "u", joinedAt: at, by: human } }),
      task("c", { umbrella: { id: "u", order: 1, joinedAt: at, by: human } }),
    ],
  };
  expect(membersOf(board, "u").map((t) => t.id)).toEqual(["c", "b", "a", "z"]);
  const view = umbrellaViewOf(umbrella());
  expect(view.brief).toMatchObject({ text: "", revision: 1 });
  expect(view.contract.text).toBe("");
});

/** Groups A and B; projects p1, p2 in A and q in B; cards a (p1, the integration card), b (p2), c (q, outside). */
function moveBoard(): Board {
  const group = (id: string, isDefault = false): Group => ({ id, name: id, position: 0, ...(isDefault ? { isDefault: true as const } : {}), revision: 1, createdAt: at, updatedAt: at });
  const project = (id: string, groupId: string): Project => ({
    id, title: `Project ${id}`, description: "", paseoProjectId: `n-${id}`, primaryPath: `/${id}`, repos: [`/${id}`],
    revision: 1, createdAt: at, updatedAt: at, archivedAt: null, groupId,
  });
  const member = { id: "u", joinedAt: at, by: human };
  return {
    ...emptyBoard(),
    groups: [group("A", true), group("B")],
    projects: [project("p1", "A"), project("p2", "A"), project("q", "B")],
    tasks: [task("a", { projectId: "p1", umbrella: member }), task("b", { projectId: "p2", umbrella: member }), task("c", { projectId: "q" })],
    umbrellas: [umbrella({ groupId: "A", integrationTaskId: "a" })],
    umbrellaEntries: [{ ...entry("d1", "decision", "active"), sourceTaskId: "a" }],
  };
}
const moveTo = (board: Board, projectId: string, groupId: string) => (board.projects.find((p) => p.id === projectId)!.groupId = groupId);

test("umbrellasLosingMembers names the umbrellas a move would split", () => {
  const board = moveBoard();
  expect(umbrellasLosingMembers(board, [{ projectId: "p1", groupId: "B" }])).toEqual([{ umbrellaId: "u", title: "Fresh context", cards: 1 }]);
  // All member projects move together: the umbrella follows, nobody is lost.
  expect(umbrellasLosingMembers(board, [{ projectId: "p1", groupId: "B" }, { projectId: "p2", groupId: "B" }])).toEqual([]);
  // A move that touches no member project.
  expect(umbrellasLosingMembers(board, [{ projectId: "q", groupId: "A" }])).toEqual([]);
  // The preview changes nothing.
  expect(board.projects.map((p) => p.groupId)).toEqual(["A", "A", "B"]);
});

test("applyGroupMoves: the umbrella follows when all member projects land in one group", () => {
  const board = moveBoard();
  moveTo(board, "p1", "B");
  moveTo(board, "p2", "B");
  const notes: string[] = [];
  const result = applyGroupMoves(board, ["p1", "p2"], "2026-11-26T00:00:00.000Z", (taskId, note) => notes.push(`${taskId}: ${note}`));
  expect(result).toEqual({ moved: ["u"], lostMembers: [] });
  expect(board.umbrellas[0]).toMatchObject({ groupId: "B", updatedAt: "2026-11-26T00:00:00.000Z", integrationTaskId: "a", revision: 1 });
  expect(board.tasks.filter((t) => t.umbrella).map((t) => t.id)).toEqual(["a", "b"]);
  expect(notes).toEqual([]);
});

test("applyGroupMoves: a split drops only the cards that left, with the integration card role", () => {
  const board = moveBoard();
  moveTo(board, "p1", "B");
  const notes: string[] = [];
  const result = applyGroupMoves(board, ["p1"], "2026-11-26T00:00:00.000Z", (taskId, note) => notes.push(`${taskId}: ${note}`));
  expect(result).toEqual({ moved: [], lostMembers: [{ umbrellaId: "u", title: "Fresh context", taskIds: ["a"] }] });
  expect(board.tasks.find((t) => t.id === "a")!.umbrella).toBeUndefined();
  expect(board.tasks.find((t) => t.id === "b")!.umbrella).toMatchObject({ id: "u" });
  expect(board.umbrellas[0].groupId).toBe("A");
  expect(board.umbrellas[0]).not.toHaveProperty("integrationTaskId");
  expect(board.umbrellaEntries[0]).toMatchObject({ sourceTaskId: "a", status: "active" });
  expect(notes).toEqual(["a: Left umbrella Fresh context (project moved to another group)"]);
});

test("applyGroupMoves only checks umbrellas with a member in a moved project", () => {
  const board = moveBoard();
  // A member already out of its group (bad data) is left alone when its project did not move.
  moveTo(board, "p1", "B");
  expect(applyGroupMoves(board, ["q"], at, () => undefined)).toEqual({ moved: [], lostMembers: [] });
  expect(board.tasks.find((t) => t.id === "a")!.umbrella).toMatchObject({ id: "u" });
});

test("a dangling groupId is repaired to the default group", () => {
  const board = moveBoard();
  board.umbrellas.push(umbrella({ id: "empty", groupId: "gone" }), umbrella({ id: "kept", groupId: "B" }));
  expect(repairUmbrellaGroups(board, "A")).toEqual(["empty"]);
  expect(board.umbrellas.map((u) => u.groupId)).toEqual(["A", "A", "B"]);
  expect(repairUmbrellaGroups(board, "A")).toEqual([]);
});

test("a card that leaves its umbrella drops the integration card role", () => {
  const board = moveBoard();
  const a = board.tasks.find((t) => t.id === "a")!;
  expect(leaveUmbrella(board, a, "2026-11-26T00:00:00.000Z")?.id).toBe("u");
  expect(a.umbrella).toBeUndefined();
  expect(board.umbrellas[0]).toMatchObject({ revision: 2, updatedAt: "2026-11-26T00:00:00.000Z" });
  expect(board.umbrellas[0]).not.toHaveProperty("integrationTaskId");
  // Another member leaving changes nothing on the umbrella.
  expect(leaveUmbrella(board, board.tasks.find((t) => t.id === "b")!, at)?.id).toBe("u");
  expect(board.umbrellas[0].revision).toBe(2);
  expect(leaveUmbrella(board, board.tasks.find((t) => t.id === "c")!, at)).toBeUndefined();
});

/** get_task's umbrella block (§3): group G with projects p (lanes renamed) and q; members a (this card), b, c. */
function contextBoard(over: { entries?: UmbrellaEntry[]; umbrella?: Partial<Umbrella> } = {}) {
  const project = (id: string, extra: Partial<Project> = {}): Project => ({
    id, title: `Project ${id}`, description: "", paseoProjectId: `n-${id}`, primaryPath: `/${id}`, repos: [`/${id}`],
    revision: 1, createdAt: at, updatedAt: at, archivedAt: null, groupId: "g", ...extra,
  });
  const member = (role: string, order: number) => ({ umbrella: { id: "u", role, order, joinedAt: at, by: human } });
  const board: Board = {
    ...emptyBoard(),
    groups: [{ id: "g", name: "G", position: 0, isDefault: true, revision: 1, createdAt: at, updatedAt: at }],
    projects: [project("p", { lanes: [{ status: "todo", name: "Ready", enabled: true }] }), project("q")],
    tasks: [
      task("a", member("feature map", 1)),
      task("b", { ...member("harness", 2), projectId: "q", status: "development" }),
      task("c", { ...member("gallery", 3), archivedAt: at }),
      task("x"),
    ],
    umbrellas: [umbrella({ integrationTaskId: "b", acceptance: [{ id: "a1", text: "End to end passes", done: false, by: human, at }], linearProject: { url: "https://linear.app/p", key: "K", name: "Proj" }, ...over.umbrella })],
    umbrellaEntries: over.entries ?? [],
    ideas: [
      { id: "i1", taskId: "b", projectId: "q", title: "Open idea", detail: "", rationale: "", context: "", status: "open", umbrellaId: "u", createdAt: at, updatedAt: at },
      { id: "i2", taskId: "b", projectId: "q", title: "Done idea", detail: "", rationale: "", context: "", status: "dismissed", umbrellaId: "u", createdAt: at, updatedAt: at },
      { id: "i3", taskId: "x", projectId: "p", title: "Other idea", detail: "", rationale: "", context: "", status: "open", createdAt: at, updatedAt: at },
    ],
  };
  return board;
}
const fed = (id: string, kind: UmbrellaEntry["kind"], status: UmbrellaEntry["status"], minute: number, extra: Partial<UmbrellaEntry> = {}): UmbrellaEntry => ({
  ...entry(id, kind, status), createdAt: `2026-11-25T00:${String(minute).padStart(2, "0")}:00.000Z`, updatedAt: `2026-11-25T00:${String(minute).padStart(2, "0")}:00.000Z`, ...extra,
});
const ctxOf = (board: Board, taskId = "a", seen: Parameters<typeof umbrellaContext>[0]["seen"] = null, agentId = "me") =>
  umbrellaContext({ board, task: board.tasks.find((t) => t.id === taskId)!, agentId, seen });
const allSeen = (ids: string[]) => ({ brief: 99, contract: 99, entries: ids });

test("a card outside an umbrella gets no block", () => {
  expect(ctxOf(contextBoard(), "x")).toBeNull();
});

test("a member sees brief, contract, rulings first, siblings with lanes and roles, open ideas", () => {
  const board = contextBoard({
    umbrella: { contract: { text: "Shapes", revision: 2, updatedAt: at, updatedBy: human } },
    entries: [fed("d1", "decision", "active", 1), fed("r1", "ruling", "active", 2, { quote: "Drafts only" })],
  });
  const { value, shown } = ctxOf(board, "a", allSeen(["d1", "r1"]))!;
  expect(value).toMatchObject({
    id: "u", title: "Fresh context", status: "open", role: "feature map", integration: false,
    brief: { text: "The goal", revision: 1, unread: false, truncated: false },
    contract: { text: "Shapes", revision: 2, unread: false },
    openQuestions: 0, pendingContractChanges: 0,
    acceptance: [{ id: "a1", text: "End to end passes", done: false }],
    ideas: [{ id: "i1", title: "Open idea", status: "open", sourceTaskId: "b" }],
    linearProject: { url: "https://linear.app/p", name: "Proj" },
    truncatedFeed: 0, unreadLeftOut: 0,
  });
  expect(value.feed.map((e) => e.id)).toEqual(["r1", "d1"]);
  expect(value.feed[0]).toMatchObject({ kind: "ruling", quote: "Drafts only", unread: false, sourceTaskId: null, sourceTitle: null });
  expect(value.siblings).toEqual([
    { taskId: "b", projectId: "q", projectTitle: "Project q", title: "B", laneName: "Development", status: "development", role: "harness", order: 2, archived: false },
    { taskId: "c", projectId: "p", projectTitle: "Project p", title: "C", laneName: "Ready", status: "todo", role: "gallery", order: 3, archived: true },
  ]);
  expect(ctxOf(board, "b")!.value.integration).toBe(true);
  expect(shown).toEqual({ brief: 1, contract: 2, entries: ["r1", "d1"] });
});

test("ideas are capped at 30, newest first, and the rest are counted", () => {
  const board = contextBoard();
  board.ideas = Array.from({ length: 33 }, (_, i) => ({
    id: `i${i}`, taskId: "b", projectId: "q", title: `Idea ${i}`, detail: "", rationale: "", context: "", status: "open" as const, umbrellaId: "u",
    createdAt: `2026-11-25T01:${String(i).padStart(2, "0")}:00.000Z`, updatedAt: at,
  }));
  const { value } = ctxOf(board)!;
  expect(value.ideas).toHaveLength(umbrellaLimits.ideas);
  expect(value.ideas[0]!.id).toBe("i32");
  expect(value.ideas.at(-1)!.id).toBe("i3");
  expect(value.ideasMore).toBe(3);
  expect(ctxOf(contextBoard())!.value.ideasMore).toBe(0);
});

test("the feed puts unread first, then active rulings, then open questions and proposals, then the rest newest first", () => {
  const board = contextBoard({
    entries: [
      fed("old-decision", "decision", "active", 1),
      fed("new-finding", "finding", "active", 5),
      fed("pitfall", "pitfall", "active", 3),
      fed("ruling", "ruling", "active", 2),
      fed("question", "question", "open", 4),
      fed("proposal", "contract_change", "proposed", 6, { change: { before: "", after: "x", reason: "Why it changes", baseRevision: 0 } }),
      fed("unread-old", "convention", "active", 0),
      fed("unread-new", "decision", "active", 9),
    ],
  });
  const seen = allSeen(["old-decision", "new-finding", "pitfall", "ruling", "question", "proposal"]);
  const { value } = ctxOf(board, "a", seen)!;
  expect(value.feed.map((e) => e.id)).toEqual(["unread-new", "unread-old", "ruling", "proposal", "question", "new-finding", "pitfall", "old-decision"]);
  expect(value.feed.filter((e) => e.unread).map((e) => e.id)).toEqual(["unread-new", "unread-old"]);
  // A contract change's body is its reason; the `after` text is only in flowly_get_umbrella.
  expect(value.feed.find((e) => e.id === "proposal")).toMatchObject({ body: "Why it changes" });
  expect(JSON.stringify(value.feed)).not.toContain('"after"');
  expect(value).toMatchObject({ openQuestions: 1, pendingContractChanges: 1 });
});

test("an unseen active ruling comes first and is never cut by newer unread entries (D26)", () => {
  const long = "x".repeat(2000);
  const board = contextBoard({
    entries: [
      fed("ruling-old", "ruling", "active", 1),
      fed("ruling-mid", "ruling", "active", 2),
      fed("ruling-seen", "ruling", "active", 3),
      ...[4, 5, 6, 7].map((m) => fed(`d${m}`, "decision", "active", m, { body: long })),
    ],
  });
  const { value, shown } = ctxOf(board, "a", allSeen(["ruling-seen"]))!;
  // Both unseen rulings are listed first, newest first; the budget then cuts the newer decisions, not them.
  expect(value.feed.slice(0, 2).map((e) => e.id)).toEqual(["ruling-mid", "ruling-old"]);
  expect(value.feed.map((e) => e.id)).toEqual(["ruling-mid", "ruling-old", "d7", "d6"]);
  expect(shown.entries).toEqual(["ruling-mid", "ruling-old", "d7", "d6"]);
  // A seen ruling does not jump ahead of unread entries.
  const seenRulings = ctxOf(board, "a", allSeen(["ruling-old", "ruling-mid", "ruling-seen"]))!.value;
  expect(seenRulings.feed.map((e) => e.id)).toEqual(["d7", "d6"]);
});

test("the feed stops at 6,000 characters and counts the rest", () => {
  const long = "x".repeat(2000);
  const board = contextBoard({ entries: [1, 2, 3, 4].map((m) => fed(`d${m}`, "decision", "active", m, { body: long })) });
  const { value, shown } = ctxOf(board, "a", allSeen(["d1", "d2", "d3", "d4"]))!;
  expect(value.feed.map((e) => e.id)).toEqual(["d4", "d3"]);
  expect(value.truncatedFeed).toBe(2);
  expect(value.unreadLeftOut).toBe(0);
  expect(shown.entries).toEqual(["d4", "d3"]);
});

test("unread entries left out are counted and not recorded as shown", () => {
  const board = contextBoard({ entries: [1, 2, 3, 4, 5].map((m) => fed(`d${m}`, "decision", "active", m, { title: "t".repeat(100), body: "x".repeat(2000) })) });
  const { value, shown } = ctxOf(board, "a", allSeen([]))!;
  expect(value.feed.map((e) => e.id)).toEqual(["d5", "d4"]);
  expect(value.unreadLeftOut).toBe(3);
  expect(shown.entries).toEqual(["d5", "d4"]);
  const next = ctxOf(board, "a", allSeen(shown.entries))!.value;
  expect(next.feed.map((e) => [e.id, e.unread])).toEqual([["d3", true], ["d2", true]]);
  expect(next.unreadLeftOut).toBe(1);
});

test("a long brief is cut at 8,000, marked truncated and is not recorded as read", () => {
  const text = "b".repeat(8001);
  const board = contextBoard({ umbrella: { brief: { text, revision: 3, updatedAt: at, updatedBy: human } } });
  const { value, shown } = ctxOf(board, "a", { brief: 2, contract: 0, entries: [] })!;
  expect(value.brief).toMatchObject({ text: text.slice(0, 8000), truncated: true, unread: true, revision: 3 });
  expect(shown.brief).toBeNull();
});

test("brief and contract are unread when newer than this session's read, never for its own edits or an empty revision 0", () => {
  const me = { kind: "agent" as const, agentId: "me" };
  const board = contextBoard({ umbrella: { brief: { text: "B", revision: 2, updatedAt: at, updatedBy: human }, contract: { text: "C", revision: 4, updatedAt: at, updatedBy: me } } });
  expect(ctxOf(board, "a", null)!.value).toMatchObject({ brief: { unread: true }, contract: { unread: false } });
  expect(ctxOf(board, "a", { brief: 1, contract: 3, entries: [] })!.value).toMatchObject({ brief: { unread: true }, contract: { unread: false } });
  expect(ctxOf(board, "a", { brief: 2, contract: 3, entries: [] })!.value.brief.unread).toBe(false);
  // Task 1 starts the contract at revision 0 with no text: nothing to read.
  expect(ctxOf(contextBoard(), "a", null)!.value.contract.unread).toBe(false);
});

test("an agent's own entry is never unread to it", () => {
  const board = contextBoard({ entries: [fed("mine", "decision", "active", 1, { by: { kind: "agent", agentId: "me", taskId: "a" }, sourceTaskId: "a" })] });
  expect(ctxOf(board, "a", null, "me")!.value.feed[0]).toMatchObject({ id: "mine", unread: false, sourceTitle: "A" });
  expect(ctxOf(board, "b", null, "other")!.value.feed[0]).toMatchObject({ id: "mine", unread: true });
});

test("superseded, answered, rejected and withdrawn entries are left out", () => {
  const board = contextBoard({
    entries: [
      fed("s", "decision", "superseded", 1, { sourceTaskId: "b" }),
      fed("q", "question", "answered", 2, { sourceTaskId: "b", answer: "Yes" }),
      fed("r", "contract_change", "rejected", 3, { sourceTaskId: "b", answer: "No" }),
      fed("w", "contract_change", "withdrawn", 4, { sourceTaskId: "b" }),
      fed("keep", "decision", "active", 5),
    ],
  });
  const { value } = ctxOf(board, "a", null)!;
  expect(value.feed.map((e) => e.id)).toEqual(["keep"]);
  expect(value.truncatedFeed).toBe(0);
});

test("an answered question and a rejected proposal return once to the card they came from, with the answer", () => {
  const asker = { kind: "agent" as const, agentId: "me", taskId: "a" };
  const board = contextBoard({
    entries: [
      fed("q", "question", "open", 1, { sourceTaskId: "a", by: asker }),
      fed("r", "contract_change", "proposed", 2, { sourceTaskId: "a", by: asker, change: { before: "", after: "x", reason: "Add a field", baseRevision: 0 } }),
    ],
  });
  // The open question and the proposal were shown to the asker before the user answered.
  const before = ctxOf(board, "a", null)!;
  expect(before.value.feed.map((e) => [e.id, e.unread])).toEqual([["r", false], ["q", false]]);
  const q = board.umbrellaEntries[0]!, r = board.umbrellaEntries[1]!;
  Object.assign(q, { status: "answered", answer: "Drafts", updatedAt: "2026-11-25T01:00:00.000Z" });
  Object.assign(r, { status: "rejected", answer: "Not now", updatedAt: "2026-11-25T01:00:00.000Z" });
  const seen = { brief: 1, contract: 0, entries: before.shown.entries };
  const first = ctxOf(board, "a", seen)!;
  expect(first.value.feed.map((e) => ({ id: e.id, status: e.status, answer: e.answer, unread: e.unread }))).toEqual([
    { id: "r", status: "rejected", answer: "Not now", unread: true },
    { id: "q", status: "answered", answer: "Drafts", unread: true },
  ]);
  const second = ctxOf(board, "a", { ...seen, entries: [...seen.entries, ...first.shown.entries] })!;
  expect(second.value.feed).toEqual([]);
  // A sibling never gets them.
  expect(ctxOf(board, "b", null, "other")!.value.feed).toEqual([]);
});

test("an entry from a deleted or moved-out card still renders", () => {
  const board = contextBoard({ entries: [fed("gone", "finding", "active", 1, { sourceTaskId: "deleted" }), fed("out", "finding", "active", 2, { sourceTaskId: "x" })] });
  expect(ctxOf(board, "a", null)!.value.feed.map((e) => [e.id, e.sourceTitle])).toEqual([["out", "moved out"], ["gone", "deleted card"]]);
});

test("the start line names the umbrella, the role and the [contract] rule", () => {
  const board = contextBoard();
  expect(umbrellaStartLine(board, board.tasks.find((t) => t.id === "x")!)).toBeNull();
  expect(umbrellaStartLine(board, board.tasks[0]!)).toBe(
    'Umbrella "Fresh context" (your role: feature map): the brief, contract and feed are in flowly_get_task.umbrella. Start a report\'s note with [contract] only when it changes a handoff shape or decision your siblings depend on.',
  );
});

test("a returned answer counts toward the 6,000 budget; the one left out stays unread and returns later", () => {
  const asker = { kind: "agent" as const, agentId: "me", taskId: "a" };
  const answered = (id: string, minute: number) =>
    fed(id, "question", "answered", minute, { sourceTaskId: "a", by: asker, body: "b".repeat(100), answer: "y".repeat(1500) });
  const board = contextBoard({ entries: [1, 2, 3, 4].map((m) => answered(`q${m}`, m)) });
  const first = ctxOf(board, "a", { brief: 1, contract: 0, entries: [] })!;
  // Each returned entry costs about 1,602 characters with its answer: three fit, the fourth would pass 6,000.
  expect(first.value.feed.map((e) => e.id)).toEqual(["q4", "q3", "q2"]);
  expect(first.value).toMatchObject({ truncatedFeed: 1, unreadLeftOut: 1 });
  const next = ctxOf(board, "a", { brief: 1, contract: 0, entries: first.shown.entries })!;
  expect(next.value.feed.map((e) => [e.id, e.unread, e.answer?.length])).toEqual([["q1", true, 1500]]);
});

test("umbrellaChipText cuts at 20 and adds the role", () => {
  expect(umbrellaChipText("Fresh context")).toBe("Fresh context");
  expect(umbrellaChipText("A".repeat(25))).toBe(`${"A".repeat(19)}…`);
  expect(umbrellaChipText("A".repeat(20))).toBe("A".repeat(20));
  expect(umbrellaChipText("Fresh context", "feature map")).toBe("Fresh context · feature map");
  expect(umbrellaChipText("Fresh context", "")).toBe("Fresh context");
});

test("the refetch key changes on a feed write, on an edit and on a membership change", () => {
  const base = { revision: 2, feedRevision: 3 };
  expect(umbrellaRefetchKey(base, "")).toBe("2:3:");
  expect(umbrellaRefetchKey({ ...base, feedRevision: 4 }, "")).not.toBe(umbrellaRefetchKey(base, ""));
  expect(umbrellaRefetchKey({ ...base, revision: 3 }, "")).not.toBe(umbrellaRefetchKey(base, ""));
  expect(umbrellaRefetchKey({ ...base }, "")).toBe(umbrellaRefetchKey(base, ""));
  // Membership writes bump neither revision: the member signature (ids, roles, orders) moves the key instead.
  const m = (role?: string, order?: number) => ({ id: "u", joinedAt: at, by: human, ...(role ? { role } : {}), ...(order !== undefined ? { order } : {}) });
  const tasks = [task("a", { umbrella: m("map", 1) }), task("b", { umbrella: m() }), task("c")];
  const sig = memberRoleSignature(tasks, "u");
  expect(memberRoleSignature([tasks[1]!, tasks[0]!, tasks[2]!], "u")).toBe(sig);
  expect(memberRoleSignature([task("a", { umbrella: m("api", 1) }), tasks[1]!], "u")).not.toBe(sig);
  expect(memberRoleSignature([task("a", { umbrella: m("map", 2) }), tasks[1]!], "u")).not.toBe(sig);
  expect(memberRoleSignature([tasks[0]!], "u")).not.toBe(sig);
  expect(memberRoleSignature(tasks, "other")).toBe(memberRoleSignature([], "u"));
  expect(umbrellaRefetchKey(base, sig)).not.toBe(umbrellaRefetchKey(base, memberRoleSignature([tasks[0]!], "u")));
});

test("recentEntries returns the newest five without withdrawn ones", () => {
  const entries = Array.from({ length: 7 }, (_, i) => ({ ...entry(`e${i}`, "decision", i === 6 ? "withdrawn" : "active"), createdAt: `2026-11-25T00:00:0${i}.000Z` }));
  expect(recentEntries(entries).map((e) => e.id)).toEqual(["e5", "e4", "e3", "e2", "e1"]);
  expect(recentEntries(entries, 2)).toHaveLength(2);
  expect(entries[0]!.id).toBe("e0");
});

const proposal = (id: string, baseRevision: number, status: UmbrellaEntry["status"] = "proposed"): UmbrellaEntry => ({
  ...entry(id, "contract_change", status),
  change: { before: "", after: id, reason: id, baseRevision },
});

test("markConflicts flags proposals sharing a base or behind the contract, and clears the rest", () => {
  const a = proposal("a", 1), b = proposal("b", 1), c = proposal("c", 2), old = proposal("old", 1, "rejected");
  markConflicts([a, b, c, old, entry("d", "decision", "active")], 2);
  expect([a.change!.conflict, b.change!.conflict, c.change!.conflict]).toEqual([true, true, undefined]);
  // A closed proposal is never touched.
  expect(old.change!.conflict).toBeUndefined();
  // Once a and b are gone, c on the current revision alone is no conflict; b behind still is.
  a.status = "withdrawn";
  markConflicts([a, b, c], 1);
  expect([b.change!.conflict, c.change!.conflict]).toEqual([undefined, undefined]);
  markConflicts([b, c], 2);
  expect([b.change!.conflict, c.change!.conflict]).toEqual([true, undefined]);
});

test("rolesMentioned finds roles named in the reason or the changed lines", () => {
  const members = [
    { taskId: "t-api", role: "API" },
    { taskId: "t-ui", role: "ui" },
    { taskId: "t-map", role: "feature map" },
    { taskId: "t-none" },
    { taskId: "t-gallery", role: "gallery" },
  ];
  const change = {
    before: "shared line about gallery\nold: Feature Map shape\n",
    after: "shared line about gallery\nnew: rapid build\n",
    reason: "The api needs a new field",
  };
  // Case-insensitive; a line in both texts does not count; "ui" inside "build" is no mention.
  expect(rolesMentioned(change, members)).toEqual(["t-api", "t-map"]);
  expect(rolesMentioned({ before: "x", after: "x", reason: "" }, members)).toEqual([]);
  expect(rolesMentioned({ before: "", after: "UI: buttons", reason: "" }, members)).toEqual(["t-ui"]);
});

test("the integration card's first instructions ask for the end-to-end check", () => {
  const board = contextBoard();
  // Card b is the integration card; card a is an ordinary member.
  const line = umbrellaStartLine(board, board.tasks.find((t) => t.id === "b")!)!;
  expect(line).toContain('Umbrella "Fresh context"');
  expect(line).toContain("integration card");
  expect(line).toContain("acceptance");
  expect(line).toContain("flowly_update_umbrella_acceptance");
  expect(line).toContain("finding");
  expect(umbrellaStartLine(board, board.tasks.find((t) => t.id === "a")!)).not.toContain("integration card");
});

test("parseLinearProject reads a project URL and a P- key; other text is refused", () => {
  expect(parseLinearProject("https://linear.app/acme/project/fresh-context-1a2b3c4d5e6f")).toEqual({ url: "https://linear.app/acme/project/fresh-context-1a2b3c4d5e6f" });
  expect(parseLinearProject("  https://linear.app/acme/project/fresh-context-1a2b3c4d5e6f/overview ")).toEqual({ url: "https://linear.app/acme/project/fresh-context-1a2b3c4d5e6f/overview" });
  expect(parseLinearProject("P-ZEN-391")).toEqual({ key: "P-ZEN-391" });
  expect(parseLinearProject("p-zen-391")).toEqual({ key: "P-ZEN-391" });
  expect(parseLinearProject("foo")).toBeNull();
  expect(parseLinearProject("https://linear.app/acme/issue/ZEN-1/x")).toBeNull();
  expect(parseLinearProject("https://evil.test/acme/project/x-1")).toBeNull();
  expect(parseLinearProject("ZEN-391")).toBeNull();
  expect(parseLinearProject("")).toBeNull();
});

test("entry accepts a project URL or a P- key and refuses other text", () => {
  const entry = (url: string) => umbrellaCreateInput.safeParse({ groupId: "g", title: "T", linearProject: { url } }).success;
  expect(entry("https://linear.app/acme/project/fresh-1a2b3c4d5e6f")).toBe(true);
  expect(entry("P-ZEN-391")).toBe(true);
  expect(entry("foo")).toBe(false);
  expect(umbrellaUpdateInput.safeParse({ id: "u", revision: 1, linearProject: { url: "foo" } }).success).toBe(false);
  expect(umbrellaUpdateInput.safeParse({ id: "u", revision: 1, linearProject: null }).success).toBe(true);
});

test("linearWorkspaceOf reads the workspace segment", () => {
  expect(linearWorkspaceOf("https://linear.app/Acme/project/x-1")).toBe("acme");
  expect(linearWorkspaceOf("https://linear.app/acme")).toBe("acme");
  expect(linearWorkspaceOf("https://other.test/acme")).toBeNull();
});

test("the member signature changes when the umbrella's member set does, not with order or other cards", () => {
  const m = { id: "u", joinedAt: at, by: human };
  const a = [task("a", { umbrella: m }), task("b", { umbrella: m }), task("c")];
  expect(memberSignature(a, "u")).toBe("a,b");
  expect(memberSignature([a[1]!, a[0]!, a[2]!], "u")).toBe("a,b");
  expect(memberSignature([...a, task("d", { umbrella: m })], "u")).toBe("a,b,d");
  expect(memberSignature(a, "other")).toBe("");
});

test("issues without a card skip issues linked to members", () => {
  const issues = [
    { identifier: "ZEN-1", title: "A", state: "Todo", url: "u1" },
    { identifier: "ZEN-2", title: "B", state: "Todo", url: "u2" },
  ];
  expect(issuesWithoutCard(issues, new Set(["ZEN-1"])).map((i) => i.identifier)).toEqual(["ZEN-2"]);
  expect(issuesWithoutCard(issues, new Set())).toEqual(issues);
});

test("suggested members are group cards outside any umbrella whose Linear issue is in the project", () => {
  const group = (id: string, isDefault = false): Group => ({ id, name: id, position: 0, ...(isDefault ? { isDefault: true as const } : {}), revision: 1, createdAt: at, updatedAt: at });
  const project = (id: string, groupId: string): Project => ({
    id, title: `Project ${id}`, description: "", paseoProjectId: `n-${id}`, primaryPath: `/${id}`, repos: [`/${id}`],
    revision: 1, createdAt: at, updatedAt: at, archivedAt: null, groupId,
  });
  const link = (taskId: string, key: string, provider = "linear") => ({
    id: `a-${taskId}`, taskId, projectId: "p1", role: "input" as const, kind: "url" as const, target: "https://x", title: key, note: "",
    createdBy: "human" as const, createdAt: at, updatedAt: at, external: { connectionId: "c", provider, itemType: "issue", key, remoteId: key },
  });
  const board = {
    ...emptyBoard(),
    groups: [group("A", true), group("B")],
    projects: [project("p1", "A"), project("q", "B")],
    tasks: [
      task("ok", { projectId: "p1" }),
      task("other-group", { projectId: "q" }),
      task("archived", { projectId: "p1", archivedAt: at }),
      task("member", { projectId: "p1", umbrella: { id: "u", joinedAt: at, by: human } }),
      task("elsewhere", { projectId: "p1", umbrella: { id: "other", joinedAt: at, by: human } }),
      task("not-in-project", { projectId: "p1" }),
      task("jira", { projectId: "p1" }),
    ],
    artifacts: [
      link("ok", "zen-1"), link("other-group", "ZEN-1"), link("archived", "ZEN-1"), link("member", "ZEN-1"), link("elsewhere", "ZEN-1"),
      link("not-in-project", "ZEN-7"), link("jira", "ZEN-1", "jira"),
    ],
  } as unknown as Board;
  expect(suggestedMembers(board, umbrella({ groupId: "A" }), new Set(["ZEN-1"]))).toEqual([{ taskId: "ok", title: "OK", projectTitle: "Project p1", issue: "ZEN-1" }]);
});

const relatedBoard = () => {
  const group = (id: string, isDefault = false): Group => ({ id, name: id, position: 0, ...(isDefault ? { isDefault: true as const } : {}), revision: 1, createdAt: at, updatedAt: at });
  const project = (id: string, groupId: string): Project => ({
    id, title: `Project ${id}`, description: "", paseoProjectId: `n-${id}`, primaryPath: `/${id}`, repos: [`/${id}`],
    revision: 1, createdAt: at, updatedAt: at, archivedAt: null, groupId,
  });
  const tags = (...t: string[]) => ({ tags: t.map((tag) => ({ tag, by: "human" as const, at })) });
  const rel = (from: string, to: string) => ({ id: `${from}-${to}`, projectId: "p1", kind: "related" as const, from, to, createdBy: "human" as const, createdAt: at });
  return {
    ...emptyBoard(),
    groups: [group("A", true), group("B")],
    projects: [project("p1", "A"), project("p2", "A"), project("q", "B")],
    tasks: [
      task("start", { projectId: "p1", ...tags("search") }),
      task("b", { projectId: "p2", ...tags("search", "x") }),
      task("c", { projectId: "p1", ...tags("search") }),
      task("no-tag", { projectId: "p1", ...tags("billing") }),
      task("far", { projectId: "p1", ...tags("search") }),
      task("other-group", { projectId: "q", ...tags("search") }),
      task("archived", { projectId: "p1", archivedAt: at, ...tags("search") }),
      task("member", { projectId: "p1", umbrella: { id: "u", joinedAt: at, by: human }, ...tags("search") }),
    ],
    links: [
      rel("start", "b"), rel("c", "b"), rel("c", "far"), rel("start", "no-tag"), rel("no-tag", "far"),
      rel("start", "other-group"), rel("start", "archived"), rel("start", "member"),
      { ...rel("start", "ignored-blocks"), kind: "blocks" as const },
    ],
  } as unknown as Board;
};

test("relatedComponent follows related links within the group and the shared tag", () => {
  const board = relatedBoard();
  // b is linked to start, c to b (breadth first, either direction); far is behind c; no-tag shares no tag so it is not followed through.
  expect(relatedComponent(board, "start").map((t) => t.id)).toEqual(["b", "c", "far"]);
  expect(relatedComponent(board, "missing")).toEqual([]);
});

test("relatedComponent skips archived cards and cards already in an umbrella", () => {
  const ids = relatedComponent(relatedBoard(), "start").map((t) => t.id);
  expect(ids).not.toContain("archived");
  expect(ids).not.toContain("member");
  expect(ids).not.toContain("other-group");
  expect(ids).not.toContain("start");
});

test("relatedComponent is capped at 30", () => {
  const board = relatedBoard();
  for (let i = 0; i < 40; i++) {
    board.tasks.push(task(`n${i}`, { projectId: "p1", tags: [{ tag: "search", by: "human", at }] }));
    board.links.push({ id: `l${i}`, projectId: "p1", kind: "related", from: "start", to: `n${i}`, createdBy: "human", createdAt: at });
  }
  expect(relatedComponent(board, "start")).toHaveLength(30);
});

test("notes are offered when their project is a proposed member's and they carry a tag the start card shares with another proposed member", () => {
  const n = (id: string, projectId: string, noteKind: string, tags: string[], state = "active") => ({ id, projectId, kind: "note", noteKind, text: id, body: "b", tags, state });
  const notes = [
    n("a", "p1", "decision", ["search"]), n("b", "p2", "contact", ["x"]), n("c", "p1", "pitfall", ["billing"]), n("d", "q", "decision", ["search"]),
    n("e", "p1", "convention", ["search"], "archived"), { ...n("f", "p1", "decision", ["search"]), kind: "guideline" }, n("g", "p2", "decision", ["search"]),
  ];
  const start = { projectId: "p1", tags: ["search", "solo"] };
  const others = [{ projectId: "p2", tags: ["search", "x"] }];
  // Shared set is {search}: x is the other card's own tag and solo the start's own; a note in p2 with the shared tag is offered.
  expect(notesToOffer(notes, start, others).map((x) => x.id)).toEqual(["a", "g"]);
  expect(notesToOffer(notes, start, [])).toEqual([]);
  expect(noteEntryInput({ noteKind: "contact", text: "T".repeat(200), body: "B".repeat(3000) })).toEqual({ kind: "finding", title: "T".repeat(120), body: "B".repeat(2000) });
  expect(noteEntryInput({ noteKind: "pitfall", text: "t" }).kind).toBe("pitfall");
  expect(noteEntryInput({ noteKind: "decision", text: "t" }).body).toBe("");
});

test("relatedComponent skips cards of archived projects and reads the group from the project", () => {
  const board = relatedBoard();
  board.projects.find((p) => p.id === "p2")!.archivedAt = at;
  expect(relatedComponent(board, "start").map((t) => t.id)).toEqual([]);
  const fresh = relatedBoard();
  fresh.groups = [];
  expect(relatedComponent(fresh, "start").map((t) => t.id)).toEqual(["b", "c", "far"]);
});

test("entry.create input takes the four user kinds only", () => {
  expect(umbrellaEntryCreateInput.safeParse({ umbrellaId: "u", kind: "decision", title: "t", body: "b" }).success).toBe(true);
  expect(umbrellaEntryCreateInput.safeParse({ umbrellaId: "u", kind: "ruling", title: "t", body: "b" }).success).toBe(false);
  expect(umbrellaEntryCreateInput.safeParse({ umbrellaId: "u", kind: "finding", title: "", body: "b" }).success).toBe(false);
});
