import { describe, expect, test } from "vitest";
import { cardConfirmFacts, cardConfirmChoices, cardConfirmReply, cardRefusedMessage, isCardConfirm } from "./card-confirm";
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
