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
    expect(cardConfirmReply(request(), "create")).toEqual({ behavior: "allow" });
  });
  test("Create without Linear ticket opts the card out; the rest of the input is kept", () => {
    expect(cardConfirmReply(request(), "without-linear")).toEqual({ behavior: "allow", updatedInput: { ...input, linearTicket: false } });
  });
  test("Create with Linear ticket drops the opt-out, so the card follows the project", () => {
    const reply = cardConfirmReply(request({ input: { ...input, linearTicket: false } }), "with-linear");
    expect(reply).toEqual({ behavior: "allow", updatedInput: input });
    expect(reply.behavior === "allow" && "linearTicket" in (reply.updatedInput ?? {})).toBe(false);
  });
  test("Cancel denies with a refusal the dispatcher reads as stop", () => {
    expect(cardConfirmReply(request(), "cancel")).toEqual({ behavior: "deny", message: cardRefusedMessage });
    expect(cardRefusedMessage).toMatch(/^CARD_REFUSED: /);
  });
});
