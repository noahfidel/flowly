import { expect, test } from "vitest";
import { TOOL_ARGS_MAX, TOOL_RESULT_MAX, previewText, toolCallDetailSchema, toolCallView } from "./tool-call-detail";
import { maskSecrets } from "./secrets";

const call = (detail: unknown, extra: Record<string, unknown> = {}) => ({ type: "tool_call", callId: "c", name: "x", status: "completed", detail, ...extra });

test("shell: command, directory, output and exit code", () => {
  expect(toolCallView(call({ type: "shell", command: "npm test", cwd: "/repo", output: "ok", exitCode: 1 }))).toEqual({
    found: true,
    label: "/repo",
    args: "npm test",
    result: "ok",
    exitCode: 1,
  });
});

test("read, write and edit name their file", () => {
  expect(toolCallView(call({ type: "read", filePath: "/a.ts", offset: 10, limit: 5, content: "line" }))).toEqual({
    found: true,
    args: "/a.ts\noffset: 10\nlimit: 5",
    result: "line",
  });
  expect(toolCallView(call({ type: "write", filePath: "/b.ts", content: "x = 1" }))).toEqual({ found: true, label: "/b.ts", args: "x = 1" });
  expect(toolCallView(call({ type: "edit", filePath: "/c.ts", oldString: "a", newString: "b" }))).toEqual({
    found: true,
    label: "/c.ts",
    edits: [{ old: "a", new: "b" }],
  });
  expect(toolCallView(call({ type: "edit", filePath: "/c.ts", unifiedDiff: "@@ -1 +1 @@\n-a\n+b" }))).toEqual({
    found: true,
    label: "/c.ts",
    args: "@@ -1 +1 @@\n-a\n+b",
  });
});

test("search, fetch, subagent, plan and plain text", () => {
  expect(toolCallView(call({ type: "search", query: "TODO", toolName: "grep", filePaths: ["a.ts", "b.ts"] }))).toEqual({
    found: true,
    label: "grep",
    args: "TODO",
    result: "a.ts\nb.ts",
  });
  expect(toolCallView(call({ type: "fetch", url: "https://x.dev", prompt: "summarize", result: "done" }))).toEqual({
    found: true,
    args: "https://x.dev\n\nsummarize",
    result: "done",
  });
  expect(toolCallView(call({ type: "sub_agent", subAgentType: "Explore", description: "find it", actions: [{ index: 0, toolName: "Read", summary: "a.ts" }] }))).toEqual({
    found: true,
    label: "Explore",
    args: "find it",
    result: "Read · a.ts",
  });
  expect(toolCallView(call({ type: "plan", text: "1. do" }))).toEqual({ found: true, args: "1. do" });
  expect(toolCallView(call({ type: "plain_text", label: "Note", text: "hi" }))).toEqual({ found: true, label: "Note", args: "hi" });
});

test("unknown: the input as JSON and an MCP result's text flattened", () => {
  const view = toolCallView(
    call({
      type: "unknown",
      input: { taskId: "t1", text: "hello" },
      output: { content: [{ type: "text", text: "first" }, { type: "image" }, { type: "text", text: "second" }], isError: true },
    }),
  );
  expect(view).toEqual({ found: true, args: '{\n  "taskId": "t1",\n  "text": "hello"\n}', result: "first\nsecond", resultError: true });
  // A plain object output without MCP content stays JSON.
  expect(toolCallView(call({ type: "unknown", input: "raw", output: { ok: true } }))).toMatchObject({ args: "raw", result: '{\n  "ok": true\n}' });
});

test("a call without input says so; a failed call keeps its error", () => {
  expect(toolCallView(call({ type: "unknown", input: null, output: null }))).toEqual({ found: true, argsMissing: true });
  expect(toolCallView(call({ type: "unknown", input: {}, output: null }))).toEqual({ found: true, argsMissing: true });
  expect(toolCallView({ type: "tool_call", callId: "c" })).toEqual({ found: true, argsMissing: true });
  expect(toolCallView(call({ type: "shell", command: "false" }, { status: "failed", error: { message: "boom" } }))).toEqual({
    found: true,
    args: "false",
    error: "boom",
  });
  // A raw input outside `detail` is still shown.
  expect(toolCallView({ type: "tool_call", input: { a: 1 } })).toEqual({ found: true, args: '{\n  "a": 1\n}' });
});

test("credentials are masked in every section", () => {
  const view = toolCallView(
    call(
      { type: "shell", command: "GITHUB_TOKEN=abc123 curl -H 'Authorization: Bearer xyzxyzxyz' https://u:p@x.dev", cwd: "/r", output: "key ghp_abcdefghijklmnopqrstuvwxyz" },
      { error: "sk-abcdefghijklmnopqrstuv" },
    ),
  );
  expect(view.args).toBe("GITHUB_TOKEN=<secret> curl -H 'Authorization: Bearer <secret>' https://<secret>@x.dev");
  expect(view.result).toBe("key <secret>");
  expect(view.error).toBe("<secret>");
  const json = toolCallView(call({ type: "unknown", input: { apiKey: "supersecretvalue", path: "/Users/me/a.ts" }, output: null }));
  expect(json.args).toBe('{\n  "apiKey": "<secret>",\n  "path": "/Users/me/a.ts"\n}');
  expect(maskSecrets("AKIAABCDEFGHIJKLMNOP and glpat-abcdefghijklmnop12 and someone@example.com")).toBe("<secret> and <secret> and someone@example.com");
});

