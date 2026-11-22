import { z } from "zod";
import { clip } from "./session-tail";
import { isCredentialName, maskSecrets } from "./secrets";

/**
 * One tool call's arguments and result, loaded on demand when the user expands
 * the step in a card chat (`sessions.tool-call`, SESSION-PANE-SPEC §1.3). The
 * session tail never carries these payloads (PERFORMANCE-SPEC §3); this reads
 * one call, clipped and with credentials masked, as plain text sections.
 */

/** Arguments are clipped to this many characters before they leave the daemon. */
export const TOOL_ARGS_MAX = 8_000;
/** A result is clipped to this many characters before it leaves the daemon. */
export const TOOL_RESULT_MAX = 4_000;

export const toolCallEditSchema = z.object({ old: z.string().optional(), new: z.string().optional() });

export const toolCallDetailSchema = z.object({
  /** False when the call is no longer in the session's timeline (rewritten, or not found near its place). */
  found: z.boolean(),
  /** A short line above the arguments: the file a read/edit/write works on, a command's directory, a subagent's type. */
  label: z.string().optional(),
  /** The arguments as plain text: a command, a query, a URL, a file's new content, or the raw input as JSON. */
  args: z.string().optional(),
  /** An edit's replaced and new text, drawn −/+ like an approval's edit. */
  edits: z.array(toolCallEditSchema).optional(),
  argsTruncated: z.boolean().optional(),
  /** The call carries no input at all (some providers do not record it). */
  argsMissing: z.boolean().optional(),
  result: z.string().optional(),
  resultTruncated: z.boolean().optional(),
  /** The result reports an error (MCP `isError`). */
  resultError: z.boolean().optional(),
  exitCode: z.number().nullable().optional(),
  /** The call failed: its error message. */
  error: z.string().optional(),
});
export type ToolCallDetail = z.infer<typeof toolCallDetailSchema>;

const str = (value: unknown) => (typeof value === "string" && value.length ? value : undefined);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const lines = (...parts: (string | undefined | false)[]) => {
  const kept = parts.filter((part): part is string => typeof part === "string" && part.length > 0);
  return kept.length ? kept.join("\n") : undefined;
};

/** A string leaf is cut to this length before it is masked (it is clipped again with the whole text). */
const LEAF_MAX = TOOL_ARGS_MAX + 512;
/** At most this many values of a raw input or output are walked; the rest is left out. */
const TREE_MAX_NODES = 5_000;
const TREE_MAX_DEPTH = 24;

/** A string that is an auth header value on its own: `Bearer …`, `Basic …`, `token …`. */
const schemeValue = /^(?:Bearer|Basic|token)\s+\S/i;
const SECRET = "<secret>";

/**
 * A raw input or output with every string leaf and key masked before it becomes JSON, so a token after an
 * escaped newline cannot slip past the text masker. Whatever sits under a credential-named key (`"password"`,
 * `"x-api-key"`, `"Authorization"`), including every leaf of an array or object there, becomes `<secret>`; so do
 * a lone `Bearer …` string, the second item of a `["Authorization", "…"]` pair, and the `value` of a
 * `{ name|key: "DB_PASSWORD", value: "…" }` entry.
 *
 * `budget` caps the masked characters: once the leaves masked so far pass it (the text is clipped below it
 * anyway), every later leaf is `…`, so a wide input costs no more to mask than the text that is shown.
 */
