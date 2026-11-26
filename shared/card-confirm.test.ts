import { describe, expect, test } from "vitest";
import { cardConfirmFacts, cardConfirmChoices, cardConfirmReply, cardRefusedMessage, changeRefusedMessage, isCardConfirm, isUmbrellaConfirm, umbrellaConfirmFacts, umbrellaConfirmReply } from "./card-confirm";
import { emptyBoard, type Board } from "./model";
import type { PendingRequest } from "./permission-question";

const input = { projectId: "p1", title: "Fix login", description: "Long brief", idempotencyKey: "fix-login", workspace: "worktree", priority: "high", type: "bugfix" };
const request = (over: Partial<PendingRequest> = {}): PendingRequest => ({
  id: "r1",
  name: "mcp__flowly-dispatcher__flowly_create_card",
  kind: "tool",
  input,
  ...over,
});
const asks = { title: "Flowly", linearTicket: true };
const quiet = { title: "Flowly" };

describe("which requests get the card confirm (DISPATCHER-SPEC §5.2)", () => {
  test("only the dispatcher server's flowly_create_card with an input", () => {
    expect(isCardConfirm(request())).toBe(true);
    expect(isCardConfirm(request({ name: "mcp__flowly__flowly_create_card" }))).toBe(false);
    expect(isCardConfirm(request({ name: "mcp__flowly-dispatcher__flowly_create_project" }))).toBe(false);
    expect(isCardConfirm(request({ input: undefined }))).toBe(false);
    expect(isCardConfirm(request({ kind: "question" }))).toBe(false);
  });
});

describe("the settings line", () => {
  test("names the card's title, project, type, priority, workspace and Linear ask", () => {
    expect(cardConfirmFacts(input, asks)).toEqual({
      title: "Fix login",
      project: "Flowly",
      type: "bugfix",
      priority: "high",
      workspace: "worktree",
      linear: "ask",
    });
  });
  test("defaults follow the tool: normal priority, directory workspace, no type", () => {
    expect(cardConfirmFacts({ projectId: "p1", title: "T", idempotencyKey: "k" }, quiet)).toEqual({
      title: "T",
      project: "Flowly",
      priority: "normal",
      workspace: "directory",
      linear: "off",
    });
  });
  test("the Linear ask comes from the shared rule: project switch, then the card's opt-out, then a linked issue", () => {
    expect(cardConfirmFacts(input, quiet).linear).toBe("off");
    expect(cardConfirmFacts({ ...input, linearTicket: false }, asks).linear).toBe("skip");
    expect(cardConfirmFacts({ ...input, linearTicket: true }, asks).linear).toBe("ask");
    expect(cardConfirmFacts({ ...input, linear: "ZEN-1" }, asks).linear).toBe("linked");
  });
  test("the Linear ask follows the card's type: a skipped type such as research shows skip", () => {
    const research = { ...input, type: "research" };
    expect(cardConfirmFacts(research, asks).linear).toBe("skip");
    expect(cardConfirmFacts({ ...research, linearTicket: true }, asks).linear).toBe("ask");
    expect(cardConfirmFacts({ ...input, type: "feature" }, asks).linear).toBe("ask");
    expect(cardConfirmFacts({ ...input, type: "feature", linearTicket: false }, asks).linear).toBe("skip");
    expect(cardConfirmFacts({ ...input, type: "bogus" }, asks).linear).toBe("ask");
  });
  test("a custom skip list is honoured", () => {
    const custom = { ...asks, linearSkipTypes: ["chore" as const] };
    expect(cardConfirmFacts({ ...input, type: "chore" }, custom).linear).toBe("skip");
    expect(cardConfirmFacts({ ...input, type: "research" }, custom).linear).toBe("ask");
    expect(cardConfirmFacts({ ...input, type: "research" }, { ...asks, linearSkipTypes: [] }).linear).toBe("ask");
  });
  test("an unknown project shows its id and no Linear ask", () => {
    expect(cardConfirmFacts(input, null)).toMatchObject({ project: "p1", linear: "off" });
  });
});

