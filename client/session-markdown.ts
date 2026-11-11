export type MarkdownBlock =
  | { kind: "paragraph" | "quote"; text: string }
  | { kind: "heading"; text: string; level: number }
  | {
      kind: "list";
      text: string;
      marker: string;
      indent: number;
      checked?: boolean;
    }
  | { kind: "code"; text: string; language: string }
  | { kind: "rule" }
  | {
      kind: "table";
      headers: string[];
      rows: string[][];
      align: ("left" | "center" | "right")[];
    };

/**
 * A ui/app fence is inline UI that a plugin (genui) renders live in the host
 * session view; timeline transformers never run inside flowly's preview, so
 * SessionMarkdown shows a notice instead of the code. Matching follows genui's
 * rule: the fence's first language word, case-insensitive.
 */
export function isInlineUiFence(language: string): boolean {
  const first = language.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return first === "ui" || first === "app";
}

function tableCells(line: string) {
  let trimmed = line.trim().replace(/^\|/, "");
  if (trimmed.endsWith("|") && trimmed.at(-2) !== "\\")
    trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let cell = "",
    code = false;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (trimmed[i] === "`") {
      code = !code;
      cell += "`";
    } else if (trimmed[i] === "|" && !code) {
      cells.push(cell.trim());
      cell = "";
    } else cell += trimmed[i];
  }
  cells.push(cell.trim());
  return cells;
}

const fence = (line: string) => line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
const heading = (line: string) =>
  line.match(/^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
const list = (line: string) => line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
const rule = (line: string) =>
  /^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:_\s*){3,}$/.test(
    line,
  );
function startsBlock(line: string) {
  return (
    !line.trim() ||
    fence(line) ||
    heading(line) ||
    list(line) ||
    rule(line) ||
    /^\s*>/.test(line)
  );
}
function isTable(lines: string[], i: number) {
  if (!lines[i]?.includes("|") || !lines[i + 1]?.includes("|")) return false;
  const delimiter = tableCells(lines[i + 1]);
  return (
    delimiter.length === tableCells(lines[i]).length &&
    delimiter.every((cell) => /^:?-+:?$/.test(cell))
  );
}
function tableAlign(cell: string) {
  const left = cell.startsWith(":"),
    right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : "left";
}

/** A bounded native preview subset; incomplete syntax remains readable while streaming. */
export function parseSessionMarkdown(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n"),
    blocks: MarkdownBlock[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const start = fence(line);
    if (start) {
      const content: string[] = [],
        marker = start[1];
      i++;
      while (i < lines.length) {
        const end = fence(lines[i]);
        if (
          end &&
          end[1][0] === marker[0] &&
          end[1].length >= marker.length &&
          !end[2].trim()
        ) {
          i++;
          break;
        }
        content.push(lines[i++]);
      }
      blocks.push({
        kind: "code",
        language: start[2].trim(),
        text: content.join("\n"),
      });
      continue;
    }
    if (isTable(lines, i)) {
      const headers = tableCells(line),
        align = tableCells(lines[i + 1]).map(tableAlign),
        rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim())
        rows.push(tableCells(lines[i++]));
      blocks.push({ kind: "table", headers, rows, align });
      continue;
    }
    const h = heading(line),
      item = list(line);
    if (h) {
      blocks.push({ kind: "heading", level: h[1].length, text: h[2] });
      i++;
    } else if (rule(line)) {
      blocks.push({ kind: "rule" });
      i++;
    } else if (item) {
      const checkbox = item[3].match(/^\[([ xX])\]\s+(.*)$/);
      blocks.push({
        kind: "list",
        marker: item[2],
        indent: Math.min(item[1].length, 8),
        text: checkbox ? checkbox[2] : item[3],
        checked: checkbox ? checkbox[1] !== " " : undefined,
      });
      i++;
    } else if (/^\s*>/.test(line)) {
      const content: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        content.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", text: content.join("\n") });
    } else {
      const content = [line];
      i++;
      while (i < lines.length && !startsBlock(lines[i]) && !isTable(lines, i))
        content.push(lines[i++]);
      blocks.push({ kind: "paragraph", text: content.join("\n") });
    }
  }
  return blocks;
}

export type InlinePart = {
  text: string;
  kind: "text" | "bold" | "italic" | "code" | "link";
  url?: string;
  /** A card link (`flowly://card/<projectId>/<taskId>`) or a bare card id the resolver knows. */
  card?: { projectId?: string; taskId: string };
};
const cardLinkPattern = /^flowly:\/\/card\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/i;
/** A strict Flowly card link; anything else with the flowly:// scheme stays a plain link. */
export function cardLink(url: string | undefined): { projectId: string; taskId: string } | null {
  const m = url ? cardLinkPattern.exec(url) : null;
  return m ? { projectId: m[1], taskId: m[2] } : null;
}
const bareIdPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Plain-text UUIDs become card parts only when `known` says the board has that card; code, links and styled text are left alone. */
export function linkBareCardIds(parts: InlinePart[], known: (id: string) => boolean): InlinePart[] {
  const out: InlinePart[] = [];
  for (const part of parts) {
    if (part.kind !== "text" || !part.text) { out.push(part); continue; }
    let from = 0;
    for (const m of part.text.matchAll(bareIdPattern)) {
      const id = m[0], at = m.index!;
      if (!known(id) || /[0-9a-z-]/i.test(part.text[at - 1] ?? "") || /[0-9a-z-]/i.test(part.text[at + id.length] ?? "")) continue;
      if (at > from) out.push({ kind: "text", text: part.text.slice(from, at) });
      out.push({ kind: "link", text: id, card: { taskId: id } });
      from = at + id.length;
    }
    if (from === 0) out.push(part);
    else if (from < part.text.length) out.push({ kind: "text", text: part.text.slice(from) });
  }
  return out;
}
export function parseSessionInline(text: string): InlinePart[] {
  const pattern =
    /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\[([^\]\n]+)\]\((?:<([^>\n]+)>|((?:[^\s()]|\([^\s()]*\))+))(?:\s+"[^"\n]*")?\)|<(https?:\/\/[^\s<>]+)>|(https?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"*_])|\*([^*\n]+)\*|_([^_\n]+)_/g;
  const parts: InlinePart[] = [];
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > from)
      parts.push({ kind: "text", text: text.slice(from, match.index) });
    if (match[1]) parts.push({ kind: "code", text: match[1] });
    else if (match[2] || match[3])
      parts.push({ kind: "bold", text: match[2] || match[3] });
    else if (match[4])
      {
      const url = match[5] || match[6], card = cardLink(url);
      parts.push({ kind: "link", text: match[4], url, ...(card ? { card } : {}) });
    }
    else if (match[7] || match[8]) {
      const url = match[7] || match[8];
      parts.push({ kind: "link", text: url, url });
    } else parts.push({ kind: "italic", text: match[9] || match[10] });
    from = match.index! + match[0].length;
  }
  if (from < text.length) parts.push({ kind: "text", text: text.slice(from) });
  return parts;
}