function maskTree(value: unknown, budget: number): unknown {
  let nodes = 0;
  let used = 0;
  const spent = () => ++nodes > TREE_MAX_NODES || used >= budget;
  const leaf = (text: string) => {
    const cut = Math.min(LEAF_MAX, budget - used);
    const masked = schemeValue.test(text) ? SECRET : maskSecrets(text.length > cut ? clip(text, cut) : text);
    used += masked.length;
    return masked;
  };
  const key = (name: string) => {
    const masked = maskSecrets(name.length > 300 ? clip(name, 300) : name);
    used += masked.length;
    return masked;
  };
  /** Every scalar of a credential's subtree is `<secret>`; empty strings, booleans and null stay. */
  const secret = (node: unknown, depth: number): unknown => {
    if (spent() || depth > TREE_MAX_DEPTH) return "…";
    if ((typeof node === "string" && node.length > 0) || typeof node === "number") {
      used += SECRET.length;
      return SECRET;
    }
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item) => secret(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(node as Record<string, unknown>)) out[key(name)] = secret(item, depth + 1);
    return out;
  };
  const credentialString = (item: unknown) => typeof item === "string" && isCredentialName(item);
  const walk = (node: unknown, depth: number): unknown => {
    if (spent() || depth > TREE_MAX_DEPTH) return "…";
    if (typeof node === "string") return leaf(node);
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) {
      // A header pair: ["Authorization", "Bearer …"].
      if (node.length === 2 && credentialString(node[0])) return [walk(node[0], depth + 1), secret(node[1], depth + 1)];
      return node.map((item) => walk(item, depth + 1));
    }
    const record = node as Record<string, unknown>;
    // A name/value entry: { name: "DB_PASSWORD", value: "…" } (or `key`).
    const named = "value" in record && (credentialString(record.name) || credentialString(record.key));
    const out: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(record))
      out[key(name)] = isCredentialName(name) || (named && name === "value") ? secret(item, depth + 1) : walk(item, depth + 1);
    return out;
  };
  return walk(value, 0);
}

/** A value as readable text: strings as they are, anything else as indented JSON with its leaves masked (up to `max` + margin characters). */
function asText(value: unknown, max = TOOL_ARGS_MAX): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value || undefined;
  try {
    const json = JSON.stringify(maskTree(value, max + MASK_MARGIN), null, 2);
    return json === "{}" || json === "[]" ? undefined : json;
  } catch {
    return String(value);
  }
}

/** An MCP result's text: `content[].text` joined; otherwise its structured content or the raw value. */
function outputText(output: unknown): string | undefined {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const { content, structuredContent } = output as Record<string, unknown>;
    if (Array.isArray(content)) {
      const texts = content.flatMap((part) =>
        part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? [(part as { text: string }).text] : [],
      );
      if (texts.length) return texts.join("\n");
      if (structuredContent !== undefined) return asText(structuredContent, TOOL_RESULT_MAX);
    }
  }
  return asText(output, TOOL_RESULT_MAX);
}

function errorText(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error === "string") return error || undefined;
  if (typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") return (error as { message: string }).message;
  return asText(error, TOOL_RESULT_MAX);
}

type Sections = { label?: string; args?: string; edits?: { old?: string; new?: string }[]; result?: string; resultError?: boolean; exitCode?: number | null };

/** Paseo's `ToolCallDetail` union as plain sections. */
function sections(detail: Record<string, unknown> | undefined, rawInput: unknown): Sections {
  switch (detail?.type) {
    case "shell":
      return {
        label: str(detail.cwd),
        args: str(detail.command),
        result: str(detail.output),
        exitCode: typeof detail.exitCode === "number" || detail.exitCode === null ? (detail.exitCode as number | null) : undefined,
      };
    case "read": {
      const offset = num(detail.offset);
      const limit = num(detail.limit);
      return {
        args: lines(str(detail.filePath), offset !== undefined && `offset: ${offset}`, limit !== undefined && `limit: ${limit}`),
        result: str(detail.content),
      };
    }
    case "edit": {
      const old = typeof detail.oldString === "string" ? detail.oldString : undefined;
      const added = typeof detail.newString === "string" ? detail.newString : undefined;
      if (old || added) return { label: str(detail.filePath), edits: [{ ...(old ? { old } : {}), ...(added ? { new: added } : {}) }] };
      return { label: str(detail.filePath), args: str(detail.unifiedDiff) };
    }
    case "write":
      return { label: str(detail.filePath), args: str(detail.content) };
    case "search": {
      const web = Array.isArray(detail.webResults)
        ? detail.webResults.flatMap((r) => (r && typeof r === "object" ? [lines(str((r as Record<string, unknown>).title), str((r as Record<string, unknown>).url))] : []))
        : [];
      const files = Array.isArray(detail.filePaths) ? detail.filePaths.filter((p): p is string => typeof p === "string") : [];
      return {
        label: str(detail.toolName),
        args: str(detail.query),
        result: str(detail.content) ?? (files.length ? files.join("\n") : undefined) ?? lines(...web),
      };
    }
    case "fetch":
      return { args: lines(str(detail.url), str(detail.prompt) && `\n${detail.prompt}`), result: str(detail.result) };
    case "worktree_setup": {
      const commands = Array.isArray(detail.commands)
        ? detail.commands.flatMap((c) => (c && typeof c === "object" && typeof (c as Record<string, unknown>).command === "string" ? [(c as { command: string }).command] : []))
        : [];
      return { label: str(detail.branchName), args: lines(str(detail.worktreePath), ...commands), result: str(detail.log) };
    }
    case "sub_agent": {
      const actions = Array.isArray(detail.actions)
        ? detail.actions.flatMap((a) => {
            if (!a || typeof a !== "object") return [];
            const { toolName, summary } = a as Record<string, unknown>;
            return typeof toolName === "string" ? [typeof summary === "string" && summary ? `${toolName} · ${summary}` : toolName] : [];
          })
        : [];
      return { label: str(detail.subAgentType), args: str(detail.description), result: str(detail.log) ?? lines(...actions) };
    }
    case "plain_text":
      return { label: str(detail.label), args: str(detail.text) };
    case "plan":
      return { args: str(detail.text) };
    case "unknown": {
      const output = detail.output;
      const errored = !!output && typeof output === "object" && (output as Record<string, unknown>).isError === true;
      return { args: asText(detail.input ?? rawInput), result: outputText(output), ...(errored ? { resultError: true } : {}) };
    }
    default:
      return { args: asText(rawInput) };
  }
}