describe("the buttons and their answers", () => {
  test("Create, the Linear toggle only when the project asks, Cancel", () => {
    expect(cardConfirmChoices(cardConfirmFacts(input, asks))).toEqual(["cancel", "without-linear", "create"]);
    expect(cardConfirmChoices(cardConfirmFacts({ ...input, linearTicket: false }, asks))).toEqual(["cancel", "with-linear", "create"]);
    expect(cardConfirmChoices(cardConfirmFacts(input, quiet))).toEqual(["cancel", "create"]);
    expect(cardConfirmChoices(cardConfirmFacts({ ...input, linear: "ZEN-1" }, asks))).toEqual(["cancel", "create"]);
  });
  test("Create allows the call as the dispatcher wrote it", () => {
    expect(cardConfirmReply(request(), "create", asks)).toEqual({ behavior: "allow" });
  });
  test("Create without Linear ticket opts the card out; the rest of the input is kept", () => {
    expect(cardConfirmReply(request(), "without-linear", asks)).toEqual({ behavior: "allow", updatedInput: { ...input, linearTicket: false } });
  });
  test("Create with Linear ticket drops the opt-out, so the card follows the project", () => {
    const reply = cardConfirmReply(request({ input: { ...input, linearTicket: false } }), "with-linear", asks);
    expect(reply).toEqual({ behavior: "allow", updatedInput: input });
    expect(reply.behavior === "allow" && "linearTicket" in (reply.updatedInput ?? {})).toBe(false);
  });
  test("a research card shows skip and Create with Linear ticket sends true", () => {
    const research = { ...input, type: "research" };
    expect(cardConfirmChoices(cardConfirmFacts(research, asks))).toEqual(["cancel", "with-linear", "create"]);
    expect(cardConfirmReply(request({ input: research }), "with-linear", asks)).toEqual({ behavior: "allow", updatedInput: { ...research, linearTicket: true } });
  });
  test("a feature card shows ask and Create without Linear ticket sends false", () => {
    const feature = { ...input, type: "feature" };
    expect(cardConfirmChoices(cardConfirmFacts(feature, asks))).toEqual(["cancel", "without-linear", "create"]);
    expect(cardConfirmReply(request({ input: feature }), "without-linear", asks)).toEqual({ behavior: "allow", updatedInput: { ...feature, linearTicket: false } });
  });
  test("a research card the dispatcher forced on shows ask and Create without drops the field", () => {
    const forced = { ...input, type: "research", linearTicket: true };
    expect(cardConfirmChoices(cardConfirmFacts(forced, asks))).toEqual(["cancel", "without-linear", "create"]);
    const { linearTicket: _, ...rest } = forced;
    expect(cardConfirmReply(request({ input: forced }), "without-linear", asks)).toEqual({ behavior: "allow", updatedInput: rest });
  });
  test("a feature card opted out shows skip and Create with drops the field", () => {
    const out = { ...input, type: "feature", linearTicket: false };
    expect(cardConfirmChoices(cardConfirmFacts(out, asks))).toEqual(["cancel", "with-linear", "create"]);
    const { linearTicket: _, ...rest } = out;
    expect(cardConfirmReply(request({ input: out }), "with-linear", asks)).toEqual({ behavior: "allow", updatedInput: rest });
  });
  test("the toggles use the custom skip list", () => {
    const custom = { ...asks, linearSkipTypes: ["chore" as const] };
    const chore = { ...input, type: "chore" };
    expect(cardConfirmReply(request({ input: chore }), "with-linear", custom)).toEqual({ behavior: "allow", updatedInput: { ...chore, linearTicket: true } });
    const research = { ...input, type: "research" };
    expect(cardConfirmReply(request({ input: research }), "without-linear", custom)).toEqual({ behavior: "allow", updatedInput: { ...research, linearTicket: false } });
  });
  test("Cancel denies with a refusal the dispatcher reads as stop", () => {
    expect(cardConfirmReply(request(), "cancel", asks)).toEqual({ behavior: "deny", message: cardRefusedMessage });
    expect(cardRefusedMessage).toMatch(/^CARD_REFUSED: /);
  });
});

describe("the card confirm shows the proposed umbrella", () => {
  test("the title when the board knows it, else the id; nothing without umbrellaId", () => {
    expect(cardConfirmFacts({ ...input, umbrellaId: "u1" }, asks, { title: "Fresh context" }).umbrella).toBe("Fresh context");
    expect(cardConfirmFacts({ ...input, umbrellaId: "u1" }, asks, null).umbrella).toBe("u1");
    expect(cardConfirmFacts({ ...input, umbrellaId: "u1" }, asks).umbrella).toBe("u1");
    expect(cardConfirmFacts(input, asks)).not.toHaveProperty("umbrella");
  });
});

