import { describe, expect, it } from "vitest";
import {
  answerText,
  clueText,
  containsSecret,
  questionAnswers,
  fitCandidate,
  isStale,
  isWidelyUsed,
  leastUsed,
  memoryContextLines,
  memoryForTask,
  memoryLimits,
  memoryScore,
  noteUse,
  parseRetroOutput,
  recallMemory,
  retroMaterial,
  terms,
  trimClues,
  type MemoryClue,
  type MemoryEntry,
} from "./memory";

let seq = 0;
function entry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  seq++;
  return {
    id: `m${seq}-0000-0000`,
    projectId: "p",
    kind: "pitfall",
    title: `Entry ${seq}`,
    body: "",
    tags: [],
    keywords: [],
    pinned: false,
    status: "active",
    source: { by: "human" },
    revision: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    confirmedAt: `2026-10-${String(1 + (seq % 20)).padStart(2, "0")}T00:00:00.000Z`,
    ...over,
  };
}

describe("terms", () => {
  it("keeps 3+ letter words without stop words, and CJK pairs", () => {
    const t = terms("Fix the summary parser for 摘要模型");
    expect(t.has("summary")).toBe(true);
    expect(t.has("parser")).toBe(true);
    expect(t.has("the")).toBe(false);
    expect(t.has("摘要")).toBe(true);
    expect(t.has("要模")).toBe(true);
  });
});

describe("memoryScore", () => {
  it("adds 3 per shared tag, 1 per shared word (at most 4) and 2 per keyword hit", () => {
    const e = entry({ title: "Modal swap freezes Paseo", tags: ["ui-polish"], keywords: ["dialog", "弹窗"] });
    expect(memoryScore(e, { text: "nothing related here", tags: ["ui-polish"] })).toBe(3);
    expect(memoryScore(e, { text: "the modal swap freezes everything" })).toBe(3);
    expect(memoryScore(e, { text: "设置弹窗卡死" })).toBe(2);
    expect(memoryScore(e, { text: "a dialog opens" })).toBe(2);
  });
});

