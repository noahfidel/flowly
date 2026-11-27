import { describe, expect, it } from "vitest";
import type { Artifact, Link, Review, Task } from "./model";
import {
  isSpecInput,
  itemName,
  newCardPromptState,
  parseTemplate,
  promptState,
  renderStartPrompt,
  renderTemplate,
  reviewNotesOf,
  startPromptVariables,
  type StartPromptState,
} from "./start-prompt";

const blank: StartPromptState = {
  title: "Fix login",
  description: "",
  lane: "todo",
  laneName: "Todo",
  type: "",
  deliveryMode: "branch",
  plan: "",
  planApproved: false,
  spec: [],
  inputs: [],
  externalInputs: [],
  reviewNotes: 0,
  delivered: false,
  links: [],
  tags: [],
  firstSession: true,
};
const state = (over: Partial<StartPromptState> = {}): StartPromptState => ({ ...blank, ...over });
const render = (text: string, over: Partial<StartPromptState> = {}) => renderStartPrompt(text, state(over));
const problem = (text: string) => {
  const parsed = parseTemplate(text);
  return parsed.ok ? null : { error: parsed.error, line: parsed.line };
};

// The example template of START-PROMPT-TEMPLATE-SPEC §7.
const example = `{{#if reviewNotes}}
The last review left {{reviewNotes}} open findings. Work those first.
{{else if planApproved}}
Run the approved plan: {{plan}}.
{{else if spec}}
A spec is attached ({{spec}}). Write the implementation plan from it before coding.
{{else if lane == design || !plan}}
No spec or plan yet. Start with design: explore the problem, show options, and write a spec before any code.
{{else}}
Read the card and pick up where it left off.
{{/if}}`;

const at = (n: number) => `2026-11-2${n}T10:00:00.000Z`;
const artifact = (over: Partial<Artifact> & Pick<Artifact, "id" | "title" | "target">): Artifact => ({
  taskId: "t1",
  projectId: "p1",
  role: "input",
  kind: "file",
  note: "",
  createdBy: "human",
  createdAt: at(1),
  updatedAt: at(1),
  ...over,
});
const card = (over: Partial<Task> = {}) =>
  ({ id: "t1", title: "Fix login", description: "  Users get a blank page.  ", status: "todo", ...over }) as Task;
const reviewItem = (state: string, gating = true) => ({ id: `i-${Math.random()}`, kind: "command", name: "npm test", gating, state });
const review = (reviewState: string, items: ReturnType<typeof reviewItem>[]) => ({ state: reviewState, items }) as unknown as Review;

const board = (artifacts: Artifact[] = [], links: Link[] = [], tasks: Pick<Task, "id" | "title">[] = []) => ({ artifacts, links, tasks });
const cardState = (task: Task, artifacts: Artifact[] = [], extra: Partial<Parameters<typeof promptState>[0]> = {}) =>
  promptState({ project: null, task, board: board(artifacts), deliveryMode: "branch", firstSession: true, ...extra });

describe("the §7 example template against card state (§8)", () => {
  it("a card with no spec and no plan gets the design section", () => {
    expect(renderStartPrompt(example, cardState(card()))).toBe(
      "No spec or plan yet. Start with design: explore the problem, show options, and write a spec before any code.",
    );
  });
  it("a card with a spec.md input and an unapproved plan gets the plan-writing section", () => {
    const list = [
      artifact({ id: "a1", title: "Login spec", target: "./docs/spec.md" }),
      artifact({ id: "a2", title: "Plan", target: "./plan.md", plan: { approvedAt: null, source: "tool", setAt: at(2) } }),
    ];
    expect(renderStartPrompt(example, cardState(card(), list))).toBe(
      "A spec is attached (Login spec). Write the implementation plan from it before coding.",
    );
  });
  it("a card with an approved plan gets the run section, with the plan's target", () => {
    const plan = artifact({ id: "a2", title: "Plan", target: "./plan.md", plan: { approvedAt: at(3), approvedBy: { kind: "human" }, source: "tool", setAt: at(2) } });
    expect(renderStartPrompt(example, cardState(card(), [plan], { workspaceDir: "/w/card/" }))).toBe("Run the approved plan: /w/card/plan.md.");
    expect(renderStartPrompt(example, cardState(card(), [plan], { planTarget: "/abs/plan.md", workspaceDir: "/w" }))).toBe("Run the approved plan: /abs/plan.md.");
  });
  it("a card whose latest review is rework with 2 failed gating items gets the findings section", () => {
    const task = card({ review: review("rework", [reviewItem("failed"), reviewItem("failed"), reviewItem("disputed"), reviewItem("passed")]) });
    expect(renderStartPrompt(example, cardState(task))).toBe("The last review left 2 open findings. Work those first.");
  });
});