test("a token after a JSON escape is masked, in raw input and in text", () => {
  const view = toolCallView(
    call({ type: "unknown", input: { content: "line1\nghp_ABCDEFGHIJKLMNOPQRSTUV", note: "x\tAKIAABCDEFGHIJKLMNOP" }, output: { log: "a\r\nsk-abcdefghijklmnopqrstuv" } }),
  );
  expect(view.args).not.toMatch(/ghp_|AKIA/);
  expect(view.args).toContain('"content": "line1\\n<secret>"');
  expect(view.args).toContain('"note": "x\\t<secret>"');
  expect(view.result).not.toContain("sk-");
  // Already-escaped text (a JSON string inside a string) is caught by the text masker.
  expect(maskSecrets('{"content":"line1\\nghp_ABCDEFGHIJKLMNOPQRSTUV"}')).toBe('{"content":"line1\\n<secret>"}');
  expect(maskSecrets('"a\\tAKIAABCDEFGHIJKLMNOP"')).toBe('"a\\t<secret>"');
  expect(maskSecrets('"\\u0041ghp_ABCDEFGHIJKLMNOPQRSTUV"')).toBe('"\\u0041<secret>"');
});

test("credential-named values are masked in every common form", () => {
  expect(maskSecrets("PASSWORD=hunter2 TOKEN=abc next")).toBe("PASSWORD=<secret> TOKEN=<secret> next");
  expect(maskSecrets('{"password":"p","token":"t","secret":"s","key":"k","name":"n"}')).toBe(
    '{"password":"<secret>","token":"<secret>","secret":"<secret>","key":"<secret>","name":"n"}',
  );
  expect(maskSecrets('{"headers":{"Authorization":"Bearer abcdefghijkl"}}')).toBe('{"headers":{"Authorization":"<secret>"}}');
  expect(maskSecrets('{"x-api-key":"abcdef"}')).toBe('{"x-api-key":"<secret>"}');
  expect(maskSecrets("api_key: abcdefghijklmnop12")).toBe("api_key: <secret>");
  expect(maskSecrets('{"API_KEY":"has a space in it","DB_PASSWORD":"short7"}')).toBe('{"API_KEY":"<secret>","DB_PASSWORD":"<secret>"}');
  expect(maskSecrets("postgres://user:pa55word@host:5432/db and redis://:pw@cache")).toBe("postgres://<secret>@host:5432/db and redis://<secret>@cache");
  // Not a credential: left alone; an empty value stays empty; comparisons are not assignments.
  expect(maskSecrets('{"name":"n","author":"Noah","password":""} if (token === x)')).toBe('{"name":"n","author":"Noah","password":""} if (token === x)');
  // Raw input: a credential-named key's value is replaced whatever it holds; keys are masked too.
  const view = toolCallView(
    call({ type: "unknown", input: { headers: { Authorization: "Bearer abc def", "x-api-key": "k1" }, password: "a b", pin: 12, ghp_ABCDEFGHIJKLMNOPQRSTUV: 1 }, output: null }),
  );
  expect(JSON.parse(view.args!)).toEqual({ headers: { Authorization: "<secret>", "x-api-key": "<secret>" }, password: "<secret>", pin: 12, "<secret>": 1 });
});

test("masking stays fast on long word runs", () => {
  const long = "aKEY".repeat(50_000);
  let start = Date.now();
  expect(maskSecrets(long)).toBe(long);
  expect(maskSecrets(`${long}=v`)).toBe(`${long}=<secret>`);
  expect(maskSecrets("-eyJ".repeat(50_000)).length).toBeGreaterThan(0);
  expect(maskSecrets("https".repeat(40_000)).length).toBe(200_000);
  expect(Date.now() - start).toBeLessThan(1000);
  start = Date.now();
  const view = toolCallView(call({ type: "shell", command: long, output: long }));
  expect(view.argsTruncated).toBe(true);
  expect(view.resultTruncated).toBe(true);
  expect(Date.now() - start).toBeLessThan(1000);
});

test("long arguments and results are clipped with a flag", () => {
  const view = toolCallView(call({ type: "shell", command: "a".repeat(TOOL_ARGS_MAX + 50), output: "b".repeat(TOOL_RESULT_MAX + 50) }));
  expect(view.args).toHaveLength(TOOL_ARGS_MAX);
  expect(view.argsTruncated).toBe(true);
  expect(view.result).toHaveLength(TOOL_RESULT_MAX);
  expect(view.resultTruncated).toBe(true);
  const edit = toolCallView(call({ type: "edit", filePath: "/x", oldString: "o".repeat(TOOL_ARGS_MAX), newString: "n" }));
  expect(edit.argsTruncated).toBe(true);
  expect(edit.edits?.[0].new).toBe("n");
  expect(toolCallDetailSchema.parse(view)).toEqual(view);
});

test("previewText cuts at lines or characters", () => {
  expect(previewText("a\nb\nc", 5, 100)).toEqual({ text: "a\nb\nc", truncated: false });
  expect(previewText("a\nb\nc\nd", 2, 100)).toEqual({ text: "a\nb…", truncated: true });
  expect(previewText("abcdefghij", 5, 4)).toEqual({ text: "abcd…", truncated: true });
  expect(previewText("abc\n", 1, 100)).toEqual({ text: "abc…", truncated: true });
  expect(previewText("", 3, 10)).toEqual({ text: "", truncated: false });
});