describe("memoryForTask", () => {
  const card = { title: "Settings dialog freezes", description: "", tags: [] };
  it("gives every active entry when all fit the budget, pinned first then by kind", () => {
    const a = entry({ kind: "pitfall" }),
      b = entry({ kind: "decision" }),
      c = entry({ kind: "contact", pinned: true }),
      d = entry({ status: "candidate" }),
      e = entry({ status: "archived" });
    const s = memoryForTask([a, b, c, d, e], card);
    expect(s.all).toBe(true);
    expect(s.entries.map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    expect(s.total).toBe(3);
  });
  it("chooses pinned and relevant entries (score ≥ 2) when they do not all fit, never fillers", () => {
    const pinned = entry({ pinned: true, title: "Commit as JasprW" });
    const relevant = entry({ title: "Two modals in one frame freeze", keywords: ["dialog", "settings"] });
    const weak = entry({ title: "Freezes happen sometimes" }); // one shared word: score 1
    const fillers = Array.from({ length: 10 }, () => entry({ title: "Unrelated release step" }));
    const s = memoryForTask([pinned, relevant, weak, ...fillers], card);
    expect(s.all).toBe(false);
    expect(s.entries.map((x) => x.id)).toEqual([pinned.id, relevant.id]);
    expect(s.total).toBe(13);
  });
  it("respects the entry and character budget", () => {
    const many = Array.from({ length: 20 }, () => entry({ title: "Settings dialog freezes again", body: "x".repeat(150) }));
    const s = memoryForTask(many, card);
    expect(s.entries.length).toBeLessThanOrEqual(memoryLimits.injectEntries);
    const chars = memoryContextLines(s).slice(1).join("\n").length;
    expect(chars).toBeLessThanOrEqual(memoryLimits.injectChars);
  });
  it("renders a header that says whether all entries are shown", () => {
    const a = entry({ title: "Decision A", body: "Because B", kind: "decision" });
    const lines = memoryContextLines(memoryForTask([a], card), () => "Card A");
    expect(lines[0]).toContain("all 1 entries");
    expect(lines[1]).toMatch(/^- \[Decision\] Decision A: Because B \(memory m\d+-0000, from "Card A"\)$/);
    expect(memoryContextLines(memoryForTask([], card))).toEqual([]);
  });
});

describe("recallMemory", () => {
  it("ranks by relevance, skips zero scores, and lists the latest confirmed for an empty query", () => {
    const a = entry({ title: "Hermes loop closures", confirmedAt: "2026-10-02T00:00:00.000Z" });
    const b = entry({ title: "Paseo SDK cannot open files", keywords: ["openTab"], confirmedAt: "2026-10-09T00:00:00.000Z" });
    expect(recallMemory([a, b], { query: "open a file in Paseo" }).entries.map((e) => e.id)).toEqual([b.id]);
    expect(recallMemory([a, b], { query: "" }).entries.map((e) => e.id)).toEqual([b.id, a.id]);
    expect(recallMemory([a, b], { query: "", kind: "decision" }).entries).toEqual([]);
  });
});

describe("containsSecret", () => {
  it("catches tokens and key assignments but not commit ids or paths", () => {
    expect(containsSecret("token npm_" + "t438cQg15C1LvYZFBfjwhHilAzSKAl1UuTLQ")).toBe(true);
    expect(containsSecret("ghp_" + "a".repeat(20))).toBe(true);
    expect(containsSecret("GITLAB_TOKEN=glpat-abcdefghijklmnop1234")).toBe(true);
    expect(containsSecret("Authorization: Bearer abcdefgh12345678")).toBe(true);
    expect(containsSecret("The connector tokens are in ~/.env (GITLAB_TOKEN, CONFLUENCE_TOKEN)")).toBe(false);
    expect(containsSecret("Fixed in 1dfe946d9d92c3a1b2c3d4e5f60718293a4b5c6d")).toBe(false);
    expect(containsSecret("See docs/verification/workspace-change-ownership-2026-10-21.md")).toBe(false);
  });
});

describe("lifecycle hints", () => {
  const now = Date.parse("2026-12-31T00:00:00.000Z");
  it("marks unused unpinned active entries stale after 60 days", () => {
    expect(isStale(entry({ confirmedAt: "2026-10-01T00:00:00.000Z" }), now)).toBe(true);
    expect(isStale(entry({ confirmedAt: "2026-10-01T00:00:00.000Z", usedAt: "2026-12-20T00:00:00.000Z" }), now)).toBe(false);
    expect(isStale(entry({ confirmedAt: "2026-10-01T00:00:00.000Z", pinned: true }), now)).toBe(false);
  });
  it("counts distinct cards of the last 30 days for widely used, keeping 20", () => {
    const e = entry();
    for (let i = 0; i < 25; i++) noteUse(e, `t${i}`, "2026-12-20T00:00:00.000Z");
    noteUse(e, "t3", "2026-12-21T00:00:00.000Z");
    expect(e.usedBy!.length).toBe(memoryLimits.usedByKept);
    expect(e.usedBy!.at(-1)).toEqual({ taskId: "t3", at: "2026-12-21T00:00:00.000Z" });
    expect(isWidelyUsed(e, now)).toBe(true);
    expect(isWidelyUsed(entry({ usedBy: [{ taskId: "a", at: "2026-12-20T00:00:00.000Z" }] }), now)).toBe(false);
  });
  it("offers the longest-unused unpinned entries to make room", () => {
    const old = entry({ usedAt: "2026-01-01T00:00:00.000Z" }),
      fresh = entry({ usedAt: "2026-12-01T00:00:00.000Z" }),
      pinned = entry({ pinned: true, usedAt: "2025-01-01T00:00:00.000Z" });
    expect(leastUsed([fresh, pinned, old], "p", 2).map((e) => e.id)).toEqual([old.id, fresh.id]);
  });
});

describe("clues", () => {
  it("drops short messages, picked suggestions and secrets, and cuts long ones", () => {
    expect(clueText("继续")).toBeNull();
    expect(clueText("commit and push")).toBe("commit and push");
    expect(clueText("Commit the change and push it", ["Commit the change and push it"])).toBeNull();
    expect(clueText("这个是 PAT npm_" + "t438cQg15C1LvYZFBfjwhHilAzSKAl1UuTLQ")).toBeNull();
    expect(clueText("x".repeat(900))!.length).toBe(memoryLimits.clueText);
  });
  it("keeps the first clue of a card and the latest others", () => {
    const clues: MemoryClue[] = Array.from({ length: 35 }, (_, i) => ({ id: `c${i}`, taskId: "a", projectId: "p", at: `t${i}`, kind: "message", text: `m${i}` }));
    clues.push({ id: "other", taskId: "b", projectId: "p", at: "x", kind: "message", text: "b" });
    const kept = trimClues(clues, "a");
    const own = kept.filter((c) => c.taskId === "a");
    expect(own.length).toBe(memoryLimits.cluesPerTask);
    expect(own[0].id).toBe("c0");
    expect(own.at(-1)!.id).toBe("c34");
    expect(kept.some((c) => c.id === "other")).toBe(true);
  });
});

describe("finished-card review", () => {
  it("parses fenced JSON, bare arrays and string lists, at most one", () => {
    const fenced = "Here:\n```json\n{\"candidates\":[{\"kind\":\"pitfall\",\"title\":\"A\",\"body\":\"b\",\"tags\":\"ui, mobile\",\"keywords\":[\"x\"],\"evidence\":\"q\",\"reuse\":\"any card with a dialog\"}]}\n```";
    expect(parseRetroOutput(fenced)).toEqual([{ kind: "pitfall", title: "A", body: "b", tags: ["ui", "mobile"], keywords: ["x"], evidence: "q", reuse: "any card with a dialog" }]);
    const four = JSON.stringify(Array.from({ length: 4 }, (_, i) => ({ kind: "decision", title: `T${i}`, reuse: "r" })));
    expect(parseRetroOutput(four).map((c) => c.title)).toEqual(["T0"]);
    expect(parseRetroOutput('{"candidates": []}')).toEqual([]);
    expect(parseRetroOutput('{"candidates": [{"kind": "nope", "title": "x"}]}')).toEqual([]);
    expect(() => parseRetroOutput("no json")).toThrow("no JSON");
  });
  it("drops a candidate that names no later card on another feature, before the cap", () => {
    const out = JSON.stringify({ candidates: [{ kind: "decision", title: "How this card's dialog works", reuse: " " }, { kind: "pitfall", title: "General", reuse: "any card that adds a setting" }] });
    expect(parseRetroOutput(out).map((c) => c.title)).toEqual(["General"]);
  });
  it("fits candidates to the stored limits and normalizes tags", () => {
    const fit = fitCandidate({ kind: "contact", title: "x".repeat(200), body: "b", tags: ["UI Polish", "a", "b", "c", "d"], keywords: [], evidence: "", reuse: "r" });
    expect(fit.title.length).toBe(memoryLimits.title);
    expect(fit.tags).toEqual(["ui-polish", "a", "b", "c"]);
  });
  it("builds material within the limit, keeping answers when clues are cut", () => {
    const clues: MemoryClue[] = [
      { id: "1", taskId: "a", projectId: "p", at: "1", kind: "answer", ask: "Which one?", text: "Option B, because A breaks phones" },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, taskId: "a", projectId: "p", at: `${i}`, kind: "message" as const, text: "y".repeat(500) })),
    ];
    const text = retroMaterial({
      project: "Flowly",
      card: { title: "Card", tags: ["drawer"], description: "Do it" },
      clues,
      recapLines: ["Root cause: Hermes loop binding"],
      states: [],
      failedChecks: [],
      reports: [],
      existing: [{ id: "m1", kind: "pitfall", title: "Old" }],
      waiting: [{ kind: "decision", title: "Pending one" }],
      dismissed: [{ kind: "convention", title: "Turned down" }],
    });
    expect(text.length).toBeLessThanOrEqual(10000);
    expect(text).toContain("Q: Which one?\nA: Option B");
    expect(text).toContain("Root cause: Hermes loop binding");
    expect(text).toContain("- m1 [pitfall] Old");
    expect(text).toContain("waiting for the user (do not repeat)\n- [decision] Pending one");
    expect(text).toContain("does not want these or anything of the same sort)\n- [convention] Turned down");
    // Instruction files come after the card material and do not count against its limit.
    const withRules = retroMaterial({ project: "P", card: { title: "C", tags: [], description: "" }, clues, recapLines: [], states: [], failedChecks: [], reports: [], existing: [], instructions: "R".repeat(15000) });
    expect(withRules).toContain("Q: Which one?");
    expect(withRules.endsWith("R".repeat(15000))).toBe(true);
  });
});