describe("template language (§2)", () => {
  it("plain text renders as itself, trimmed", () => {
    expect(render("  Read the card and pick up where it left off.\n")).toBe("Read the card and pick up where it left off.");
    expect(render("One { brace } and a } alone")).toBe("One { brace } and a } alone");
  });
  it("prints strings, lists joined with comma-space, booleans and numbers", () => {
    expect(render("{{ title }}|{{inputs}}|{{planApproved}}|{{reviewNotes}}", { inputs: ["a", "b"], reviewNotes: 3 })).toBe("Fix login|a, b|false|3");
  });
  it("nests blocks", () => {
    const text = "{{#if spec}}S{{#if planApproved}}A{{else}}D{{/if}}{{else}}N{{/if}}";
    expect(render(text, { spec: ["x"], planApproved: true })).toBe("SA");
    expect(render(text, { spec: ["x"] })).toBe("SD");
    expect(render(text)).toBe("N");
  });
  it("takes the first true branch of an else if chain", () => {
    const text = "{{#if reviewNotes}}R{{else if planApproved}}P{{else if spec}}S{{else}}E{{/if}}";
    expect(render(text, { reviewNotes: 1, planApproved: true })).toBe("R");
    expect(render(text, { planApproved: true, spec: ["x"] })).toBe("P");
    expect(render(text, { spec: ["x"] })).toBe("S");
    expect(render(text, {})).toBe("E");
    expect(render("{{#if spec}}S{{else if plan}}P{{/if}}tail", {})).toBe("tail");
  });
  it("truthiness: true, non-empty string, non-empty list, number above 0; ! negates", () => {
    const t = (cond: string, over: Partial<StartPromptState>) => render(`{{#if ${cond}}}y{{else}}n{{/if}}`, over);
    expect(t("description", { description: "x" })).toBe("y");
    expect(t("description", {})).toBe("n");
    expect(t("tags", { tags: [] })).toBe("n");
    expect(t("tags", { tags: ["ui"] })).toBe("y");
    expect(t("reviewNotes", { reviewNotes: 0 })).toBe("n");
    expect(t("firstSession", {})).toBe("y");
    expect(t("!firstSession", {})).toBe("n");
    expect(t("!plan", {})).toBe("y");
  });
  it("&& binds tighter than ||", () => {
    // a || b && c  ==  a || (b && c)
    const text = "{{#if firstSession || delivered && planApproved}}y{{else}}n{{/if}}";
    expect(render(text, { firstSession: true })).toBe("y");
    expect(render(text, { firstSession: false, delivered: true })).toBe("n");
    expect(render(text, { firstSession: false, delivered: true, planApproved: true })).toBe("y");
    // a && b || c  ==  (a && b) || c
    const other = "{{#if delivered && planApproved || firstSession}}y{{else}}n{{/if}}";
    expect(render(other, { firstSession: true })).toBe("y");
    expect(render(other, { firstSession: false, delivered: true })).toBe("n");
  });
  it("== and != compare strings, list elements, booleans and numbers, bare or quoted", () => {
    const t = (cond: string, over: Partial<StartPromptState> = {}) => render(`{{#if ${cond}}}y{{else}}n{{/if}}`, over);
    expect(t("lane == todo")).toBe("y");
    expect(t("lane != todo")).toBe("n");
    expect(t("deliveryMode == ship_main", { deliveryMode: "ship_main" })).toBe("y");
    expect(t('laneName == "In review"', { laneName: "In review" })).toBe("y");
    expect(t('laneName=="In review"', { laneName: "Review" })).toBe("n");
    expect(t("tags == ui", { tags: ["api", "ui"] })).toBe("y");
    expect(t("tags == web", { tags: ["api", "ui"] })).toBe("n");
    expect(t("tags != web", { tags: ["api", "ui"] })).toBe("y");
    expect(t("tags != ui", { tags: ["api", "ui"] })).toBe("n");
    expect(t("planApproved == false")).toBe("y");
    expect(t("reviewNotes == 2", { reviewNotes: 2 })).toBe("y");
    expect(t('spec == "a && b"', { spec: ["a && b"] })).toBe("y");
  });
  it("removes lines that hold only a block tag, collapses blank runs and trims", () => {
    const text = "Start.\n  {{#if planApproved}}  \nRun {{plan}}.\n{{else}}\nPlan first.\n{{/if}}\n\n\n\nThen test.\n";
    expect(render(text, { planApproved: true, plan: "/p.md" })).toBe("Start.\nRun /p.md.\n\nThen test.");
    expect(render(text)).toBe("Start.\nPlan first.\n\nThen test.");
    // A tag sharing its line with text keeps the line.
    expect(render("A {{#if spec}}s{{/if}}\nB")).toBe("A \nB");
    // A false section between paragraphs leaves one blank line.
    expect(render("A\n\n{{#if spec}}\nS\n{{/if}}\n\nB")).toBe("A\n\nB");
  });
  it("renders an empty template, or one whose sections are all false, as null", () => {
    expect(render("")).toBeNull();
    expect(render("  \n ")).toBeNull();
    expect(render("{{#if spec}}\nS\n{{/if}}\n")).toBeNull();
  });
  it("renders an invalid template as null", () => {
    expect(render("{{#if spec}}S")).toBeNull();
  });
  it("renderTemplate renders a parsed template", () => {
    const parsed = parseTemplate("Hi {{title}}");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(renderTemplate(parsed.template, state({ title: "X" }))).toBe("Hi X");
  });
  it("knows every variable in the §3 table", () => {
    expect([...startPromptVariables].sort()).toEqual(Object.keys(blank).sort());
    for (const name of startPromptVariables) expect(problem(`{{${name}}}{{#if ${name}}}x{{/if}}`)).toBeNull();
  });
});

