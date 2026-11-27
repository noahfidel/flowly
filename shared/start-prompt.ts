import { absoluteTarget, artifactsOf } from "./artifacts";
import { externalTitle, itemTypeOf, type ItemType } from "./connectors";
import { withLocale } from "./i18n";
import { laneName } from "./lanes";
import { linksOf } from "./links";
import type { Artifact, Link, Project, Review, Status, Task } from "./model";
import { planApproved, planOf } from "./plans";

/**
 * A project's Start prompt (START-PROMPT-TEMPLATE-SPEC): a small template language rendered against a card's state
 * into a new session's first message. Pure: no React, no Node. The prompt and the parse errors are agent-facing
 * English; the client translates only the fixed prefix it shows around an error.
 */

/** The variables a template may use (§3), in the order the settings hint lists them. */
export const startPromptVariables = [
  "title",
  "description",
  "lane",
  "laneName",
  "type",
  "deliveryMode",
  "plan",
  "planApproved",
  "spec",
  "inputs",
  "externalInputs",
  "reviewNotes",
  "delivered",
  "links",
  "tags",
  "firstSession",
] as const;
export type StartPromptVariable = (typeof startPromptVariables)[number];

/** What a template is rendered against (§3). */
export type StartPromptState = {
  title: string;
  description: string;
  lane: string;
  laneName: string;
  type: string;
  deliveryMode: string;
  plan: string;
  planApproved: boolean;
  spec: string[];
  inputs: string[];
  externalInputs: string[];
  reviewNotes: number;
  delivered: boolean;
  links: string[];
  tags: string[];
  firstSession: boolean;
};

const known = new Set<string>(startPromptVariables);

// ---------------------------------------------------------------------------------------------------------------
// Parsing (§2)

type Term = { name: StartPromptVariable; not: boolean; op?: "==" | "!="; value?: string };
/** Terms joined by &&, those groups joined by ||. */
type Condition = Term[][];
type Node =
  | { kind: "text"; text: string }
  | { kind: "var"; name: StartPromptVariable }
  | { kind: "if"; branches: { cond: Condition; body: Node[] }[]; otherwise: Node[] | null };

/** A parsed template, ready for `renderTemplate`. */
export type StartPromptTemplate = { readonly nodes: readonly Node[] };
export type ParseResult = { ok: true; template: StartPromptTemplate } | { ok: false; error: string; line: number };

class TemplateError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
  }
}

type Tag =
  | { kind: "if"; cond: string }
  | { kind: "elseif"; cond: string }
  | { kind: "else" }
  | { kind: "endif" }
  | { kind: "var"; name: string };
type Token = { kind: "text"; text: string } | { kind: "tag"; tag: Tag; line: number };

const blockTag = (tag: Tag) => tag.kind !== "var";

function classify(inner: string, line: number): Tag {
  const body = inner.trim();
  let m: RegExpExecArray | null;
  if ((m = /^#\s*if(?:\s+([\s\S]*))?$/.exec(body))) return { kind: "if", cond: m[1] ?? "" };
  if ((m = /^else\s+if(?:\s+([\s\S]*))?$/.exec(body))) return { kind: "elseif", cond: m[1] ?? "" };
  if (body === "else") return { kind: "else" };
  if (/^\/\s*if$/.test(body)) return { kind: "endif" };
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(body)) {
    if (!known.has(body)) throw new TemplateError(`Unknown variable "${body}"`, line);
    return { kind: "var", name: body };
  }
  throw new TemplateError(`Malformed tag: "{{${inner}}}"`, line);
}

/** Text and tags, alternating (a text token, possibly empty, before and after every tag). */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  let line = 1;
  const advance = (to: number) => {
    for (let i = at; i < to; i++) if (source.charCodeAt(i) === 10) line++;
    at = to;
  };
  for (;;) {
    const open = source.indexOf("{{", at);
    if (open < 0) {
      tokens.push({ kind: "text", text: source.slice(at) });
      return tokens;
    }
    tokens.push({ kind: "text", text: source.slice(at, open) });
    advance(open);
    const close = source.indexOf("}}", open + 2);
    if (close < 0) throw new TemplateError("Unterminated {{", line);
    tokens.push({ kind: "tag", tag: classify(source.slice(open + 2, close), line), line });
    advance(close + 2);
  }
}