describe("native question answers (timelines checked 2026-10-22)", () => {
  // Claude AskUserQuestion as a Paseo session recorded it (docs/verification/native-question.md, session fcbad8f1).
  const claude = {
    type: "tool_call",
    callId: "toolu_01GQ3yBytMrixDqshiAbyo9d",
    name: "AskUserQuestion",
    status: "completed",
    detail: {
      type: "unknown",
      input: {
        questions: [
          { question: "How long should new short codes be?", header: "Code length", multiSelect: false, options: [{ label: "6 characters" }, { label: "8 characters" }] },
          { question: "Which alphabet should new short codes use?", header: "Alphabet", multiSelect: false, options: [{ label: "base62" }, { label: "base58" }] },
        ],
      },
      output: { output: 'Your questions have been answered: "How long should new short codes be?"="6 characters", "Which alphabet should new short codes use?"="base62". You can now continue with these answers in mind.' },
    },
  };
  it("reads Claude AskUserQuestion answers, whichever sentence wraps them", () => {
    expect(questionAnswers([claude])).toEqual([
      { id: "toolu_01GQ3yBytMrixDqshiAbyo9d:0", ask: "How long should new short codes be?", text: "6 characters" },
      { id: "toolu_01GQ3yBytMrixDqshiAbyo9d:1", ask: "Which alphabet should new short codes use?", text: "base62" },
    ]);
    const older = { ...claude, detail: { ...claude.detail, output: 'The user answered: "How long should new short codes be?"="8 characters". Read the answers carefully.' } };
    expect(questionAnswers([older]).map((a) => a.text)).toEqual(["8 characters"]);
    expect(questionAnswers([{ ...claude, status: "failed" }])).toEqual([]);
  });
  it("reads Codex request_user_input answers from the metadata", () => {
    const codex = {
      type: "tool_call",
      callId: "call_1",
      name: "request_user_input",
      status: "completed",
      detail: { type: "plain_text", text: "…" },
      metadata: {
        questions: [{ id: "q1", header: "Length", question: "How long?", options: [{ label: "6" }] }, { id: "q2", header: "Alphabet", question: "Which?" }],
        answers: { q1: ["6"], q2: ["base62", "base58"] },
      },
    };
    expect(questionAnswers([codex])).toEqual([
      { id: "call_1:0", ask: "How long?", text: "6" },
      { id: "call_1:1", ask: "Which?", text: "base62, base58" },
    ]);
  });
  it("reads Codex async answers from the follow-up message and skips the async tool call itself", () => {
    // The async call as Paseo rendered a dismissed question (session b20f4e8e): never an answer.
    const dismissed = { type: "tool_call", callId: "call_AybZ", name: "request_user_input_async", status: "completed", detail: { type: "plain_text", text: "请恢复公司网络后告知。\n已恢复内网连接, 暂时无法恢复\n\nDismissed" } };
    const reply = { type: "user_message", text: "Answers to your questions:\n\n请恢复公司网络后告知。\n已恢复内网连接\n\nWhich alphabet?\nbase58, because people type them by hand" };
    expect(questionAnswers([dismissed])).toEqual([]);
    expect(questionAnswers([reply]).map((a) => [a.ask, a.text])).toEqual([
      ["请恢复公司网络后告知。", "已恢复内网连接"],
      ["Which alphabet?", "base58, because people type them by hand"],
    ]);
  });
  it("keeps short answers but never secrets", () => {
    expect(answerText(" 6 ")).toBe("6");
    expect(answerText("ghp_" + "a".repeat(24))).toBeNull();
    expect(answerText("  ")).toBeNull();
  });
});
