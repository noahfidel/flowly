import { dispatcherServerName } from "./dispatcher";
import { t, tn } from "./i18n";
import { taskTypes, umbrellaLimits, type Group, type Project, type Task, type TaskType, type Umbrella } from "./model";
import { umbrellasLosingMembers } from "./umbrella";
import { linearTicketTypeDefault, linearTicketWanted } from "./linear-ticket";
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
const typeOf = (v: unknown) => taskTypes.find((t) => t === v);

/** The project as the confirm needs it: its title and what decides the Linear default (LINEAR-TICKET-SPEC §1). */
export type CardConfirmProject = { title: string; linearTicket?: boolean; linearSkipTypes?: TaskType[] } | null;

/** Whether a pending request is the dispatcher's flowly_create_card call. */
export function isCardConfirm(request: PendingRequest) {
  return request.name === createCardRequestName && request.kind !== "question" && record(request.input);
}

/**
 * Whether the card's session will be asked for a Linear ticket: `ask` (the project asks and the card's type or its
 * own setting wants it), `skip` (the project asks, the card's type is skipped or the card opts out), `linked` (a Linear issue is linked at create, so no ticket step), `off`
 * (the project does not ask).
 */
export type CardConfirmLinear = "ask" | "skip" | "linked" | "off";

export interface CardConfirmFacts {
  title: string;
  /** The umbrella the card would join (`umbrellaId`): its title, or its id when the board does not know it. */
  umbrella?: string;
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
  project: CardConfirmProject,
  /** The umbrella named by `input.umbrellaId`, as the board knows it; null or left out when it does not. */
  umbrella?: { title: string } | null,
): CardConfirmFacts {
  const card = { linearTicket: typeof input.linearTicket === "boolean" ? input.linearTicket : undefined, type: typeOf(input.type) };
  const linear: CardConfirmLinear =
    !project || project.linearTicket !== true ? "off" : text(input.linear)?.trim() ? "linked" : linearTicketWanted(project, card, []) ? "ask" : "skip";
  const type = text(input.type);
  const umbrellaId = text(input.umbrellaId);
  return {
    title: (text(input.title) ?? "").trim(),
    ...(umbrellaId ? { umbrella: umbrella?.title ?? umbrellaId } : {}),
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

/**
 * A button's answer to the permission request. The toggles send only what differs from the card's type default
 * (LINEAR-TICKET-SPEC §5): a field equal to the default is dropped, so the card follows the project.
 */
export function cardConfirmReply(request: PendingRequest, choice: CardConfirmChoice, project: CardConfirmProject): PermissionReply {
  const input = record(request.input) ? request.input : {};
  if (choice === "cancel") return { behavior: "deny", message: cardRefusedMessage };
  if (choice === "create") return { behavior: "allow" };
  const { linearTicket: _, ...rest } = input;
  const typeDefault = project ? linearTicketTypeDefault(project, typeOf(input.type)) : true;
  const want = choice === "with-linear";
  return { behavior: "allow", updatedInput: want === typeDefault ? rest : { ...rest, linearTicket: want } };
}

/**
 * The dispatcher's umbrella tools and flowly_manage_groups are not preapproved either: each call waits on a permission
 * request, shown as a title, what it changes and Cancel / Confirm (UMBRELLA-SPEC §4.3, DISPATCHER-SPEC §5.2).
 */
const confirmedTools = ["flowly_create_umbrella", "flowly_set_umbrella", "flowly_update_umbrella", "flowly_manage_groups"] as const;
const requestName = (tool: (typeof confirmedTools)[number]) => `mcp__${dispatcherServerName}__${tool}`;

/** What the dispatcher reads when the user cancels one of those calls: a refusal, so it stops. Agent-facing. */
export const changeRefusedMessage =
  "REFUSED: the user cancelled this change in the chat. Do not make it, and do not ask again unless the user does.";

/** Whether a pending request is one of the umbrella or board group calls that gets the change confirm. */
export function isUmbrellaConfirm(request: PendingRequest) {
  return request.kind !== "question" && record(request.input) && confirmedTools.some((tool) => request.name === requestName(tool));
}

export type UmbrellaConfirmAction = "create" | "join" | "member" | "leave" | "update" | "manage_groups";

/** What the confirm reads of the board; umbrella summaries from the overview serve as well as full umbrellas. */
export type UmbrellaConfirmBoard = {
  umbrellas: readonly Pick<Umbrella, "id" | "groupId" | "title">[];
  tasks: readonly Task[];
  projects: readonly Project[];
  groups: readonly Group[];
};

/** Agent text as one line (whitespace collapsed), cut to `max` characters with an ellipsis so it cannot draw a fact line of its own. */
const oneLine = (value: unknown, max: number) => {
  const flat = (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
/** How much of a new brief, contract or first acceptance item the confirm shows. */
const previewMax = 300;
const sourceMax = 500;
const linearNameMax = 200;
const linearName = (v: unknown) =>
  record(v) ? oneLine(text(v.name)?.trim() || text(v.key)?.trim() || text(v.url)?.trim() || "", linearNameMax) : "";

/**
 * The project moves a flowly_manage_groups call would make, for the umbrellas they would split (UMBRELLA-SPEC §9):
 * `set_members` moves the listed projects in and sends a current member left out to the default group; `delete` sends
 * the group's projects to the default group. Other actions move nothing.
 */
export function manageGroupsMoves(
  board: Pick<UmbrellaConfirmBoard, "projects" | "groups">,
  input: { action?: unknown; groupId?: unknown; projectIds?: unknown },
): { projectId: string; groupId: string }[] {
  const group = board.groups.find((g) => g.id === text(input.groupId));
  const target = board.groups.find((g) => g.isDefault);
  const moves: { projectId: string; groupId: string }[] = [];
  if (!group) return moves;
  if (input.action === "set_members") {
    const listed = Array.isArray(input.projectIds) ? input.projectIds.filter((id): id is string => typeof id === "string") : [];
    for (const id of listed) if (board.projects.find((p) => p.id === id)?.groupId !== group.id) moves.push({ projectId: id, groupId: group.id });
    if (target) for (const p of board.projects) if (p.groupId === group.id && !listed.includes(p.id)) moves.push({ projectId: p.id, groupId: target.id });
  } else if (input.action === "delete" && target) {
    for (const p of board.projects) if (p.groupId === group.id) moves.push({ projectId: p.id, groupId: target.id });
  }
  return moves;
}

/** The umbrellas a flowly_manage_groups call would split, as `umbrellasLosingMembers` reads the board. */
export function manageGroupsLosses(board: UmbrellaConfirmBoard, input: { action?: unknown; groupId?: unknown; projectIds?: unknown }) {
  const moves = manageGroupsMoves(board, input);
  return moves.length ? umbrellasLosingMembers(board, moves) : [];
}

/** The lines of a manage_groups call, with one per umbrella its move would split. */
function groupLines(input: Record<string, unknown>, board: UmbrellaConfirmBoard): string[] {
  const group = board.groups.find((g) => g.id === text(input.groupId));
  const groupName = group?.name ?? text(input.groupId) ?? "";
  const action = text(input.action);
  let line = "";
  if (action === "create") line = t("Create board group {name}", { name: text(input.name) ?? "" });
  else if (action === "rename") line = t("Rename board group {from} to {to}", { from: groupName, to: text(input.name) ?? "" });
  else if (action === "set_default") line = t("Make {group} the default group", { group: groupName });
  else if (action === "set_members") line = t("Set the projects of board group {group}", { group: groupName });
  else if (action === "delete") line = t("Delete board group {group}; its projects move to the default group", { group: groupName });
  const lost = manageGroupsLosses(board, input);
  return [line, ...lost.map((u) => tn(u.cards, "{title} loses {n} card", "{title} loses {n} cards", { title: u.title }))].filter(Boolean);
}

/**
 * The change confirm's content for one of the umbrella tools or flowly_manage_groups (`null` for any other request):
 * the action and one line per thing it does. `update` names the umbrella and one line per field the call changes;
 * `manage_groups` adds a line per umbrella whose members a project move would split.
 */
export function umbrellaConfirmFacts(request: PendingRequest, board: UmbrellaConfirmBoard): { action: UmbrellaConfirmAction; lines: string[] } | null {
  const facts = umbrellaFacts(request, board);
  // Every line is one line, whatever the agent's text or a title on the board holds.
  return facts && { action: facts.action, lines: facts.lines.map((l) => oneLine(l, 2000)).filter(Boolean) };
}

function umbrellaFacts(request: PendingRequest, board: UmbrellaConfirmBoard): { action: UmbrellaConfirmAction; lines: string[] } | null {
  if (!isUmbrellaConfirm(request) || !record(request.input)) return null;
  const input = request.input;
  const umbrellaOf = (id: unknown) => board.umbrellas.find((u) => u.id === id)?.title ?? text(id) ?? "";
  const cardOf = (id: unknown) => board.tasks.find((c) => c.id === id)?.title ?? text(id) ?? "";
  if (request.name === requestName("flowly_manage_groups")) return { action: "manage_groups", lines: groupLines(input, board) };
  if (request.name === requestName("flowly_create_umbrella")) {
    const source = oneLine(input.briefSource, sourceMax);
    const brief = oneLine(input.brief, previewMax);
    const linear = linearName(input.linearProject);
    return {
      action: "create",
      lines: [
        oneLine(input.title, umbrellaLimits.title),
        ...(brief ? [t("Brief: {text}", { text: brief })] : []),
        ...(source ? [t("Brief source: {source}", { source })] : []),
        ...(linear ? [t("Linear project: {name}", { name: linear })] : []),
      ].filter(Boolean),
    };
  }
  if (request.name === requestName("flowly_set_umbrella")) {
    const card = cardOf(input.taskId);
    const current = board.tasks.find((c) => c.id === input.taskId)?.umbrella;
    if (input.umbrellaId === null) return { action: "leave", lines: [t("{card} leaves {umbrella}", { card, umbrella: current ? umbrellaOf(current.id) : "" }).trim()] };
    const role = oneLine(input.role, umbrellaLimits.role);
    if (current && current.id === input.umbrellaId)
      // Omitted keeps the stored role or order, null (or an empty role) clears it (UMBRELLA-SPEC §4.2).
      return {
        action: "member",
        lines: [
          t("{card} stays in {umbrella}", { card, umbrella: umbrellaOf(input.umbrellaId) }),
          ...(role ? [t("Role: {role}", { role })] : input.role !== undefined && current.role ? [t("Role cleared")] : []),
          ...(typeof input.order === "number"
            ? [t("Order: {order}", { order: String(input.order) })]
            : input.order === null && current.order !== undefined
              ? [t("Order cleared")]
              : []),
        ],
      };
    return {
      action: "join",
      lines: [
        t("{card} joins {umbrella}", { card, umbrella: umbrellaOf(input.umbrellaId) }),
        ...(role ? [t("Role: {role}", { role })] : []),
        ...(current && current.id !== input.umbrellaId ? [t("Leaves {umbrella}", { umbrella: umbrellaOf(current.id) })] : []),
      ],
    };
  }
  const lines = [umbrellaOf(input.id)];
  if (text(input.title) !== undefined && text(input.title) !== umbrellaOf(input.id))
    lines.push(t("Title: {title}", { title: oneLine(input.title, umbrellaLimits.title) }));
  if (typeof input.brief === "string") lines.push(oneLine(input.brief, previewMax) ? t("Brief: {text}", { text: oneLine(input.brief, previewMax) }) : t("Brief cleared"));
  if (input.briefSource === null) lines.push(t("Brief source cleared"));
  else if (input.briefSource !== undefined) lines.push(t("Brief source: {source}", { source: oneLine(input.briefSource, sourceMax) }));
  if (typeof input.contract === "string") lines.push(oneLine(input.contract, previewMax) ? t("Contract: {text}", { text: oneLine(input.contract, previewMax) }) : t("Contract cleared"));
  if (Array.isArray(input.acceptance)) {
    const first = record(input.acceptance[0]) ? oneLine(input.acceptance[0].text, Math.min(previewMax, umbrellaLimits.acceptanceText)) : "";
    lines.push(
      input.acceptance.length
        ? tn(input.acceptance.length, "Acceptance: {n} item, first: {first}", "Acceptance: {n} items, first: {first}", { first })
        : t("Acceptance list cleared"),
    );
  }
  if (input.integrationTaskId === null) lines.push(t("Integration card cleared"));
  else if (input.integrationTaskId !== undefined) lines.push(t("Integration card: {card}", { card: cardOf(input.integrationTaskId) }));
  if (input.linearProject === null) lines.push(t("Linear project cleared"));
  else if (input.linearProject !== undefined) lines.push(t("Linear project: {name}", { name: linearName(input.linearProject) }));
  return { action: "update", lines };
}

/** Confirm allows the call as written; Cancel denies it with a refusal the dispatcher reads as stop. */
export function umbrellaConfirmReply(choice: "confirm" | "cancel"): PermissionReply {
  return choice === "confirm" ? { behavior: "allow" } : { behavior: "deny", message: changeRefusedMessage };
}