/** A line that holds only one block tag plus spaces is removed with its line break (§2). */
function dropStandaloneLines(tokens: Token[]): Token[] {
  const out = tokens.map((t) => ({ ...t }));
  const last = tokens.length - 1;
  tokens.forEach((token, i) => {
    if (token.kind !== "tag" || !blockTag(token.tag)) return;
    const before = (tokens[i - 1] as { text: string }).text;
    const after = (tokens[i + 1] as { text: string }).text;
    const startsLine = /\n[ \t]*$/.test(before) || (i - 1 === 0 && /^[ \t]*$/.test(before));
    const endsLine = /^[ \t]*\n/.test(after) || (i + 1 === last && /^[ \t]*$/.test(after));
    if (!startsLine || !endsLine) return;
    const prev = out[i - 1] as { text: string };
    const next = out[i + 1] as { text: string };
    prev.text = prev.text.replace(/[ \t]*$/, "");
    next.text = next.text.replace(/^[ \t]*\n?/, "");
  });
  return out;
}

function parseCondition(source: string, line: number): Condition {
  const text = source.trim();
  if (!text) throw new TemplateError("Empty condition", line);
  const malformed = () => new TemplateError(`Malformed condition: "${text}"`, line);
  type Lexeme = { kind: "op"; op: "&&" | "||" | "==" | "!=" | "!" } | { kind: "word"; word: string } | { kind: "string"; value: string };
  const lexemes: Lexeme[] = [];
  for (let i = 0; i < text.length; ) {
    const rest = text.slice(i);
    const space = /^\s+/.exec(rest);
    if (space) {
      i += space[0].length;
      continue;
    }
    const op = /^(&&|\|\||==|!=|!)/.exec(rest);
    if (op) {
      lexemes.push({ kind: "op", op: op[1] as "&&" });
      i += op[1]!.length;
      continue;
    }
    const word = /^[A-Za-z0-9_-]+/.exec(rest);
    if (word) {
      lexemes.push({ kind: "word", word: word[0] });
      i += word[0].length;
      continue;
    }
    if (rest[0] === '"') {
      const end = rest.indexOf('"', 1);
      if (end < 0) throw malformed();
      lexemes.push({ kind: "string", value: rest.slice(1, end) });
      i += end + 1;
      continue;
    }
    throw malformed();
  }
  let at = 0;
  const peekOp = (op: string) => lexemes[at]?.kind === "op" && (lexemes[at] as { op: string }).op === op;
  const name = (): StartPromptVariable => {
    const lexeme = lexemes[at++];
    if (lexeme?.kind !== "word" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(lexeme.word)) throw malformed();
    if (!known.has(lexeme.word)) throw new TemplateError(`Unknown variable "${lexeme.word}"`, line);
    return lexeme.word as StartPromptVariable;
  };
  const term = (): Term => {
    if (peekOp("!")) {
      at++;
      return { name: name(), not: true };
    }
    const subject = name();
    if (peekOp("==") || peekOp("!=")) {
      const op = (lexemes[at++] as { op: "==" | "!=" }).op;
      const value = lexemes[at++];
      if (value?.kind === "word") return { name: subject, not: false, op, value: value.word };
      if (value?.kind === "string") return { name: subject, not: false, op, value: value.value };
      throw malformed();
    }
    return { name: subject, not: false };
  };
  const condition: Condition = [];
  for (;;) {
    const group = [term()];
    while (peekOp("&&")) {
      at++;
      group.push(term());
    }
    condition.push(group);
    if (!peekOp("||")) break;
    at++;
  }
  if (at !== lexemes.length) throw malformed();
  return condition;
}

type Frame = { node: Extract<Node, { kind: "if" }>; line: number; body: Node[]; elseLine: number | null };