describe("template errors with their line (§2)", () => {
  it("an unknown variable, in a value or a condition", () => {
    expect(problem("a\n{{titel}}")).toEqual({ error: 'Unknown variable "titel"', line: 2 });
    expect(problem("a\nb\n{{#if specs}}x{{/if}}")).toEqual({ error: 'Unknown variable "specs"', line: 3 });
    expect(problem("{{#if lane == x && !foo}}x{{/if}}")).toEqual({ error: 'Unknown variable "foo"', line: 1 });
  });
  it("an unclosed #if, at the #if's line", () => {
    expect(problem("x\n{{#if spec}}\n{{#if plan}}{{/if}}\ny")).toEqual({ error: "Unclosed {{#if}}", line: 2 });
  });
  it("a stray else, else if or /if", () => {
    expect(problem("x\n{{else}}")).toEqual({ error: "{{else}} without {{#if}}", line: 2 });
    expect(problem("{{else if spec}}")).toEqual({ error: "{{else if}} without {{#if}}", line: 1 });
    expect(problem("{{#if spec}}{{/if}}\n\n{{/if}}")).toEqual({ error: "{{/if}} without {{#if}}", line: 3 });
  });
  it("an else if, or a second else, after else", () => {
    expect(problem("{{#if spec}}\n{{else}}\n{{else if plan}}\n{{/if}}")).toEqual({ error: "{{else if}} after {{else}}", line: 3 });
    expect(problem("{{#if spec}}{{else}}\n{{else}}{{/if}}")).toEqual({ error: "{{else}} after {{else}}", line: 2 });
  });
  it("an empty condition or a malformed term", () => {
    expect(problem("{{#if}}x{{/if}}")).toEqual({ error: "Empty condition", line: 1 });
    expect(problem("{{#if spec}}{{else if   }}{{/if}}")).toEqual({ error: "Empty condition", line: 1 });
    for (const cond of ["spec &&", "|| spec", "spec plan", "lane ==", "lane == a b", "!", "! lane == x", 'lane == "open', "lane = x", "spec & plan", "(spec)", "lane == a.b"])
      expect(problem(`\n{{#if ${cond}}}x{{/if}}`), cond).toEqual({ error: expect.stringMatching(/^Malformed condition/), line: 2 });
  });
  it("an unterminated {{ and a tag that is not valid", () => {
    expect(problem("a\nb {{title")).toEqual({ error: "Unterminated {{", line: 2 });
    expect(problem("{{}}")).toEqual({ error: expect.stringMatching(/^Malformed tag/), line: 1 });
    expect(problem("x\n{{ the title }}")).toEqual({ error: expect.stringMatching(/^Malformed tag/), line: 2 });
    expect(problem("{{#each tags}}")).toEqual({ error: expect.stringMatching(/^Malformed tag/), line: 1 });
  });
  it("counts lines inside a multi-line text before the tag", () => {
    expect(problem("one\r\ntwo\r\n{{nope}}")).toEqual({ error: 'Unknown variable "nope"', line: 3 });
  });
});

