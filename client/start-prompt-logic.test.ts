import { describe, expect, test } from "vitest";
import { cardPromptState, drawerStartReady, drawerStartText, previewCardId, previewCards, previewPromptState, startPromptBlocksSave, startPromptPreview } from "./start-prompt-logic";
import { defaultSessionStartText } from "../shared/session-start";
import type { Artifact, Project, Task } from "../shared/model";

const project = { id: "p", lanes: undefined } as unknown as Project;
const card = (id: string, over: Partial<Task> = {}): Task =>
  ({
    id,
    projectId: "p",
    title: `Card ${id}`,
    description: "",
    status: "todo",
    createdAt: "2026-11-01T00:00:00.000Z",
    archivedAt: null,
    workspaceId: `w-${id}`,
    ...over,
  }) as Task;
const planArtifact = (taskId: string, approved: boolean): Artifact =>
  ({ id: "a1", taskId, role: "input", kind: "file", title: "Plan", target: "./plan.md", plan: { approvedAt: approved ? "2026-11-02T00:00:00.000Z" : undefined } }) as unknown as Artifact;

const template = "{{#if plan}}Run the plan {{plan}}.{{else}}Design {{title}} ({{laneName}}, {{deliveryMode}}).{{/if}}";

describe("Start prompt preview cards (START-PROMPT-TEMPLATE-SPEC §5)", () => {
  test("only the project's live cards outside Done and Cancelled, newest first", () => {
    const tasks = [
      card("old", { createdAt: "2026-10-01T00:00:00.000Z" }),
      card("new", { createdAt: "2026-11-20T00:00:00.000Z" }),
      card("done", { status: "done", createdAt: "2026-11-25T00:00:00.000Z" }),
      card("cancelled", { status: "cancelled", createdAt: "2026-11-25T00:00:00.000Z" }),
      card("archived", { archivedAt: "2026-11-21T00:00:00.000Z", createdAt: "2026-11-25T00:00:00.000Z" }),
      card("other", { projectId: "q", createdAt: "2026-11-25T00:00:00.000Z" }),
      card("mid", { status: "in_progress" as Task["status"], createdAt: "2026-11-10T00:00:00.000Z" }),
    ];
    expect(previewCards(tasks, "p").map((t) => t.id)).toEqual(["new", "mid", "old"]);
  });
  test("the chosen card while it is listed, else the first", () => {
    const cards = [card("a"), card("b")];
    expect(previewCardId(cards, "b")).toBe("b");
    expect(previewCardId(cards, "")).toBe("a");
    expect(previewCardId(cards, "gone")).toBe("a");
    expect(previewCardId([], "a")).toBe("");
  });
});

describe("Start prompt preview text", () => {
  const state = cardPromptState({ project, task: card("a", { title: "Login" }), detail: null, deliveryMode: "draft_pr", firstSession: true });
  test("an empty field shows what the drawer opens with today", () => {
    expect(startPromptPreview("", state)).toEqual({ kind: "text", text: defaultSessionStartText });
    expect(startPromptPreview("  \n", state)).toEqual({ kind: "text", text: defaultSessionStartText });
  });
  test("a template renders for the card", () => {
    expect(startPromptPreview(template, state)).toEqual({ kind: "text", text: "Design Login (Todo, draft_pr)." });
  });
  test("a parse error is shown with its line, even without a card", () => {
    expect(startPromptPreview("Hello\n{{#if plan}}x", state)).toEqual({ kind: "error", error: "Unclosed {{#if}}", line: 2 });
    expect(startPromptPreview("{{nope}}", null)).toEqual({ kind: "error", error: 'Unknown variable "nope"', line: 1 });
  });
  test("a template that renders empty counts as none", () => {
    expect(startPromptPreview("{{#if plan}}x{{/if}}", state)).toEqual({ kind: "text", text: defaultSessionStartText });
  });
  test("no card: no preview", () => {
    expect(startPromptPreview(template, null)).toBeNull();
    expect(startPromptPreview("", null)).toBeNull();
  });
});

describe("card state on the client", () => {
  test("the card's artifacts come from its detail; a file plan resolves against the workspace", () => {
    const task = card("a");
    const detail = { artifacts: [planArtifact("a", true)], links: [], relatedTasks: [], events: [] };
    const state = cardPromptState({ project, task, detail, deliveryMode: "branch", firstSession: false, workspaceDir: "/repo" });
    expect(state.plan).toBe("/repo/plan.md");
    expect(state.planApproved).toBe(true);
    expect(state.firstSession).toBe(false);
  });
  test("without its detail the card renders with no artifacts or links", () => {
    const state = cardPromptState({ project, task: card("a"), detail: undefined, deliveryMode: "branch", firstSession: true });
    expect(state.plan).toBe("");
    expect(state.inputs).toEqual([]);
    expect(state.links).toEqual([]);
  });
  test("the settings preview counts a card as started once an agent wrote an event on it", () => {
    const task = card("a");
    const quiet = { artifacts: [], links: [], relatedTasks: [], events: [{ taskId: "a" }] };
    const started = { artifacts: [], links: [], relatedTasks: [], events: [{ taskId: "a", agentId: "s1" }] };
    expect(previewPromptState({ project, task, detail: quiet as never, deliveryMode: "branch" }).firstSession).toBe(true);
    expect(previewPromptState({ project, task, detail: started as never, deliveryMode: "branch" }).firstSession).toBe(false);
  });
});