/** Parse a template (§2); errors are English with a 1-based line. */
export function parseTemplate(text: string): ParseResult {
  try {
    const tokens = dropStandaloneLines(tokenize(text.replace(/\r\n?/g, "\n")));
    const root: Node[] = [];
    const stack: Frame[] = [];
    const target = () => stack[stack.length - 1]?.body ?? root;
    for (const token of tokens) {
      if (token.kind === "text") {
        if (token.text) target().push({ kind: "text", text: token.text });
        continue;
      }
      const { tag, line } = token;
      const frame = stack[stack.length - 1];
      switch (tag.kind) {
        case "var":
          target().push({ kind: "var", name: tag.name as StartPromptVariable });
          break;
        case "if": {
          const body: Node[] = [];
          const node: Frame["node"] = { kind: "if", branches: [{ cond: parseCondition(tag.cond, line), body }], otherwise: null };
          target().push(node);
          stack.push({ node, line, body, elseLine: null });
          break;
        }
        case "elseif": {
          if (!frame) throw new TemplateError("{{else if}} without {{#if}}", line);
          if (frame.elseLine !== null) throw new TemplateError("{{else if}} after {{else}}", line);
          const body: Node[] = [];
          frame.node.branches.push({ cond: parseCondition(tag.cond, line), body });
          frame.body = body;
          break;
        }
        case "else": {
          if (!frame) throw new TemplateError("{{else}} without {{#if}}", line);
          if (frame.elseLine !== null) throw new TemplateError("{{else}} after {{else}}", line);
          frame.body = frame.node.otherwise = [];
          frame.elseLine = line;
          break;
        }
        case "endif":
          if (!frame) throw new TemplateError("{{/if}} without {{#if}}", line);
          stack.pop();
          break;
      }
    }
    const open = stack[0];
    if (open) throw new TemplateError("Unclosed {{#if}}", open.line);
    return { ok: true, template: { nodes: root } };
  } catch (error) {
    if (error instanceof TemplateError) return { ok: false, error: error.message, line: error.line };
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering (§2)

type Value = StartPromptState[StartPromptVariable];

const printed = (value: Value) => (Array.isArray(value) ? value.join(", ") : String(value));

function truthy(value: Value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return value > 0;
  return !!value;
}

function holds(term: Term, state: StartPromptState) {
  const value = state[term.name];
  if (!term.op) return term.not ? !truthy(value) : truthy(value);
  const equal = Array.isArray(value) ? value.includes(term.value!) : String(value) === term.value;
  return term.op === "==" ? equal : !equal;
}

const met = (cond: Condition, state: StartPromptState) => cond.some((group) => group.every((term) => holds(term, state)));

function emit(nodes: readonly Node[], state: StartPromptState): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") out += node.text;
    else if (node.kind === "var") out += printed(state[node.name]);
    else {
      const branch = node.branches.find((b) => met(b.cond, state));
      const body = branch ? branch.body : node.otherwise;
      if (body) out += emit(body, state);
    }
  }
  return out;
}

/** Render a parsed template: blank-line runs collapse to one blank line and the result is trimmed. Never throws. */
export function renderTemplate(template: StartPromptTemplate, state: StartPromptState): string {
  return emit(template.nodes, state)
    .replace(/\n(?:[ \t]*\n){2,}/g, "\n\n")
    .trim();
}

/** The rendered first message, or null when there is no template, it does not parse, or it renders empty (§4). */
export function renderStartPrompt(text: string | null | undefined, state: StartPromptState): string | null {
  if (!text?.trim()) return null;
  const parsed = parseTemplate(text);
  if (!parsed.ok) return null;
  return renderTemplate(parsed.template, state) || null;
}

// ---------------------------------------------------------------------------------------------------------------
// Card state (§3, §4)

