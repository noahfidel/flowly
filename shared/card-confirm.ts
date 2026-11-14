import { dispatcherServerName } from "./dispatcher";
import { linearTicketAsked } from "./linear-ticket";
import type { PendingRequest, PermissionReply } from "./permission-question";

/**
 * The dispatcher's card confirm (DISPATCHER-SPEC §5.2): its flowly_create_card is not preapproved, so each call waits
 * on a permission request in the dispatcher chat. The chat shows that request as one settings line and buttons; a
 * button's answer may change the call's input (Paseo's `updatedInput`) before the tool runs.
 */
export const createCardRequestName = `mcp__${dispatcherServerName}__flowly_create_card`;

/** What the dispatcher reads when the user cancels: a refusal, like PROJECT_REFUSED, so it stops. Agent-facing. */
export const cardRefusedMessage =
  "CARD_REFUSED: the user cancelled this card in the chat. Do not create or start it, and do not ask again unless the user does.";

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Whether a pending request is the dispatcher's flowly_create_card call. */
export function isCardConfirm(request: PendingRequest) {
  return request.name === createCardRequestName && request.kind !== "question" && record(request.input);
}

/**
 * Whether the card's session will be asked for a Linear ticket: `ask` (the project asks and the card follows it),
 * `skip` (the project asks, the card opts out), `linked` (a Linear issue is linked at create, so no ticket step), `off`
 * (the project does not ask).
 */
export type CardConfirmLinear = "ask" | "skip" | "linked" | "off";

export interface CardConfirmFacts {
  title: string;
  /** The project's title, or its id when the board does not know it. */
  project: string;
  type?: string;
  priority: string;
  workspace: string;
  linear: CardConfirmLinear;
}

/** The settings line, with the tool's defaults for what the call left out (`createCardInputSchema`). */
export function cardConfirmFacts(
  input: Record<string, unknown>,
  project: { title: string; linearTicket?: boolean } | null,
): CardConfirmFacts {
  const card = { linearTicket: typeof input.linearTicket === "boolean" ? input.linearTicket : undefined, type: text(input.type) };
  const linear: CardConfirmLinear =
    project?.linearTicket !== true ? "off" : text(input.linear)?.trim() ? "linked" : linearTicketAsked(project, card) ? "ask" : "skip";
  const type = text(input.type);
  return {
    title: (text(input.title) ?? "").trim(),
    project: project?.title ?? text(input.projectId) ?? "",
    ...(type ? { type } : {}),
    priority: text(input.priority) ?? "normal",
    workspace: text(input.workspace) ?? "directory",
    linear,
  };
}

export type CardConfirmChoice = "create" | "without-linear" | "with-linear" | "cancel";

/** The buttons, left to right: Cancel, the Linear toggle when the project asks for tickets, Create. */
export function cardConfirmChoices(facts: CardConfirmFacts): CardConfirmChoice[] {
  const toggle: CardConfirmChoice[] = facts.linear === "ask" ? ["without-linear"] : facts.linear === "skip" ? ["with-linear"] : [];
  return ["cancel", ...toggle, "create"];
}

/** A button's answer to the permission request. */
export function cardConfirmReply(request: PendingRequest, choice: CardConfirmChoice): PermissionReply {
  const input = record(request.input) ? request.input : {};
  if (choice === "cancel") return { behavior: "deny", message: cardRefusedMessage };
  if (choice === "without-linear") return { behavior: "allow", updatedInput: { ...input, linearTicket: false } };
  if (choice === "with-linear") {
    const { linearTicket: _, ...rest } = input;
    return { behavior: "allow", updatedInput: rest };
  }
  return { behavior: "allow" };
}
