import { expect, test } from "vitest";
import { answersWithText, chatRows, discussAvailable, discussDraft, discussFill, discussIdeaText, displayRows, mergeTimeline, modelLabel, newToolsNotice, replaceOffer } from "./dispatcher-panel-logic";
import type { ChatItem } from "../shared/dispatcher";
import { lastOutputRow } from "./session-state";
import type { TailEntry } from "../shared/session-tail";

const at = (s: number) => new Date(Date.parse("2026-11-08T10:00:00.000Z") + s * 1000).toISOString();
const entry = (seq: number, type: string, text: string, s?: number): TailEntry => ({ seqStart: seq, seqEnd: seq, item: { type, text }, ...(s === undefined ? {} : { timestamp: at(s) }) });
const note = (id: string, s: number): ChatItem => ({ id, at: at(s), kind: "note", note: { taskId: id, projectId: "p", title: `Card ${id}`, kind: "question", detail: "Which DB?", at: at(s) } });

test("transcript entries and chat items interleave by time", () => {
  const transcript = [
    entry(1, "user_message", "Flowly board summary. Pass the projectId to every tool.\n\nProjects…", 0),
    entry(2, "assistant_message", "Ready.", 2),
    entry(3, "user_message", "Make a card for X", 10),
    // No timestamp: it stays right after the entry before it.
    entry(4, "assistant_message", "Done: card t9.", undefined),
    entry(5, "user_message", "Flowly board update (1 card):\n- \"Card n2\" [n2] …", 30),
    entry(6, "assistant_message", "n2 needs you.", 31),
  ];
  const items = [note("n2", 30), note("n1", 5), { id: "change", at: at(40), kind: "change", revision: 1, ids: [], cards: [] } as ChatItem];
  const rows = mergeTimeline(transcript, items);
  expect(rows.map((r) => (r.kind === "item" ? r.item.id : r.kind === "summary" ? "summary" : r.entry.item.text))).toEqual([
    "summary",
    "Ready.",
    "n1",
    "Make a card for X",
    "Done: card t9.",
    // The note batch message is left out: its note rows stand for it.
    "n2",
    "n2 needs you.",
  ]);
  // Stable: the same input gives the same keys in the same order.
  expect(mergeTimeline(transcript, items).map((r) => r.key)).toEqual(rows.map((r) => r.key));
  // Ties keep the transcript first, and items with equal times keep their order.
  const tie = mergeTimeline([entry(1, "assistant_message", "a", 5)], [note("x", 5), note("y", 5)]);
  expect(tie.map((r) => r.key)).toEqual(["entry-1-assistant_message", "item-x", "item-y"]);
});

test("the chat is the conversation only: asks, answers and the change line are not in it (Ruling, Noah 2026-11-09)", () => {
  const change = { id: "change", at: at(1), kind: "change", revision: 1, ids: [], cards: [] } as ChatItem;
  const ask = { id: "ask-q:a:e1", at: at(3), kind: "ask", signal: "q:a:e1", taskId: "t1", projectId: "p", title: "Card", state: "open" } as ChatItem;
  const answer = { id: "answer-1", at: at(4), kind: "answer", signal: "q:a:e1", taskId: "t1", projectId: "p", text: "Yes", delivered: true } as ChatItem;
  const rows = mergeTimeline([entry(1, "assistant_message", "a", 0), entry(2, "assistant_message", "b", 20)], [change, ask, answer, note("n1", 10)]);
  expect(rows.map((r) => r.key)).toEqual(["entry-1-assistant_message", "item-n1", "entry-2-assistant_message"]);
  expect(chatRows([entry(1, "assistant_message", "a", 0)], [ask, answer, change]).map((r) => r.kind)).toEqual(["entry"]);
});

test("transcript runs between items are grouped like the session pane", () => {
  const rows = mergeTimeline(
    [entry(1, "reasoning", "think", 1), { seqStart: 2, seqEnd: 2, timestamp: at(2), item: { type: "tool_call", name: "flowly_list_cards", status: "completed" } }, entry(3, "assistant_message", "Hi", 3), entry(4, "reasoning", "more", 9)],
    [note("n1", 5)],
  );
  // The shared session transcript's rows: its own blocks, and the dispatcher's items as rows of their own.
  const shown = displayRows(rows);
  expect(shown.map((r) => r.kind)).toEqual(["activity", "entry", "extra", "activity"]);
  expect(shown[2].kind === "extra" && shown[2].item).toMatchObject({ kind: "item", item: { id: "n1" } });
  expect(new Set(shown.map((r) => r.key)).size).toBe(shown.length);
});

test("the board summary is one row of its own, and chatRows keeps item keys", () => {
  const summary = entry(1, "user_message", "Flowly board summary. Pass the projectId to every tool.\n\nProjects…", 0);
  const shown = chatRows([summary, entry(2, "assistant_message", "Ready.", 2)], [note("n1", 5)]);
  expect(shown.map((r) => r.kind)).toEqual(["extra", "entry", "extra"]);
  expect(shown[0].kind === "extra" && shown[0].item).toEqual({ kind: "summary" });
  expect(shown[2].key).toBe("item-n1");
});

test("the live activity is the newest output row, not a note after it (DISPATCHER-SPEC §9.3)", () => {
  const shown = chatRows([entry(1, "assistant_message", "Hi", 1), entry(2, "reasoning", "think", 3)], [note("n1", 5), note("n2", 6)]);
  expect(shown.map((r) => r.kind)).toEqual(["entry", "activity", "extra", "extra"]);
  // While the agent runs, that activity block shows "Working" and no separate running line is added.
  expect(lastOutputRow(shown)).toBe(shown[1]);
  expect(lastOutputRow(shown.slice(0, 1))?.kind).toBe("entry");
  expect(lastOutputRow(shown.slice(2))).toBeUndefined();
});