describe("drawer New session text (START-PROMPT-TEMPLATE-SPEC §4)", () => {
  const state = cardPromptState({ project, task: card("a", { title: "Login" }), detail: null, deliveryMode: "branch", firstSession: true });
  test("no template: the built-in text, as today", () => {
    expect(drawerStartText({}, state)).toBe(defaultSessionStartText);
    expect(drawerStartText({ sessionStartText: "  " }, state)).toBe(defaultSessionStartText);
  });
  test("a plain text opens as it is, as today", () => {
    expect(drawerStartText({ sessionStartText: "Read AGENTS.md first." }, state)).toBe("Read AGENTS.md first.");
  });
  test("a template opens rendered for the card", () => {
    expect(drawerStartText({ sessionStartText: template }, state)).toBe("Design Login (Todo, branch).");
  });
  test("a template that does not parse or renders empty falls back to the built-in text", () => {
    expect(drawerStartText({ sessionStartText: "{{#if plan}}" }, state)).toBe(defaultSessionStartText);
    expect(drawerStartText({ sessionStartText: "{{#if plan}}x{{/if}}" }, state)).toBe(defaultSessionStartText);
  });
});

describe("when the drawer may render the Start prompt (START-PROMPT-TEMPLATE-SPEC §4)", () => {
  const loaded = { detail: "loaded", sessions: "loaded" } as const;
  test("no template: at once, as today", () => {
    expect(drawerStartReady({}, { detail: "loading", sessions: "loading" })).toBe(true);
    expect(drawerStartReady({ sessionStartText: " " }, { detail: "loading", sessions: "loading" })).toBe(true);
  });
  test("a template waits for the card's detail and its sessions", () => {
    expect(drawerStartReady({ sessionStartText: template }, { detail: "loading", sessions: "loaded" })).toBe(false);
    expect(drawerStartReady({ sessionStartText: template }, { detail: "loaded", sessions: "loading" })).toBe(false);
    expect(drawerStartReady({ sessionStartText: template }, loaded)).toBe(true);
  });
  test("a failed read does not block: the template renders without it", () => {
    expect(drawerStartReady({ sessionStartText: template }, { detail: "failed", sessions: "loaded" })).toBe(true);
    expect(drawerStartReady({ sessionStartText: template }, { detail: "loaded", sessions: "failed" })).toBe(true);
  });
  test("an approved plan is only seen once the detail is loaded", () => {
    const approved = "{{#if planApproved}}Run {{plan}}{{else}}Design first{{/if}}";
    const task = card("a");
    const detail = { artifacts: [planArtifact("a", true)], links: [], relatedTasks: [], events: [] };
    const before = cardPromptState({ project, task, detail: undefined, deliveryMode: "branch", firstSession: true });
    const after = cardPromptState({ project, task, detail, deliveryMode: "branch", firstSession: false, workspaceDir: "/repo" });
    expect(drawerStartReady({ sessionStartText: approved }, { detail: "loading", sessions: "loading" })).toBe(false);
    expect(drawerStartText({ sessionStartText: approved }, before)).toBe("Design first");
    expect(drawerStartText({ sessionStartText: approved }, after)).toBe("Run /repo/plan.md");
  });
});

describe("Save and an invalid Start prompt (START-PROMPT-TEMPLATE-SPEC §5)", () => {
  test("an edited template that does not parse blocks Save", () => {
    expect(startPromptBlocksSave("{{#if plan}}", "")).toBe(true);
    expect(startPromptBlocksSave("{{nope}}", "Old text")).toBe(true);
  });
  test("a valid or cleared template does not", () => {
    expect(startPromptBlocksSave(template, "")).toBe(false);
    expect(startPromptBlocksSave("", "{{#if plan}}")).toBe(false);
  });
  test("an untouched stored text that does not parse never blocks saving other fields", () => {
    expect(startPromptBlocksSave("{{legacy}}", "{{legacy}}")).toBe(false);
    expect(startPromptBlocksSave("  {{legacy}}\n", "{{legacy}}")).toBe(false);
  });
});