/** A spec input (§3.1): `spec.md` or a name ending in `-SPEC.md` / `_SPEC.md`, or a title starting with "spec" and no letter after. */
export function isSpecInput(artifact: Pick<Artifact, "role" | "target" | "title"> & { plan?: unknown }): boolean {
  if (artifact.role !== "input" || artifact.plan) return false;
  const path = artifact.target.split(/[?#]/)[0] ?? "";
  const name = (path.split("/").pop() ?? "").toLowerCase();
  if (name === "spec.md" || name.endsWith("-spec.md") || name.endsWith("_spec.md")) return true;
  return /^spec(?!\p{L})/iu.test(artifact.title.trim());
}

/** Open findings of the card's latest review (§3.2): failed gating items of a rework or failed review. */
export function reviewNotesOf(review: Pick<Review, "state" | "items"> | null | undefined): number {
  if (!review || (review.state !== "rework" && review.state !== "failed")) return 0;
  return review.items.filter((item) => item.gating && item.state === "failed").length;
}

/** An item attached from a connected service, as the From… default names it: a page by its title, else its key. */
export type AttachedItem = { key: string; itemType: string; summary?: string };
export const itemName = (item: AttachedItem) => (item.itemType === "page" ? item.summary || item.key : item.key);

/** A lane's display name in English (prompts are agent-facing, so the client's language never applies). */
const englishLaneName = (project: Pick<Project, "lanes"> | null | undefined, status: Status) => withLocale("en", () => laneName(project, status));

export type PromptStateInput = {
  project: Pick<Project, "lanes"> | null | undefined;
  task: Pick<Task, "id" | "title" | "description" | "status" | "type" | "tags" | "review" | "deliveredAt">;
  /** The board, or the part of it that holds this card's artifacts, its links and the linked cards. */
  board: { artifacts: readonly Artifact[]; links: readonly Link[]; tasks: readonly Pick<Task, "id" | "title">[] };
  /** Already resolved (card, project, group, host). */
  deliveryMode: string;
  /** The card has had no session before this one. */
  firstSession: boolean;
  /** The plan's target as the caller resolved it; wins over the stored one. */
  planTarget?: string | null;
  /** Resolves a stored "./" file plan target to an absolute path when `planTarget` is not given. */
  workspaceDir?: string;
};

/** The state of an existing card at start time (§3). `lane` is the card's status before Start moves it. */
export function promptState(input: PromptStateInput): StartPromptState {
  const { task, board } = input;
  const plan = planOf(board.artifacts, task.id);
  const inputs = artifactsOf(board.artifacts, task.id).filter((a) => a.role === "input" && !a.plan);
  const planTarget = input.planTarget || (plan ? (plan.kind === "file" && input.workspaceDir ? absoluteTarget(plan.target, input.workspaceDir) : plan.target) : "");
  const linked = new Map<string, string>();
  for (const view of linksOf(board, task.id)) if (view.other && !linked.has(view.other.id)) linked.set(view.other.id, view.other.title);
  return {
    title: task.title,
    description: task.description.trim(),
    lane: task.status,
    laneName: englishLaneName(input.project, task.status),
    type: task.type ?? "",
    deliveryMode: input.deliveryMode,
    plan: plan ? planTarget : "",
    planApproved: planApproved(plan),
    spec: inputs.filter(isSpecInput).map((a) => a.title),
    inputs: inputs.map((a) => a.title),
    externalInputs: inputs.flatMap((a) => (a.external ? [itemName({ key: a.external.key, itemType: itemTypeOf(a.external), summary: a.title })] : [])),
    reviewNotes: reviewNotesOf(task.review),
    delivered: !!task.deliveredAt,
    links: [...linked.values()],
    tags: (task.tags ?? []).map((t) => t.tag),
    firstSession: input.firstSession,
  };
}

export type NewCardPromptInput = {
  project: Pick<Project, "lanes"> | null | undefined;
  title: string;
  description: string;
  /** The card's starting lane. */
  lane: Status;
  type?: string | null;
  /** Resolved as the card will get it. */
  deliveryMode: string;
  /** The picked From… items. */
  items: readonly AttachedItem[];
};

/** The state on New task and Quick task, where the card does not exist yet (§4). */
export function newCardPromptState(form: NewCardPromptInput): StartPromptState {
  const inputs = form.items.map((item) => externalTitle(item.itemType as ItemType, item.key, item.summary ?? ""));
  return {
    title: form.title.trim(),
    description: form.description.trim(),
    lane: form.lane,
    laneName: englishLaneName(form.project, form.lane),
    type: form.type ?? "",
    deliveryMode: form.deliveryMode,
    plan: "",
    planApproved: false,
    // From… items carry no file target, so only the title rule of isSpecInput can match here.
    spec: inputs.filter((title) => isSpecInput({ role: "input", target: "", title })),
    inputs,
    externalInputs: form.items.map(itemName),
    reviewNotes: 0,
    delivered: false,
    links: [],
    tags: [],
    firstSession: true,
  };
}