describe("spec inputs (§3.1)", () => {
  const spec = (target: string, title = "Doc") => isSpecInput({ role: "input", target, title });
  it("matches spec.md and names ending in -SPEC.md or _SPEC.md, case-insensitive", () => {
    expect(spec("./spec.md")).toBe(true);
    expect(spec("/a/b/SPEC.md")).toBe(true);
    expect(spec("./docs/FOO-SPEC.md")).toBe(true);
    expect(spec("./docs/x_spec.md")).toBe(true);
    expect(spec("https://github.com/o/r/blob/main/docs/LOGIN-SPEC.md?plain=1#L3")).toBe(true);
    expect(spec("./specs.md")).toBe(false);
    expect(spec("./respec.md")).toBe(false);
    expect(spec("./spec.md.bak")).toBe(false);
    expect(spec("./spec/")).toBe(false);
  });
  it("matches a title that starts with spec followed by its end or a non-letter", () => {
    expect(spec("./a.md", "Spec: login")).toBe(true);
    expect(spec("./a.md", "Spec")).toBe(true);
    expect(spec("./a.md", "spec-v2")).toBe(true);
    expect(spec("./a.md", "SPEC 2")).toBe(true);
    expect(spec("./a.md", "Specification")).toBe(false);
    expect(spec("./a.md", "The spec")).toBe(false);
  });
  it("never counts an output or the plan", () => {
    expect(isSpecInput({ role: "output", target: "./spec.md", title: "Spec" })).toBe(false);
    expect(isSpecInput({ role: "input", target: "./spec.md", title: "Spec", plan: { approvedAt: null, source: "tool", setAt: at(1) } })).toBe(false);
  });
});

describe("review notes (§3.2)", () => {
  it("counts failed gating items of a rework or failed review; disputed and observing items do not count", () => {
    expect(reviewNotesOf(undefined)).toBe(0);
    expect(reviewNotesOf(review("rework", [reviewItem("failed"), reviewItem("failed", false), reviewItem("disputed")]))).toBe(1);
    expect(reviewNotesOf(review("failed", [reviewItem("failed"), reviewItem("failed")]))).toBe(2);
    expect(reviewNotesOf(review("passed", [reviewItem("failed")]))).toBe(0);
    expect(reviewNotesOf(review("running", [reviewItem("failed")]))).toBe(0);
  });
});