const board = (): Pick<Board, "umbrellas" | "tasks" | "projects" | "groups"> => {
  const b = emptyBoard();
  const at = "2026-11-25T00:00:00.000Z";
  const project = (id: string, groupId: string) => ({ id, groupId, title: id, description: "", primaryPath: `/${id}`, repos: [`/${id}`], revision: 1, createdAt: at, updatedAt: at, archivedAt: null }) as unknown as Board["projects"][number];
  const task = (id: string, projectId: string, umbrella?: string) =>
    ({ id, projectId, title: `Card ${id}`, umbrella: umbrella ? { id: umbrella, joinedAt: at, by: { kind: "human" } } : undefined }) as unknown as Board["tasks"][number];
  b.groups = [
    { id: "A", name: "Projects", revision: 1, position: 0, isDefault: true },
    { id: "B", name: "Clients", revision: 1, position: 1 },
  ] as Board["groups"];
  b.projects = [project("p1", "A"), project("p2", "A"), project("p3", "B")];
  b.tasks = [task("t1", "p1", "u"), task("t2", "p2", "u"), task("t3", "p1")];
  b.umbrellas = [{ id: "u", groupId: "A", title: "Fresh context" }] as unknown as Board["umbrellas"];
  return b;
};
const call = (tool: string, args: Record<string, unknown>): PendingRequest => ({ id: "r2", name: `mcp__flowly-dispatcher__${tool}`, kind: "tool", input: args });

describe("the manage_groups confirm names each umbrella that would lose members", () => {
  test("set_members and delete list every umbrella they would split, one line each", () => {
    const b = board();
    const moved = umbrellaConfirmFacts(call("flowly_manage_groups", { action: "set_members", groupId: "B", revision: 1, projectIds: ["p3", "p1"] }), b)!;
    expect(moved.action).toBe("manage_groups");
    expect(moved.lines).toEqual(["Set the projects of board group Clients", "Fresh context loses 1 card"]);
    // Leaving p1 out of B sends it to the default group: nothing is split.
    const kept = umbrellaConfirmFacts(call("flowly_manage_groups", { action: "set_members", groupId: "A", revision: 1, projectIds: ["p1", "p2", "p3"] }), b)!;
    expect(kept.lines).toEqual(["Set the projects of board group Projects"]);
    // Deleting the group that holds p3: it goes to the default group, no umbrella of A has a member there.
    expect(umbrellaConfirmFacts(call("flowly_manage_groups", { action: "delete", groupId: "B", revision: 1 }), b)!.lines).toEqual([
      "Delete board group Clients; its projects move to the default group",
    ]);
    expect(umbrellaConfirmFacts(call("flowly_manage_groups", { action: "create", name: "New" }), b)!.lines).toEqual(["Create board group New"]);
  });
});

describe("the update_umbrella confirm names the umbrella and each changed field", () => {
  test("one line per field the call passes, the title only when it changes", () => {
    const b = board();
    const facts = umbrellaConfirmFacts(
      call("flowly_update_umbrella", { id: "u", revision: 1, title: "Renamed", brief: "x", contract: "y", acceptance: [], integrationTaskId: "t1", linearProject: { url: "https://linear.app/p", name: "Roadmap" } }),
      b,
    )!;
    expect(facts.action).toBe("update");
    expect(facts.lines).toEqual(["Fresh context", "Title: Renamed", "Brief: x", "Contract: y", "Acceptance list cleared", "Integration card: Card t1", "Linear project: Roadmap"]);
    expect(umbrellaConfirmFacts(call("flowly_update_umbrella", { id: "u", revision: 1, title: "Fresh context", integrationTaskId: null, linearProject: null, briefSource: null }), b)!.lines).toEqual([
      "Fresh context", "Brief source cleared", "Integration card cleared", "Linear project cleared",
    ]);
  });
});

