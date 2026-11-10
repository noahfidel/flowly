import { expect, test } from "vitest";
import { isSummarizer, modelLabel, readOnlyConfig, readOnlyMode, lastTurn, targetText, parseModelOutput, resolveModel, resolveModels, summaryModelsOf, summaryModelsSchema, summarySettings, summaryPrompt, summarySettingsValues, truncateTranscript, turnText } from "./summary";

test("turn text keeps dialogue, reduces tools to names and drops reasoning", () => {
  const text = turnText([
    { type: "user_message", text: " 修一下登录 " },
    { type: "reasoning", text: "thinking" },
    { type: "tool_call", name: "Read" },
    { type: "tool_call", name: "Read" },
    { type: "tool_call", name: "Edit" },
    { type: "assistant_message", text: "Done." },
    { type: "error", message: "boom" },
  ]);
  expect(text).toBe("User: 修一下登录\n\nTools: Read ×2, Edit\n\nAssistant: Done.\n\nError: boom");
  expect(turnText([{ type: "reasoning", text: "x" }])).toBe("");
});

test("over-long transcripts keep the head and the tail within the limit", () => {
  const long = "H".repeat(5000) + "M".repeat(20000) + "T".repeat(5000);
  const cut = truncateTranscript(long, 12000, 3000);
  expect(cut.length).toBe(12000);
  expect(cut.startsWith("H".repeat(3000))).toBe(true);
  expect(cut.endsWith("T".repeat(5000))).toBe(true);
  expect(cut).toContain("omitted");
  expect(truncateTranscript("short")).toBe("short");
});

test("last turn starts at the last user message", () => {
  const items = [{ type: "user_message" }, { type: "assistant_message" }, { type: "user_message", text: "b" }, { type: "tool_call" }];
  expect(lastTurn(items)).toEqual(items.slice(2));
  expect(lastTurn([{ type: "assistant_message" }])).toHaveLength(1);
});

test("model output parsing tolerates fences and prose, rejects bad shapes", () => {
  const ok = parseModelOutput('Here:\n```json\n{"update":true,"state":"测试中 {1}","recap":"a","next":"b"}\n```');
  expect(ok).toEqual({ update: true, state: "测试中 {1}", target: "", recap: "a", next: "b" });
  expect(parseModelOutput('{"update":true,"state":"s","target":["Goal: x","a"],"recap":"","next":""}').target).toBe("x\n- a");
  expect(parseModelOutput('{"update":false,"state":"","recap":"","next":""}').update).toBe(false);
  // Never trimmed: long text is kept whole; only absurd output beyond the storage bound is an error.
  expect(parseModelOutput(`{"update":true,"state":"${"x".repeat(300)}","recap":"","next":""}`).state.length).toBe(300);
  expect(() => parseModelOutput(`{"update":true,"state":"s","recap":"${"x".repeat(4001)}","next":""}`)).toThrow(/schema/);
  expect(() => parseModelOutput("no json")).toThrow(/no JSON/);
  expect(() => parseModelOutput('{"update":"yes"}')).toThrow(/schema/);
  expect(parseModelOutput('{"update":true,"state":"s","recap":["a","- b"],"next":"n"}').recap).toBe("- a\n- b");
  expect(parseModelOutput('{"update":false}')).toEqual({ update: false, state: "", target: "", recap: "", next: "" });
  expect(parseModelOutput('{"update":"true","state":"s","recap":null}')).toEqual({ update: true, state: "s", target: "", recap: "", next: "" });
  expect(() => parseModelOutput('{"update":true,"state":" ","recap":"","next":""}')).toThrow(/empty state/);
  expect(() => parseModelOutput(null)).toThrow();
});

const providers = (claude: boolean, codex = true) => [
  { provider: "claude", available: claude, models: [{ id: "claude-haiku-5-5" }] },
  { provider: "codex", available: codex, models: [{ id: "gpt-6-luna" }, { id: "gpt-6-sol", isSelectable: false }] },
];

test("Auto model prefers Haiku 5.5 and falls back to GPT-6-Luna", () => {
  expect(resolveModels("", providers(true))).toEqual(["claude/claude-haiku-5-5", "codex/gpt-6-luna"]);
  expect(resolveModels("codex/gpt-6-luna", providers(true))).toEqual(["codex/gpt-6-luna"]);
  expect(resolveModel("", providers(true))).toBe("claude/claude-haiku-5-5");
  expect(resolveModel("", providers(false))).toBe("codex/gpt-6-luna");
  expect(() => resolveModel("", providers(false, false))).toThrow(/No summary model/);
  expect(resolveModel("codex/gpt-6-luna", providers(true))).toBe("codex/gpt-6-luna");
  expect(() => resolveModel("codex/gpt-6-sol", providers(true))).toThrow(/not available/);
  expect(() => resolveModel("bogus", providers(true))).toThrow(/not available/);
});

test("settings fill missing fields with defaults", () => {
  expect(summarySettingsValues(undefined)).toEqual({ summaryEnabled: true, summaryModel: "", digestEnabled: true, retroEnabled: true });
  expect(summarySettingsValues({ summaryEnabled: false })).toEqual({ summaryEnabled: false, summaryModel: "", digestEnabled: true, retroEnabled: true });
});