describe("promptState (§3)", () => {
  it("builds every variable from the card and its board", () => {
    const task = card({
      status: "in_review",
      type: "feature",
      tags: [{ tag: "ui", by: "human", at: at(1) }, { tag: "api", by: "agent", at: at(1) }],
      deliveredAt: at(4),
    });
    const list = [
      artifact({ id: "a1", title: "Old notes", target: "./notes.md", createdAt: at(1) }),
      artifact({ id: "a2", title: "ZEN-1 Login loop", kind: "url", target: "https://x.atlassian.net/browse/ZEN-1", createdAt: at(2), external: { connectionId: "c", provider: "jira-cloud", key: "ZEN-1", remoteId: "1", itemType: "issue" } }),
      artifact({ id: "a3", title: "Login design", kind: "url", target: "https://x.atlassian.net/wiki/9", createdAt: at(3), external: { connectionId: "c", provider: "confluence-cloud", key: "9", remoteId: "9", itemType: "page" } }),
      artifact({ id: "a4", title: "Spec: login", target: "./docs/LOGIN-SPEC.md", createdAt: at(4) }),
      artifact({ id: "a5", title: "Report", role: "output", target: "./out.md", createdAt: at(5) }),
      artifact({ id: "a6", title: "Plan", target: "https://example.com/plan", kind: "url", createdAt: at(6), plan: { approvedAt: null, source: "manual", setAt: at(6) } }),
      artifact({ id: "b1", taskId: "t2", title: "Other card's spec", target: "./spec.md" }),
    ];
    const links: Link[] = [
      { id: "l1", projectId: "p1", kind: "blocks", from: "t2", to: "t1", createdBy: "human", createdAt: at(1) },
      { id: "l2", projectId: "p1", kind: "related", from: "t1", to: "t3", createdBy: "human", createdAt: at(1) },
      { id: "l3", projectId: "p1", kind: "derived", from: "t1", to: "t2", createdBy: "human", createdAt: at(1) },
      { id: "l4", projectId: "p1", kind: "related", from: "t1", to: "gone", createdBy: "human", createdAt: at(1) },
    ];
    const project = { lanes: [{ status: "in_review" as const, enabled: true, name: "Waiting on Noah" }] };
    const s = promptState({
      project,
      task,
      board: { artifacts: list, links, tasks: [{ id: "t1", title: "Fix login" }, { id: "t2", title: "Auth" }, { id: "t3", title: "Docs" }] },
      deliveryMode: "draft_pr",
      firstSession: false,
    });
    expect(s).toEqual({
      title: "Fix login",
      description: "Users get a blank page.",
      lane: "in_review",
      laneName: "Waiting on Noah",
      type: "feature",
      deliveryMode: "draft_pr",
      plan: "https://example.com/plan",
      planApproved: false,
      spec: ["Spec: login"],
      inputs: ["Spec: login", "Login design", "ZEN-1 Login loop", "Old notes"],
      externalInputs: ["Login design", "ZEN-1"],
      reviewNotes: 0,
      delivered: true,
      links: ["Auth", "Docs"],
      tags: ["ui", "api"],
      firstSession: false,
    } satisfies StartPromptState);
  });
  it("names a built-in lane in English and leaves an untyped card's type empty", () => {
    const s = cardState(card({ status: "in_review" }));
    expect(s.laneName).toBe("In review");
    expect(s.type).toBe("");
    expect(s.plan).toBe("");
    expect(s.links).toEqual([]);
    expect(s.delivered).toBe(false);
  });
});

describe("newCardPromptState (§4, New task)", () => {
  it("builds the state from the form, with the picked From… items as inputs", () => {
    const s = newCardPromptState({
      project: null,
      title: " Fix login ",
      description: " Blank page. ",
      lane: "design",
      type: "bug",
      deliveryMode: "ship_main",
      items: [
        { key: "ZEN-8658", itemType: "issue", summary: "Fix the login loop" },
        { key: "123456", itemType: "page", summary: "Spec: login" },
      ],
    });
    expect(s).toEqual({
      title: "Fix login",
      description: "Blank page.",
      lane: "design",
      laneName: "Design",
      type: "bug",
      deliveryMode: "ship_main",
      plan: "",
      planApproved: false,
      spec: ["Spec: login"],
      inputs: ["ZEN-8658 Fix the login loop", "Spec: login"],
      externalInputs: ["ZEN-8658", "Spec: login"],
      reviewNotes: 0,
      delivered: false,
      links: [],
      tags: [],
      firstSession: true,
    } satisfies StartPromptState);
  });
  it("names an attached item like the From… default", () => {
    expect(itemName({ key: "123", itemType: "page", summary: "" })).toBe("123");
    expect(itemName({ key: "123", itemType: "page", summary: "Design" })).toBe("Design");
    expect(itemName({ key: "o/r#1", itemType: "pull", summary: "Retry" })).toBe("o/r#1");
  });
});