describe("the umbrella confirms show the text the user approves", () => {
  test("brief and contract previews collapse whitespace and cut at 300 characters with an ellipsis", () => {
    const b = board();
    const long = `Line one\n\n  line   two ${"w".repeat(400)}`;
    const lines = umbrellaConfirmFacts(call("flowly_update_umbrella", { id: "u", revision: 1, brief: long, contract: "  Use\tPOST only. " }), b)!.lines;
    expect(lines[1]).toBe(`Brief: ${`Line one line two ${"w".repeat(400)}`.slice(0, 299)}…`);
    expect(lines[1].length).toBe("Brief: ".length + 300);
    expect(lines[2]).toBe("Contract: Use POST only.");
    expect(umbrellaConfirmFacts(call("flowly_update_umbrella", { id: "u", revision: 1, brief: "  ", contract: "" }), b)!.lines).toEqual(["Fresh context", "Brief cleared", "Contract cleared"]);
    expect(umbrellaConfirmFacts(call("flowly_create_umbrella", { title: "Fresh", brief: "Goal\nmore", idempotencyKey: "k" }), b)!.lines).toEqual(["Fresh", "Brief: Goal more"]);
  });
  test("the acceptance list shows the item count and the first item, bounded the same way", () => {
    const b = board();
    const lines = umbrellaConfirmFacts(
      call("flowly_update_umbrella", { id: "u", revision: 1, acceptance: [{ text: `Ship\nit ${"x".repeat(400)}`, done: false }, { text: "Second", done: true }] }),
      b,
    )!.lines;
    expect(lines[1]).toBe(`Acceptance: 2 items, first: ${`Ship it ${"x".repeat(400)}`.slice(0, 299)}…`);
    expect(umbrellaConfirmFacts(call("flowly_update_umbrella", { id: "u", revision: 1, acceptance: [{ text: "Only", done: false }] }), b)!.lines[1]).toBe("Acceptance: 1 item, first: Only");
  });
  test("agent text cannot draw a fake fact line: every value is one line and cut to its schema maximum", () => {
    const b = board();
    const created = umbrellaConfirmFacts(call("flowly_create_umbrella", { title: `X\nLeaves Y ${"t".repeat(200)}`, briefSource: "a\nb", idempotencyKey: "k" }), b)!.lines;
    expect(created.every((l) => !/[\n\r]/.test(l))).toBe(true);
    expect(created[0].length).toBe(120);
    expect(created[0].startsWith("X Leaves Y ")).toBe(true);
    expect(created[1]).toBe("Brief source: a b");
    const joined = umbrellaConfirmFacts(call("flowly_set_umbrella", { projectId: "p1", taskId: "t3", umbrellaId: "u", role: "api\nLeaves Z and more words past forty characters" }), b)!.lines;
    expect(joined.every((l) => !/[\n\r]/.test(l))).toBe(true);
    expect(joined[1].length).toBe("Role: ".length + 40);
    const updated = umbrellaConfirmFacts(call("flowly_update_umbrella", { id: "u", revision: 1, title: "A\nTitle: B", linearProject: { url: "u", name: "N\nBrief cleared" } }), b)!.lines;
    expect(updated.every((l) => !/[\n\r]/.test(l))).toBe(true);
    expect(updated).toContain("Title: A Title: B");
    expect(updated).toContain("Linear project: N Brief cleared");
  });
});

describe("a set_umbrella call on a card already in the umbrella", () => {
  test("with only role or order changing it is its own action, naming the new role and order", () => {
    const b = board();
    expect(umbrellaConfirmFacts(call("flowly_set_umbrella", { projectId: "p1", taskId: "t1", umbrellaId: "u", role: "ui", order: 2 }), b)).toEqual({
      action: "member",
      lines: ["Card t1 stays in Fresh context", "Role: ui", "Order: 2"],
    });
    expect(umbrellaConfirmFacts(call("flowly_set_umbrella", { projectId: "p1", taskId: "t1", umbrellaId: "u", order: 0 }), b)).toEqual({
      action: "member",
      lines: ["Card t1 stays in Fresh context", "Order: 0"],
    });
  });
  test("an omitted role or order keeps it and is not named; null clears it and says so", () => {
    const b = board();
    b.tasks[0]!.umbrella = { ...b.tasks[0]!.umbrella!, role: "map", order: 3 };
    expect(umbrellaConfirmFacts(call("flowly_set_umbrella", { projectId: "p1", taskId: "t1", umbrellaId: "u" }), b)!.lines).toEqual(["Card t1 stays in Fresh context"]);
    expect(umbrellaConfirmFacts(call("flowly_set_umbrella", { projectId: "p1", taskId: "t1", umbrellaId: "u", role: null, order: null }), b)!.lines).toEqual([
      "Card t1 stays in Fresh context",
      "Role cleared",
      "Order cleared",
    ]);
  });
});

describe("the create and set_umbrella confirms", () => {
  test("create names the title and what comes with it; join and leave name the card and the umbrella", () => {
    const b = board();
    expect(umbrellaConfirmFacts(call("flowly_create_umbrella", { title: "Fresh", brief: "Goal", briefSource: "docs/x.md", idempotencyKey: "k" }), b)).toEqual({ action: "create", lines: ["Fresh", "Brief: Goal", "Brief source: docs/x.md"] });
    expect(umbrellaConfirmFacts(call("flowly_set_umbrella", { projectId: "p1", taskId: "t3", umbrellaId: "u", role: "api" }), b)).toEqual({ action: "join", lines: ["Card t3 joins Fresh context", "Role: api"] });
    expect(umbrellaConfirmFacts(call("flowly_set_umbrella", { projectId: "p1", taskId: "t1", umbrellaId: null }), b)).toEqual({ action: "leave", lines: ["Card t1 leaves Fresh context"] });
  });
  test("only those tools, and Cancel denies as a refusal", () => {
    expect(isUmbrellaConfirm(call("flowly_create_project", { path: "/x" }))).toBe(false);
    expect(umbrellaConfirmFacts(request(), board())).toBeNull();
    expect(umbrellaConfirmReply("confirm")).toEqual({ behavior: "allow" });
    expect(umbrellaConfirmReply("cancel")).toEqual({ behavior: "deny", message: changeRefusedMessage });
  });
});
