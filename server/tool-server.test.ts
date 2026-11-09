import { afterEach, expect, test } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, request } from "node:http";
import { ToolServer } from "./tool-server";
import { SearchService } from "./search";
import { agentFixture } from "./agent-fixture";
import { skillText } from "./skill-source";
import { turnChecklist } from "../shared/turn-checklist";
import { ideasReminder, movesReminder, outputsReminder } from "./reminders";

/** A dispatcher folder in the fixture's own temp Paseo home, never the real one (DISPATCHER-SPEC §2). */
const dispatcherPath = (root: string) => join(root, "paseo-home", "flowly-dispatcher", "dispatcher");

const run = promisify(execFile),
  cleanups: (() => Promise<unknown>)[] = [];
async function setup() {
  const fixture = await agentFixture(),
    server = new ToolServer(fixture.store, dispatcherPath(fixture.root));
  cleanups.push(async () => {
    await server.stop();
    await rm(fixture.root, { recursive: true, force: true });
  });
  await server.start();
  const { url } = JSON.parse(
    await readFile(fixture.store.directory + "/tool-endpoint.json", "utf8"),
  );
  const authorization = "Bearer " + server.secrets.credential(fixture.identity);
  const api = async (action: string, input: unknown = {}) => {
    const response = await fetch(url + "api", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, input }),
    });
    return { status: response.status, ...(await response.json()) };
  };
  return { ...fixture, server, url, authorization, api };
}
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
});
test("MCP initialize/list can precede actor creation; live calls require SDK context", async () => {
  const x = await setup();
  const mcp = async (method: string, params: unknown, id = 1) => {
    const response = await fetch(x.url + "mcp", {
      method: "POST",
      headers: {
        Authorization: x.authorization,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    return JSON.parse(
      response.headers.get("content-type")?.includes("text/event-stream")
        ? body
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .at(-1)!
        : body,
    );
  };
  const initialized = await mcp("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
  expect(initialized.result.protocolVersion).toBe("2025-06-18");
  expect(initialized.result.serverInfo.name).toBe("flowly");
  expect(
    (await mcp("tools/list", {})).result.tools.map(
      (t: { name: string }) => t.name,
    ),
  ).toEqual([
    "flowly_get_task",
    "flowly_update_status",
    "flowly_report_progress",
    "flowly_propose_idea",
    "flowly_update_idea",
    "flowly_remove_idea",
    "flowly_remember",
    "flowly_recall",
    "flowly_search",
    "flowly_add_artifact",
    "flowly_remove_artifact",
    "flowly_read_external",
    "flowly_read_ticket",
    "flowly_set_tags",
    "flowly_set_type",
    "flowly_suggest_next_moves",
    "flowly_update_workpad",
    "flowly_handover",
    "flowly_integrate",
    "flowly_list_cards",
    "flowly_get_card",
    "flowly_create_card",
    "flowly_update_card",
    "flowly_start_card",
  ]);
  // The soft delivery gate and the workpad's own revision are part of the tool schemas (WORKPAD-SPEC §3, §5.3).
  const listed = (await mcp("tools/list", {})).result.tools as { name: string; description: string; inputSchema: { properties: Record<string, unknown> } }[];
  expect(listed.find((t) => t.name === "flowly_update_status")!.inputSchema.properties).toHaveProperty("acknowledgeOpen");
  // The delivery call carries the next moves, and an empty list is a valid choice on every entry (NEXT-MOVES-SPEC §8.2).
  const allowsEmpty = (schema: unknown) => ((schema as { minItems?: number }).minItems ?? 0) === 0;
  for (const name of ["flowly_update_status", "flowly_report_progress"]) {
    const nextMoves = listed.find((t) => t.name === name)!.inputSchema.properties.nextMoves;
    expect(nextMoves, name).toMatchObject({ type: "array", maxItems: 3 });
    expect(allowsEmpty(nextMoves)).toBe(true);
  }
  expect(allowsEmpty(listed.find((t) => t.name === "flowly_suggest_next_moves")!.inputSchema.properties.moves)).toBe(true);
  // The text agents read says where the next moves go (NEXT-MOVES-SPEC §8.6).
  const described = (name: string) => listed.find((t) => t.name === name)!.description;
  expect(described("flowly_update_status")).toMatch(/pass nextMoves/);
  expect(described("flowly_report_progress")).toMatch(/pass nextMoves/);
  expect(described("flowly_suggest_next_moves")).toMatch(/middle of a turn/);
  expect(skillText).toMatch(/pass nextMoves/);
  expect(skillText).toContain("nextMoves: []");
  expect(skillText).toContain("--no-moves");
  expect(skillText).toContain("--no-outputs");
  for (const name of ["flowly_update_status", "flowly_report_progress"]) {
    expect(listed.find((t) => t.name === name)!.inputSchema.properties).toHaveProperty("outputs");
  }
  // Delivery-time reminders (NEXT-MOVES-SPEC §9): the instructions, the tool texts and the result schema all know them.
  expect(skillText).toContain("Every turn that delivers (in_review, committed or integrated), asks (kind=question) or reports a result (kind=result) ends with next moves");
  expect(skillText).toContain("ask through your own question tool when you have one");
  expect(skillText).toContain("Ask each question one way only");
  expect(skillText).toContain("At each delivery (in_review, committed or integrated), review what you noticed");
  // The Committed stage (COMMITTED-STAGE-SPEC §3): when to set it, in the skill, the checklist and the tool text.
  expect(skillText).toContain("Once all of this card's changes are committed (the card's deliveryMode is the user's standing ask to commit, or in draft_pr and ready_pr to commit, push and open the PR at delivery; anything beyond it only when the user asks), set committed");
  expect(skillText).toContain("flowly_update_status(committed) once all of the card's changes are committed");
  expect(described("flowly_update_status")).toContain("Set committed only once all of this card's changes are committed");
  // The Integrated stage (INTEGRATED-STAGE-SPEC §3): same three places.
  expect(skillText).toContain("Once all of this card's commits are in the branch checked out in the main checkout");
  expect(skillText).toContain("Set the furthest status that is true");
  expect(skillText).toContain("flowly_update_status(integrated) once all of its commits are in the main checkout's branch");
  expect(described("flowly_update_status")).toContain("Set integrated only once all of this card's commits are in the branch checked out in the main checkout");
  expect(skillText).toMatch(/reminders array/);
  expect(described("flowly_update_status")).toMatch(/reminders/);
  expect(described("flowly_report_progress")).toMatch(/reminders/);
  expect(skillText).toContain("flowly_suggest_next_moves");
  // Card setup (CARD-SETUP-SPEC §3.5-3.6): the checklist leads the skill, the tool texts name the gate and the timing.
  expect(skillText.split("\n## Start of every turn\n")[0]).not.toContain("\n- ");
  expect(skillText).toContain("fix setup.missing before work");
  expect(skillText).toContain("Small cards also need a type");
  expect(skillText).toContain("SETUP_INCOMPLETE");
  // Delivery mode and "no workspace without a card" (DELIVERY-MODE-SPEC §3-4, START-CARD-SPEC).
  expect(skillText).toContain("Follow the card's deliveryMode (flowly_get_task): branch = commit on the card's branch, no push or PR; draft_pr / ready_pr = push and open a draft / ready PR, then register its URL as an output.");
  expect(skillText).toContain("never bypass the permission prompts for git push or gh pr create; the user answers them");
  expect(skillText).toContain("A session that starts work in a repo without a card attaches to one or creates one before changing files");
  expect(skillText).toContain('flowly_create_card with workspace="worktree"');
  expect(skillText).toContain("one card = one branch or PR");
  expect(skillText).toContain("flowly_propose_idea");
  // Review round 1: the delivery mode is the standing ask, and every mode has a valid next move and Done condition.
  expect(skillText).toContain("the card's deliveryMode is the user's standing ask to commit, or in draft_pr and ready_pr to commit, push and open the PR at delivery; anything beyond it only when the user asks");
  expect(skillText).toContain("(you merge only when the user asks)");
  expect(skillText).toContain("its changes are committed (in draft_pr or ready_pr also pushed, with the PR opened; or nothing needed committing)");
  expect(skillText).toContain("never add it while changes are uncommitted, a draft_pr or ready_pr card's push or PR is still outstanding");
  expect(skillText).toContain("(verify the change, review the branch, continue with the next stage");
  expect(skillText).not.toContain("commit and push");
  expect(described("flowly_suggest_next_moves")).toContain("review the branch");
  expect(described("flowly_suggest_next_moves")).not.toContain("commit and push");
  expect(JSON.stringify(listed.find((t) => t.name === "flowly_update_status")!.inputSchema)).toContain("also pushed, with the PR opened");
  expect(skillText).toContain("In draft_pr mode leave the PR a draft. In ready_pr mode never open a PR as ready, and never mark one ready later, while review notes are open.");
  expect(skillText).toContain('A session outside any card creates the card with flowly_create_card with workspace="worktree" and starts it with flowly_start_card');
  expect(skillText).toContain("the work happens in that card's session");
  expect(skillText).toContain("If this session has already changed files in the main checkout, change nothing more there: tell the user which files changed and let them decide.");
  expect(described("flowly_update_status")).toContain("SETUP_INCOMPLETE");
  expect(described("flowly_get_task")).toContain("setup.missing");
  for (const name of ["flowly_set_type", "flowly_set_tags", "flowly_update_workpad"])
    expect(described(name), name).toContain("at the start of the work, before you change code");
  expect(Object.keys(listed.find((t) => t.name === "flowly_update_workpad")!.inputSchema.properties)).toEqual(
    expect.arrayContaining(["workpadRevision", "acceptance", "validation", "confusions"]),
  );
  const cold = await mcp("tools/call", {
    name: "flowly_get_task",
    arguments: {},
  });
  expect(cold.result.isError).toBe(true);
  expect(JSON.parse(cold.result.content[0].text).code).toBe(
    "PASEO_UNAVAILABLE",
  );
  x.server.attach(x.paseo);
  const read = await mcp("tools/call", {
    name: "flowly_get_task",
    arguments: {},
  });
  expect(read.result.structuredContent.identity).toEqual(x.identity);
  expect(read.result.structuredContent.turnChecklist).toEqual(turnChecklist);
  const ctx = read.result.structuredContent;
  const updated = await mcp("tools/call", {
    name: "flowly_update_status",
    arguments: {
      expectedRevision: ctx.revision,
      request: ctx.request,
      status: "development",
      note: "MCP actual call",
    },
  });
  expect(updated.result.structuredContent.receipt.status).toBe("development");
  expect(updated.result.structuredContent).not.toHaveProperty("reminders");
  // A result without next moves says so in the result itself, ahead of the card's whole context (NEXT-MOVES-SPEC §9.5).
  const reminded = await mcp("tools/call", {
    name: "flowly_report_progress",
    arguments: {
      expectedRevision: updated.result.structuredContent.current.revision,
      request: updated.result.structuredContent.current.request,
      kind: "result",
      note: "A result without next moves",
    },
  });
  expect(reminded.result.isError).toBeUndefined();
  expect(reminded.result.structuredContent.reminders).toEqual([movesReminder, outputsReminder]);
  expect(Object.keys(JSON.parse(reminded.result.content[0].text)).slice(0, 3)).toEqual(["receipt", "replayed", "reminders"]);
  const proposed = await mcp("tools/call", {
    name: "flowly_propose_idea",
    arguments: {
      expectedRevision: reminded.result.structuredContent.current.revision,
      request: reminded.result.structuredContent.current.request,
      title: "Follow-up",
      detail: "Do the next thing.",
      rationale: "Found while working.",
    },
  });
  expect(proposed.result.structuredContent.receipt.action).toBe("idea");
  expect(proposed.result.structuredContent.current.ideas).toEqual([
    { id: proposed.result.structuredContent.ideaId, title: "Follow-up", status: "open", scope: "new" },
  ]);
  // The agent closes an idea the user rejected (IDEAS-SPEC §3.1).
  const dismissedIdea = await mcp("tools/call", {
    name: "flowly_update_idea",
    arguments: {
      expectedRevision: proposed.result.structuredContent.current.revision,
      request: proposed.result.structuredContent.current.request,
      id: proposed.result.structuredContent.ideaId,
      status: "dismissed",
    },
  });
  expect(dismissedIdea.result.structuredContent.receipt.action).toBe("idea_update");
  expect(dismissedIdea.result.structuredContent.current.ideas).toEqual([
    { id: proposed.result.structuredContent.ideaId, title: "Follow-up", status: "dismissed", scope: "new" },
  ]);
  // Over MCP the delivery call carries the next moves, and so does an explicit none (NEXT-MOVES-SPEC §8).
  const moves = [{ label: "Commit", prompt: "Commit and push." }, { label: "Move to Done", moveTo: "done" }];
  const delivered = await mcp("tools/call", {
    name: "flowly_update_status",
    arguments: {
      expectedRevision: dismissedIdea.result.structuredContent.current.revision,
      request: dismissedIdea.result.structuredContent.current.request,
      status: "in_review",
      note: "MCP delivery",
      nextMoves: moves,
    },
  });
  expect(delivered.result.structuredContent.receipt.status).toBe("in_review");
  expect(delivered.result.structuredContent.current.activity.slice(-2)).toMatchObject([{ action: "status_changed", to: "in_review" }, { action: "next_moves_suggested", moves }]);
  const none = await mcp("tools/call", {
    name: "flowly_report_progress",
    arguments: {
      expectedRevision: delivered.result.structuredContent.current.revision,
      request: delivered.result.structuredContent.current.request,
      kind: "result",
      note: "Nothing for the user",
      nextMoves: [],
    },
  });
  expect(none.result.isError).toBeUndefined();
  expect(none.result.structuredContent.current.activity.slice(-2)).toMatchObject([{ action: "progress_reported" }, { action: "next_moves_suggested", moves: [] }]);
});
test("loopback host/origin/credential guards and scoped request validation", async () => {
  const x = await setup();
  x.server.attach(x.paseo);
  const rejectedHeaders: Record<string, string>[] = [
    { Host: "evil.example" },
    { Origin: "https://evil.example" },
    { Authorization: "Bearer invalid" },
  ];
  for (const extra of rejectedHeaders) {
    // Node fetch normalizes Host back to the URL. Use raw HTTP to test rebinding.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        x.url + "api",
        {
          method: "POST",
          headers: {
            Authorization: x.authorization,
            ...extra,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ action: "get", input: {} }));
    });
    expect(status, JSON.stringify(extra)).toBeGreaterThanOrEqual(400);
  }
  const ctx = (await x.api("get")).result;
  expect(
    (
      await x.api("progress", {
        expectedRevision: ctx.revision,
        request: ctx.request,
        note: "x",
        taskId: "other",
      })
    ).error.code,
  ).toBe("INVALID_INPUT");
  expect(
    (
      await x.api("status", {
        expectedRevision: ctx.revision,
        request: ctx.request,
        note: "x",
        status: "done",
      })
    ).error.code,
  ).toBe("INVALID_STATUS");
  const oversized = await fetch(x.url + "api", {
    method: "POST",
    headers: { Authorization: x.authorization },
    body: "x".repeat(70000),
  });
  expect(oversized.status).toBeGreaterThanOrEqual(400);
});
test("prepared ID and scoped files are stable, selected existing actor verified", async () => {
  const x = await setup();
  const [a, b] = await Promise.all([
    x.server.prepareSession("t", "operation", x.paseo),
    x.server.prepareSession("t", "operation", x.paseo),
  ]);
  expect(a.agentId).toBe(b.agentId);
  expect(a.mcp.url).toBe(x.url + "mcp");
  await expect(
    x.server.prepareExisting("t", "wrong", x.paseo),
  ).rejects.toMatchObject({ code: "SESSION_MISMATCH" });
  const existing = await x.server.prepareExisting("t", "actor", x.paseo);
  expect(existing.agentId).toBe("actor");
  expect(existing.instructions).toContain("flowly_get_task");
  expect(existing.cliPath).toBe(x.store.directory + "/flowly.mjs");
  expect(existing.instructions).not.toMatch(/ultra[ _-]kanban|kanban_/i);
  expect(skillText).toContain("name: flowly\n");
  await expect(readFile(x.store.directory + "/ultra-kanban.mjs", "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(existing.skillPath, "utf8")).toBe(skillText);
  expect(await readFile("skills/flowly/SKILL.md", "utf8")).toBe(
    skillText,
  );
  expect((await x.server.accessState("t", "actor", x.paseo)).methods).toContain(
    "cli",
  );
  expect(
    (await x.server.accessState("t", "actor", x.paseo)).lastSuccessAt,
  ).toBeNull();
});
test("CLI runs a complete scoped flow; replay, wrong env, snapshots and flags", async () => {
  const x = await setup(),
    prepared = await x.server.prepareExisting("t", "actor", x.paseo),
    snapshot = x.root + "/snapshot.json";
  const cli = async (...args: string[]) => {
    const result = await run(
      process.execPath,
      [prepared.cliPath, "--context-file", prepared.contextFile, ...args],
      { env: { ...process.env, PASEO_AGENT_ID: "actor" } },
    );
    expect(result.stdout.endsWith("\n")).toBe(true);
    return JSON.parse(result.stdout);
  };
  const current = await cli("current", "--save-request", snapshot);
  expect(current.identity).toEqual(x.identity);
  // Explicit argument > Flowly environment > legacy session environment.
  for (const overrides of [
    { FLOWLY_CONTEXT_FILE: prepared.contextFile, ULTRA_KANBAN_CONTEXT_FILE: "missing" },
    { FLOWLY_CONTEXT_FILE: "", ULTRA_KANBAN_CONTEXT_FILE: prepared.contextFile },
  ]) {
    const result = await run(process.execPath, [prepared.cliPath, "current"], {
      env: { ...process.env, ...overrides, PASEO_AGENT_ID: "actor" },
    });
    expect(JSON.parse(result.stdout).identity).toEqual(x.identity);
  }
  const started = await cli(
    "status",
    "development",
    "--request-file",
    snapshot,
    "--note",
    "CLI starts",
  );
  const replay = await cli(
    "status",
    "development",
    "--request-file",
    snapshot,
    "--note",
    "CLI starts",
  );
  expect(replay).toMatchObject({ receipt: started.receipt, replayed: true });
  await cli("current", "--save-request", snapshot);
  await cli(
    "note",
    "--request-file",
    snapshot,
    "--kind",
    "result",
    "--note",
    "CLI contribution",
  );
  await cli("current", "--save-request", snapshot);
  const finished = await cli(
    "status",
    "in_review",
    "--request-file",
    snapshot,
    "--note",
    "Ready for human review",
  );
  expect(finished.receipt.status).toBe("in_review");
  // The CLI prints the whole result, so the reminders follow the receipt (NEXT-MOVES-SPEC §9.5).
  expect(Object.keys(finished).slice(0, 3)).toEqual(["receipt", "replayed", "reminders"]);
  expect(finished.reminders).toEqual([movesReminder, ideasReminder, outputsReminder]);
  await cli("current", "--save-request", snapshot);
  const tagged = await cli("tags", "--request-file", snapshot, "--add", "Drawer, perf");
  expect(tagged.current.task.tags.map((t: { tag: string }) => t.tag)).toEqual(["fixture", "drawer", "perf"]);
  await cli("current", "--save-request", snapshot);
  const untagged = await cli("tags", "--request-file", snapshot, "--remove", "perf");
  expect(untagged.current.task.tags.map((t: { tag: string }) => t.tag)).toEqual(["fixture", "drawer"]);
  await cli("current", "--save-request", snapshot);
  const suggested = await cli("next-moves", "--request-file", snapshot, "--moves", JSON.stringify([{ label: "Commit", prompt: "Commit and push." }]));
  expect(suggested.receipt.action).toBe("next_moves");
  expect(suggested.current.activity.at(-1)).toMatchObject({ action: "next_moves_suggested", moves: [{ label: "Commit", prompt: "Commit and push." }] });
  // The calls that end a turn carry the moves, or an explicit none (NEXT-MOVES-SPEC §8.4).
  await cli("current", "--save-request", snapshot);
  const delivered = await cli("status", "in_review", "--request-file", snapshot, "--note", "Delivered", "--moves", JSON.stringify([{ label: "Push", prompt: "Push it." }, { label: "Move to Done", moveTo: "done" }]));
  expect(delivered.receipt.action).toBe("status");
  expect(delivered.current.activity.slice(-2)).toMatchObject([{ action: "progress_reported" }, { action: "next_moves_suggested", moves: [{ label: "Push", prompt: "Push it." }, { label: "Move to Done", moveTo: "done" }] }]);
  await cli("current", "--save-request", snapshot);
  const none = await cli("note", "--request-file", snapshot, "--kind", "result", "--note", "Nothing needed", "--no-moves");
  expect(none.receipt.action).toBe("progress");
  expect(none.current.activity.at(-1)).toMatchObject({ action: "next_moves_suggested", moves: [] });
  await cli("current", "--save-request", snapshot);
  const answers = await cli("note", "--request-file", snapshot, "--kind", "question", "--note", "Which one?", "--moves", JSON.stringify([{ label: "Option A", prompt: "Use option A." }]));
  expect(answers.current.activity.at(-1)).toMatchObject({ action: "next_moves_suggested", moves: [{ label: "Option A", prompt: "Use option A." }] });
  await cli("current", "--save-request", snapshot);
  const standaloneNone = await cli("next-moves", "--request-file", snapshot, "--moves", "[]");
  expect(standaloneNone.current.activity.at(-1)).toMatchObject({ action: "next_moves_suggested", moves: [] });
  await cli("current", "--save-request", snapshot);
  const proposed = await cli(
    "idea",
    "--request-file",
    snapshot,
    "--title",
    "CLI idea",
    "--detail",
    "Do it.",
    "--rationale",
    "Seen while testing.",
    "--type",
    "chore",
    "--scope",
    "here",
  );
  expect(proposed.current.ideas).toEqual([{ id: proposed.ideaId, title: "CLI idea", status: "open", scope: "here" }]);
  await cli("current", "--save-request", snapshot);
  const updated = await cli("idea-update", "--request-file", snapshot, "--id", proposed.ideaId, "--title", "CLI idea, sharper", "--scope", "new", "--dismiss");
  expect(updated.receipt.action).toBe("idea_update");
  expect(updated.current.ideas).toEqual([{ id: proposed.ideaId, title: "CLI idea, sharper", status: "dismissed", scope: "new" }]);
  await cli("current", "--save-request", snapshot);
  const removed = await cli("idea-remove", "--request-file", snapshot, "--id", proposed.ideaId);
  expect(removed).toMatchObject({ ideaId: proposed.ideaId, current: { ideas: [] } });
  await cli("current", "--save-request", snapshot);
  for (const args of [
    ["status", "in_review", "--request-file", snapshot, "--note", "n", "--outputs", "not json"],
    ["note", "--kind", "result", "--request-file", snapshot, "--note", "n", "--outputs", "{}"],
    ["note", "--kind", "result", "--request-file", snapshot, "--note", "n", "--outputs", "[]", "--no-outputs"],
    ["status", "development", "--request-file", snapshot, "--note", "n", "--no-outputs"],
    ["note", "--kind", "progress", "--request-file", snapshot, "--note", "n", "--no-outputs"],
    ["current", "--no-outputs"],
    ["idea", "--request-file", snapshot, "--title", "No detail", "--rationale", "r"],
    ["idea-update", "--request-file", snapshot, "--id", "x"],
    ["idea-remove", "--request-file", snapshot],
    ["idea-remove", "--request-file", snapshot, "--id", "x", "--title", "t"],
    ["idea", "--request-file", snapshot, "--title", "t", "--detail", "d", "--rationale", "r", "--dismiss"],
    ["note", "--request-file", snapshot, "--note", "n", "--title", "misplaced"],
    ["next-moves", "--request-file", snapshot, "--moves", "not json"],
    ["note", "--request-file", snapshot, "--note", "n", "--moves", "{}"],
    ["note", "--request-file", snapshot, "--note", "n", "--moves", "[]", "--no-moves"],
    ["status", "in_review", "--request-file", snapshot, "--note", "n", "--moves", "not json"],
    ["next-moves", "--request-file", snapshot, "--no-moves"],
    ["idea", "--request-file", snapshot, "--title", "t", "--detail", "d", "--rationale", "r", "--moves", "[]"],
    ["tags", "--request-file", snapshot, "--add", "x", "--no-moves"],
    ["handover", "--request-file", snapshot],
    ["handover", "--request-file", snapshot, "--files", "a.ts", "--note", "n"],
    ["integrate", "--request-file", snapshot, "--files", "a.ts"],
    ["note", "--request-file", snapshot, "--note", "n", "--ref", "main"],
    ["current", "--no-moves"],
    ["current", "--unknown", "x"],
    [
      "current",
      "--context-file",
      prepared.contextFile,
      "--context-file",
      prepared.contextFile,
    ],
    ["status", "done", "--request-file", snapshot, "--note", "unauthorized"],
    ["note", "--request-file", snapshot, "--note", " "],
  ]) {
    await expect(cli(...args)).rejects.toMatchObject({ code: 1 });
  }
  await expect(
    run(
      process.execPath,
      [prepared.cliPath, "--context-file", prepared.contextFile, "current"],
      { env: { ...process.env, PASEO_AGENT_ID: "different" } },
    ),
  ).rejects.toMatchObject({ code: 1 });
  await writeFile(
    snapshot,
    JSON.stringify({
      ...current,
      identity: { ...x.identity, taskId: "wrong" },
    }),
  );
  await expect(
    cli("note", "--request-file", snapshot, "--note", "wrong"),
  ).rejects.toMatchObject({ code: 1 });
}, 30_000); // a long sequence of real CLI processes; slow under a parallel full run
test("same port and credentials survive cleanup/reload; cold error recovers with SDK callback", async () => {
  const x = await setup();
  x.server.attach(x.paseo);
  const ctx = (await x.api("get")).result,
    input = {
      expectedRevision: ctx.revision,
      request: ctx.request,
      note: "persisted",
    };
  const first = (await x.api("progress", input)).result;
  await x.server.stop();
  await writeFile(x.store.directory + "/ultra-kanban.mjs", "old CLI");
  const restored = new ToolServer(x.store, dispatcherPath(x.root));
  cleanups.push(() => restored.stop());
  await restored.start();
  expect(
    JSON.parse(
      await readFile(x.store.directory + "/tool-endpoint.json", "utf8"),
    ).url,
  ).toBe(x.url);
  expect((await x.api("get")).error.code).toBe("PASEO_UNAVAILABLE");
  restored.attach(x.paseo);
  expect(await readFile(x.store.directory + "/ultra-kanban.mjs", "utf8")).toBe(
    await readFile(x.store.directory + "/flowly.mjs", "utf8"),
  );
  const legacy = await run(process.execPath, [x.store.directory + "/ultra-kanban.mjs", "current"], {
    env: { ...process.env, FLOWLY_CONTEXT_FILE: "", ULTRA_KANBAN_CONTEXT_FILE: await restored.secrets.writeContext(x.identity, "cli"), PASEO_AGENT_ID: "actor" },
  });
  expect(JSON.parse(legacy.stdout).identity).toEqual(x.identity);
  const replay = (await x.api("progress", input)).result;
  expect(replay).toMatchObject({ receipt: first.receipt, replayed: true });
});

test("CLI outputs and first refusal: real transport, persisted IDs and exact replay", async () => {
  const x = await setup();
  const prepared = await x.server.prepareExisting("t", "actor", x.paseo);
  const snapshot = `${x.root}/outputs-request.json`;
  const cli = async (...args: string[]) => JSON.parse((await run(process.execPath, [prepared.cliPath, "--context-file", prepared.contextFile, ...args], { env: { ...process.env, PASEO_AGENT_ID: "actor" } })).stdout);
  await cli("current", "--save-request", snapshot);
  const args = ["status", "in_review", "--request-file", snapshot, "--note", "Output registered", "--outputs", JSON.stringify([{ target: "https://github.com/fixture/repo/pull/1" }]), "--no-moves"];
  const delivered = await cli(...args);
  expect(delivered.receipt.artifactIds).toEqual([delivered.current.artifacts[0].id]);
  expect(delivered.current.artifacts[0].role).toBe("output");
  expect(delivered.reminders).not.toContain(outputsReminder);
  expect(await cli(...args)).toMatchObject({ replayed: true, receipt: delivered.receipt });
  await cli("current", "--save-request", snapshot);
  expect((await cli("note", "--kind", "result", "--request-file", snapshot, "--note", "No outputs", "--no-outputs", "--no-moves")).receipt.artifactIds).toEqual([]);
  // status committed takes outputs and a Done move like in_review (COMMITTED-STAGE-SPEC §3).
  await cli("current", "--save-request", snapshot);
  const committed = await cli("status", "committed", "--request-file", snapshot, "--note", "Committed abc1234 and pushed", "--outputs", JSON.stringify([{ target: "https://github.com/fixture/repo/pull/2" }]), "--moves", JSON.stringify([{ label: "Move to Done", moveTo: "done" }]));
  expect(committed.receipt).toMatchObject({ status: "committed", artifactIds: [expect.any(String)] });
  expect(committed.current.activity.at(-1)).toMatchObject({ action: "next_moves_suggested", moves: [{ label: "Move to Done", moveTo: "done" }] });
  // status integrated as well (INTEGRATED-STAGE-SPEC §3).
  await cli("current", "--save-request", snapshot);
  const integrated = await cli("status", "integrated", "--request-file", snapshot, "--note", "Merged abc1234 into main in the main checkout; not pushed", "--outputs", JSON.stringify([{ target: "https://github.com/fixture/repo/pull/3" }]), "--moves", JSON.stringify([{ label: "Move to Done", moveTo: "done" }]));
  expect(integrated.receipt).toMatchObject({ status: "integrated", artifactIds: [expect.any(String)] });
  expect(integrated.current.activity.at(-1)).toMatchObject({ action: "next_moves_suggested", moves: [{ label: "Move to Done", moveTo: "done" }] });
  await x.store.mutate((board) => { board.tasks[0].status = "development"; board.tasks[0].revision++; delete board.tasks[0].tags; });
  await cli("current", "--save-request", snapshot);
  const ack = ["status", "in_review", "--request-file", snapshot, "--note", "No tags: deliberately omitted for this gate fixture", "--acknowledge-open", "--no-outputs", "--no-moves"];
  const before = await readFile(x.store.path, "utf8");
  await expect(cli(...ack)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("SETUP_INCOMPLETE") });
  expect(await readFile(x.store.path, "utf8")).toBe(before);
  expect((await cli(...ack)).receipt.status).toBe("in_review");
});
test("flowly_search over HTTP and the CLI: this project only, own card excluded, same result (SEARCH-SPEC §6)", async () => {
  const x = await setup();
  const prepared = await x.server.prepareExisting("t", "actor", x.paseo);
  const stamp = new Date().toISOString();
  await x.store.mutate((board) => {
    const base = board.tasks[0];
    board.tasks[0].title = "Searchable own card";
    board.tasks.push({ ...base, id: "u", workspaceId: "w2", operationId: "u", title: "Searchable earlier card", tags: [] });
    board.projects.push({ ...board.projects[0], id: "q", paseoProjectId: "other" });
    board.tasks.push({ ...base, id: "v", projectId: "q", workspaceId: "w3", operationId: "v", title: "Searchable other project" });
    board.events.push({ id: "n1", taskId: "u", actor: "agent", action: "progress_reported", note: "verified with npm test", at: stamp });
  });
  x.server.agents.search = new SearchService({
    board: () => x.store.read(),
    summaries: { path: x.root + "/no-summaries.json", read: async () => [{ id: "s", taskId: "u", at: stamp, model: "m", agentIds: [], state: "Done", target: "", recap: "Shipped", next: "" }] },
    memory: { path: x.root + "/no-memory.json", read: async () => [] },
    memoryOn: () => true,
    ideasOn: async () => true,
    artifactsOn: async () => true,
  });
  const http = (await x.api("search", { query: "searchable" })).result;
  expect(http.cards.map((c: { taskId: string }) => c.taskId)).toEqual(["u"]);
  expect(http.cards[0]).toMatchObject({ title: "Searchable earlier card", summary: "Done\nShipped", archived: false });
  expect((await x.api("search", { query: "npm test", sources: ["note"] })).result.cards[0].hits[0]).toEqual({ source: "note", snippet: "verified with npm test" });
  expect((await x.api("search", { query: "" })).error.code).toBe("INVALID_INPUT");
  const cli = await run(process.execPath, [prepared.cliPath, "--context-file", prepared.contextFile, "search", "--query", "searchable"], { env: { ...process.env, PASEO_AGENT_ID: "actor" } });
  expect(JSON.parse(cli.stdout)).toEqual(http);
  await expect(run(process.execPath, [prepared.cliPath, "--context-file", prepared.contextFile, "search", "--query", "x", "--limit", "zero"], { env: { ...process.env, PASEO_AGENT_ID: "actor" } })).rejects.toMatchObject({ stderr: expect.stringContaining("--limit") });
});
test("port collision preserves discovery/key/board; after conflict removal listener recovers", async () => {
  const x = await setup(),
    before = await readFile(x.store.path, "utf8"),
    endpoint = await readFile(
      x.store.directory + "/tool-endpoint.json",
      "utf8",
    );
  const { port } = JSON.parse(endpoint);
  await x.server.stop();
  const blocker = createServer();
  await new Promise<void>((resolve) =>
    blocker.listen(port, "127.0.0.1", resolve),
  );
  cleanups.push(
    () => new Promise<void>((resolve) => blocker.close(() => resolve())),
  );
  const restored = new ToolServer(x.store, dispatcherPath(x.root));
  cleanups.push(() => restored.stop());
  await expect(restored.start()).rejects.toMatchObject({
    code: "TOOLS_UNAVAILABLE",
  });
  expect(restored.health().listening).toBe(false);
  expect(await readFile(x.store.path, "utf8")).toBe(before);
  expect(
    await readFile(x.store.directory + "/tool-endpoint.json", "utf8"),
  ).toBe(endpoint);
  await x.store.editTask({
    id: "t",
    revision: 1,
    title: "Human board still works",
    actor: "human",
  });
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
  await restored.start();
  expect(restored.health().listening).toBe(true);
});
test("session_open injection is limited to Kanban-managed sessions", async () => {
  const x = await setup();
  // A session in the card workspace that the plugin never prepared gets nothing.
  expect(await x.server.sessionContext("unmanaged-agent", x.identity.workspaceId, x.paseo)).toBeNull();
  expect(await x.server.secrets.hasContext("unmanaged-agent")).toBe(false);
  expect(await x.server.secrets.hasContext("../escape")).toBe(false);
  // Once prepared (card launch or explicit opt-in), reopening refreshes its context.
  await x.server.secrets.writeContext(x.identity, "mcp");
  const path = await x.server.sessionContext(x.identity.agentId, x.identity.workspaceId, x.paseo);
  expect(path).toBe(x.server.secrets.contextFile(x.identity.agentId));
  expect(JSON.parse(await readFile(path!, "utf8")).methods).toEqual(["mcp", "cli"]);
});
test("only the stored dispatcher's session gets a dispatcher credential (DISPATCHER-SPEC §3)", async () => {
  const x = await setup();
  // No dispatcher yet: nobody gets one.
  expect(await x.server.dispatcherSession("current", x.paseo)).toBeNull();
  await x.server.stop();
  const restored = new ToolServer(x.store, dispatcherPath(x.root));
  cleanups.push(() => restored.stop());
  await writeFile(x.store.directory + "/dispatcher.json", JSON.stringify({ version: 1, workspaceId: "dw", agentId: "current", startedAt: null }));
  const config = (await restored.dispatcherSession("current", x.paseo))!;
  expect(config).toMatchObject({ type: "http" });
  expect(restored.secrets.authenticateAny(config.headers.Authorization.slice(7))).toEqual({ kind: "dispatcher", identity: { agentId: "current", workspaceId: "dw" } });
  // A replaced dispatcher's session, a card session and any other session get none.
  for (const id of ["replaced-earlier-dispatcher", x.identity.agentId, "someone"]) expect(await restored.dispatcherSession(id, x.paseo), id).toBeNull();
});
test("sessions outside cards: a board credential reaches only the card tools, over MCP only (AGENT-CARDS-SPEC §2.2)", async () => {
  const x = await setup();
  x.server.attach(x.paseo);
  // Only a session whose workspace belongs to the Flowly project's native project gets the server.
  expect(await x.server.boardServer({ agentId: "second", workspaceId: "w" }, x.paseo)).toBeNull();
  x.setWorkspace({ ...x.workspace(), projectId: "native" });
  const config = (await x.server.boardServer({ agentId: "second", workspaceId: "w" }, x.paseo))!;
  expect(config).toMatchObject({ type: "http", url: x.url + "mcp" });
  // A card session already has the tools on its own server.
  await x.server.secrets.writeContext(x.identity, "mcp");
  expect(await x.server.boardServer({ agentId: "actor", workspaceId: "w" }, x.paseo)).toBeNull();
  const mcp = async (method: string, params: unknown) => {
    const response = await fetch(x.url + "mcp", {
      method: "POST",
      headers: { ...config.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await response.text();
    return JSON.parse(
      response.headers.get("content-type")?.includes("text/event-stream")
        ? body.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).at(-1)!
        : body,
    );
  };
  await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  expect((await mcp("tools/list", {})).result.tools.map((t: { name: string }) => t.name)).toEqual([
    "flowly_list_cards",
    "flowly_get_card",
    "flowly_create_card",
    "flowly_update_card",
    "flowly_start_card",
    "flowly_propose_idea",
  ]);
  const proposed = await mcp("tools/call", {
    name: "flowly_propose_idea",
    arguments: { title: "Cache the board", detail: "Keep the last read", rationale: "Reads dominate" },
  });
  expect(proposed.result.structuredContent).toMatchObject({ idea: { title: "Cache the board", projectId: "p", agentId: "second", status: "open" } });
  const stored = (await x.store.read()).ideas.at(-1)!;
  expect(stored).toMatchObject({ projectId: "p", agentId: "second", title: "Cache the board" });
  expect(stored.taskId).toBeUndefined();
  const again = await mcp("tools/call", { name: "flowly_propose_idea", arguments: { title: "cache the BOARD", detail: "x", rationale: "y" } });
  expect(again.result.isError).toBe(true);
  expect(JSON.stringify(again.result)).toContain("DUPLICATE_IDEA");
  const listed = await mcp("tools/call", { name: "flowly_list_cards", arguments: {} });
  expect(listed.result.structuredContent.cards.map((c: { taskId: string }) => c.taskId)).toEqual(["t"]);
  const updated = await mcp("tools/call", { name: "flowly_update_card", arguments: { taskId: "t", revision: 1, title: "Renamed by an outside session" } });
  expect(updated.result.structuredContent).toMatchObject({ changed: ["title"], card: { revision: 2 } });
  expect((await x.store.read()).events.at(-1)).toMatchObject({ actor: "agent", agentId: "second", action: "edited" });
  const card = await mcp("tools/call", { name: "flowly_get_task", arguments: {} });
  expect(card.result?.isError ?? !!card.error).toBe(true);
  // The CLI endpoint takes card credentials only.
  const api = await fetch(x.url + "api", {
    method: "POST",
    headers: { ...config.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "list_cards", input: {} }),
  });
  expect(api.status).toBe(401);
  // A card credential is never read as a board one, and a tampered board credential is refused.
  expect(x.server.secrets.authenticateAny(x.authorization.slice(7)).kind).toBe("card");
  expect(() => x.server.secrets.authenticateAny(config.headers.Authorization.slice(7) + "x")).toThrow();
});
test("card sessions reach the card tools over the CLI (AGENT-CARDS-SPEC §5)", async () => {
  const x = await setup();
  x.server.attach(x.paseo);
  const prepared = await x.server.prepareExisting("t", "actor", x.paseo);
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await run(process.execPath, [prepared.cliPath, "--context-file", prepared.contextFile, ...args], {
          env: { ...process.env, PASEO_AGENT_ID: "actor" },
        })
      ).stdout,
    );
  expect((await cli("cards")).cards.map((c: { taskId: string }) => c.taskId)).toEqual(["t"]);
  expect((await cli("cards", "--input", JSON.stringify({ status: ["backlog"] }))).cards).toEqual([]);
  expect((await cli("card", "--id", "t")).card).toMatchObject({ taskId: "t", revision: 1 });
  const updated = await cli("update-card", "--input", JSON.stringify({ taskId: "t", revision: 1, priority: "high" }));
  expect(updated).toMatchObject({ changed: ["priority"], card: { priority: "high", revision: 2 } });
  await expect(cli("update-card")).rejects.toMatchObject({ stderr: expect.stringContaining("update-card requires --input") });
  await expect(cli("card", "--id", "t", "--input", "{}")).rejects.toMatchObject({ stderr: expect.stringContaining("--input is only valid") });
  expect((await x.api("get_card", { taskId: "t" })).result.card.priority).toBe("high");
});