test("reports and a permission with no request to answer take a typed answer; a request's actions are buttons (§9.4)", () => {
  // A closed session's requests were cleared, but its permission attention stays: a typed answer messages the session.
  expect(answersWithText({ askKind: "permission" })).toBe(true);
  // The server's rule: a request id means a request to answer, never text, even when no options came with it.
  expect(answersWithText({ askKind: "permission", requestId: "r1" })).toBe(false);
  expect(answersWithText({ askKind: "question_report" })).toBe(true);
  expect(answersWithText({ askKind: "blocker_report" })).toBe(true);
  expect(answersWithText({ askKind: "ask_user" })).toBe(false);
  expect(answersWithText({ askKind: "error" })).toBe(false);
});

test("Discuss: the draft names the idea's id and project, then its title and detail (DISPATCHER-SPEC §9.5)", () => {
  const idea = { id: "i1", title: "Add retry to the importer", detail: "Wrap the fetch in a retry.\n" };
  expect(discussIdeaText(idea, "Tinylink")).toBe("Let's talk about this idea (id i1, project Tinylink): Add retry to the importer. Wrap the fetch in a retry.");
  expect(discussIdeaText({ ...idea, detail: "  " }, "Tinylink")).toBe("Let's talk about this idea (id i1, project Tinylink): Add retry to the importer.");
  expect(discussIdeaText({ ...idea, title: "Why does it fail?", detail: "" }, "Tinylink")).toBe("Let's talk about this idea (id i1, project Tinylink): Why does it fail?");
});

test("Discuss never replaces a draft: it goes after it, and the same draft is not added twice", () => {
  const text = "Let's talk about this idea (id i1, project P): T.";
  expect(discussDraft(text, "")).toBe(text);
  expect(discussDraft(text, "   ")).toBe(text);
  expect(discussDraft(text, "also check the logs  \n")).toBe(`also check the logs\n\n${text}`);
  expect(discussDraft(text, `first\n\n${text}`)).toBe(`first\n\n${text}`);
});

test("Discuss shows only where the board can open the dispatcher chat", () => {
  expect(discussAvailable({ project: true, allView: false })).toBe(true);
  expect(discussAvailable({ project: false, allView: true })).toBe(true);
  expect(discussAvailable({ project: false, allView: false })).toBe(false);
});

test("a Discuss fill is used once and leaves an unchanged box alone (DISPATCHER-SPEC §9.5)", () => {
  const text = "Let's talk about this idea (id i1, project P): T.";
  expect(discussFill({ text, key: 1 }, 0, "")).toEqual({ key: 1, next: text });
  expect(discussFill({ text, key: 1 }, 0, "typed")).toEqual({ key: 1, next: `typed\n\n${text}` });
  // Already applied (the same mount) or none: nothing to do.
  expect(discussFill({ text, key: 1 }, 1, "")).toBeNull();
  expect(discussFill(null, 0, "")).toBeNull();
  // The box already holds it: consumed, but no change (and no focus request).
  expect(discussFill({ text, key: 2 }, 1, `a\n\n${text}`)).toEqual({ key: 2, next: null });
});

test("Replace dispatcher is offered for an unguarded dispatcher and for one missing tools, and its notice says so (Ruling, Noah 2026-11-09)", () => {
  expect(replaceOffer({ state: "idle", agentId: "a", newTools: true })).toBe("new-tools");
  expect(replaceOffer({ state: "running", agentId: "a", newTools: true })).toBe("new-tools");
  expect(replaceOffer({ state: "idle", agentId: "a", unguarded: true })).toBe("unguarded");
  // Both: one Replace, under the unguarded warning.
  expect(replaceOffer({ state: "idle", agentId: "a", unguarded: true, newTools: true })).toBe("unguarded");
  expect(replaceOffer({ state: "idle", agentId: "a" })).toBeNull();
  // Not live, or no session to replace: nothing to offer.
  expect(replaceOffer({ state: "ended", agentId: "a", newTools: true })).toBeNull();
  expect(replaceOffer({ state: "idle", agentId: null, newTools: true })).toBeNull();
  expect(replaceOffer(undefined)).toBeNull();
  expect(newToolsNotice).toContain("Replace dispatcher");
  expect(newToolsNotice).not.toContain("Archive its session in Paseo");
});

test("the composer's footer names the dispatcher's model, else its provider; no state word (Ruling, Noah 2026-11-09)", () => {
  expect(modelLabel({ provider: "claude", model: "claude-sonnet-5-5" })).toBe("claude-sonnet-5-5");
  expect(modelLabel({ provider: "claude", model: null })).toBe("claude");
  expect(modelLabel({ provider: "", model: "" })).toBe("");
  expect(modelLabel(undefined)).toBe("");
});

test("a prompt from another agent stays its own entry row beside note items", () => {
  const from: TailEntry = { seqStart: 2, seqEnd: 2, timestamp: at(2), item: { type: "tool_call", name: "agent_message", status: "completed", text: "Hi", from: { id: "a1", title: "Coder", event: "message" } } };
  const shown = chatRows([entry(1, "assistant_message", "a", 1), from, entry(3, "assistant_message", "b", 9)], [note("n1", 5)]);
  expect(shown.map((r) => r.kind)).toEqual(["entry", "entry", "extra", "entry"]);
  expect(shown[1].kind === "entry" && shown[1].entry).toMatchObject({ kind: "agent-message", sender: "Coder" });
});