test("prompt carries the card, previous summary and transcript", () => {
  const prompt = summaryPrompt({
    title: "Login",
    description: "d".repeat(3000),
    lane: "In progress",
    previous: { state: "S", target: "Goal: T", recap: "R", next: "N" },
    transcript: "User: hi",
    language: "en",
  });
  expect(prompt).toContain("Task: Login");
  expect(prompt).toContain("State: S");
  expect(prompt).toContain("Target: Goal: T");
  expect(prompt).toContain('"target"');
  expect(prompt).toContain("User: hi");
  expect(prompt).toContain("revise the current summary");
  expect(prompt).not.toContain("d".repeat(2001));
  expect(summaryPrompt({ title: "x", description: "", lane: "Todo", previous: null, transcript: "", language: "en" })).toContain('"update" must be true');
});

test("summarizer sessions are recognized by label", () => {
  expect(isSummarizer({ labels: { flowly: "summarizer" } })).toBe(true);
  expect(isSummarizer({ labels: { "ultra-kanban": "summarizer" } })).toBe(true);
  expect(isSummarizer({ labels: {} })).toBe(false);
  expect(isSummarizer({})).toBe(false);
});

test("target drops a leading goal label", () => {
  expect(targetText("Goal: 为每个任务提供摘要\n- a")).toBe("为每个任务提供摘要\n- a");
  expect(targetText("目标：完成登录\n- a")).toBe("完成登录\n- a");
  expect(targetText("Ship login\n- Goal: keep")).toBe("Ship login\n- Goal: keep");
  expect(parseModelOutput('{"update":true,"state":"s","target":"goal: x","recap":"","next":""}').target).toBe("x");
});

test("turnText ignores plugin rows, so a summary row is never summarized again (NATIVE-SESSION-SPEC §5.5 #6)", () => {
  const row = { type: "plugin", kind: "flowly-summary", data: { state: "S" } };
  expect(turnText([{ type: "assistant_message", text: "A" }, row])).toBe("Assistant: A");
});

test("model labels name Claude models by family and version", () => {
  expect(modelLabel("claude/claude-haiku-5-5")).toBe("Haiku 5.5");
  expect(modelLabel("claude/claude-sonnet-5")).toBe("Sonnet 5");
  expect(modelLabel("codex/gpt-6-luna")).toBe("GPT-6-Luna");
  expect(modelLabel("claude/claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
});

 test("ordered settings preserve legacy choices and prefer the explicit list", () => {
  expect(summaryModelsOf(summarySettingsValues({}))).toEqual(["claude/claude-haiku-5-5", "codex/gpt-6-luna"]);
  expect(summaryModelsOf(summarySettingsValues({ summaryModel: "codex/gpt-6-luna" }))).toEqual(["codex/gpt-6-luna"]);
  const settings = summarySettingsValues({ summaryModel: "claude/claude-haiku-5-5", summaryModels: ["codex/gpt-6-luna", "claude/claude-haiku-5-5"], summaryEnabled: false });
  expect(summaryModelsOf(settings)).toEqual(["codex/gpt-6-luna", "claude/claude-haiku-5-5"]);
  expect(settings.summaryEnabled).toBe(false);
  expect(resolveModels(settings.summaryModels!, providers(true))).toEqual(settings.summaryModels);
  expect(resolveModels(["missing/none", "codex/gpt-6-luna", "claude/claude-haiku-5-5"], providers(false))).toEqual(["codex/gpt-6-luna"]);
  expect(() => resolveModels(["missing/none"], providers(true))).toThrow(/No configured summary model/);
 });
 test("model lists reject empty, duplicate and malformed choices", () => {
  for (const summaryModels of [[], [""], ["bad"], ["a/b", "a/b"], ["a/b", " a/b "], ["/model"], ["a/"]]) {
    expect(summaryModelsSchema.safeParse(summaryModels).success).toBe(false);
    expect(summarySettings.schema.safeParse({ summaryModels }).success).toBe(false);
  }
  expect(summaryModelsSchema.parse([" a/b ", "c/d"])).toEqual(["a/b", "c/d"]);
 });

test("temporary sessions run Claude in Plan Mode and leave other providers on their default mode", () => {
  expect(readOnlyMode("claude/claude-haiku-5-5")).toBe("plan");
  expect(readOnlyMode("codex/gpt-5.4-mini")).toBeUndefined();
  expect(readOnlyMode("opencode/claude-sonnet")).toBeUndefined();
  expect(readOnlyMode("claude-compass-smith-sqp/claude-sonnet-5-5")).toBe("plan");
  expect(readOnlyMode("claude-aicodewith/claude-sonnet-5-5")).toBe("plan");
  expect(readOnlyMode("codex-compass-smith-sqp/gpt-5.4")).toBeUndefined();
  expect(readOnlyConfig("claude/claude-haiku-5-5")).toEqual({ provider: "claude/claude-haiku-5-5", modeId: "plan" });
  expect(readOnlyConfig("codex/gpt-5.4-mini")).toEqual({ provider: "codex/gpt-5.4-mini" });
});