/** Room kept past the limit before masking, so a credential that crosses the limit is still whole when masked. */
const MASK_MARGIN = 512;

/** Cut to `max` + margin, mask, then clip to `max`: masking never runs over more than that, however long the text. */
function clipped(text: string | undefined, max: number): { text?: string; truncated: boolean } {
  if (text === undefined) return { truncated: false };
  const cut = text.length > max + MASK_MARGIN;
  const masked = maskSecrets(cut ? text.slice(0, max + MASK_MARGIN) : text);
  return cut || masked.length > max ? { text: clip(masked, max), truncated: true } : { text: masked, truncated: false };
}

/**
 * A raw `tool_call` timeline item as the details a card chat shows: every string
 * masked (`maskSecrets`) and clipped (arguments `TOOL_ARGS_MAX`, result
 * `TOOL_RESULT_MAX`). Never throws on unexpected shapes.
 */
export function toolCallView(raw: unknown): ToolCallDetail {
  const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const detail = item.detail && typeof item.detail === "object" ? (item.detail as Record<string, unknown>) : undefined;
  const parts = sections(detail, item.input);
  const out: ToolCallDetail = { found: true };
  if (parts.label) out.label = clipped(parts.label, 300).text;
  let truncated = false;
  if (parts.edits) {
    // One budget for both sides of the edits, so an edit is clipped like any other arguments.
    const half = Math.floor(TOOL_ARGS_MAX / 2);
    out.edits = parts.edits.map((edit) => {
      const old = clipped(edit.old, half);
      const added = clipped(edit.new, half);
      truncated ||= old.truncated || added.truncated;
      return { ...(old.text !== undefined ? { old: old.text } : {}), ...(added.text !== undefined ? { new: added.text } : {}) };
    });
  }
  const args = clipped(parts.args, TOOL_ARGS_MAX);
  if (args.text !== undefined) out.args = args.text;
  if (truncated || args.truncated) out.argsTruncated = true;
  if (out.args === undefined && !out.edits?.length && out.label === undefined) out.argsMissing = true;
  const result = clipped(parts.result, TOOL_RESULT_MAX);
  if (result.text !== undefined) out.result = result.text;
  if (result.truncated) out.resultTruncated = true;
  if (parts.resultError) out.resultError = true;
  if (parts.exitCode !== undefined) out.exitCode = parts.exitCode;
  const error = errorText(item.error);
  if (error) out.error = clipped(error, TOOL_RESULT_MAX).text;
  return out;
}

/**
 * The start of `text` shown before Show more: at most `maxLines` lines and
 * `maxChars` characters, with whether anything was left out.
 */
export function previewText(text: string, maxLines: number, maxChars: number): { text: string; truncated: boolean } {
  let end = text.length;
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n") continue;
    newlines++;
    if (newlines === maxLines) {
      end = i;
      break;
    }
  }
  if (end > maxChars) end = maxChars;
  if (end >= text.length) return { text, truncated: false };
  return { text: `${text.slice(0, end).trimEnd()}…`, truncated: true };
}
