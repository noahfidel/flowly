/** Longest recap line kept; the row also truncates it to one line on screen. */
export const RECAP_LINE_MAX = 160;

/**
 * The collapsed Progress row's one-line recap (NATIVE-SESSION-SPEC §5.3): the first sentence of the recap's first
 * non-empty line, without a leading bullet, heading or numbering and without emphasis or code markers, whitespace
 * collapsed, capped at RECAP_LINE_MAX with an ellipsis. Empty for an empty recap.
 */
export function recapLine(recap: string): string {
  const line = recap
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  const plain = line
    .replace(/^(?:#{1,6}\s+|[-*+•]\s+|\d+[.)]\s+)/, "")
    .replace(/(\*\*|__|\*|`)/g, "")
    .replace(/(^|[\s(])_(\S(?:.*?\S)?)_(?=$|[\s.,;:!?)])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  // A sentence ends at . ! ? before whitespace or the end (so 1.9.0 and file.tsx stay whole), or at a CJK stop.
  const end = /[.!?](?=\s|$)|[。！？]/.exec(plain);
  const sentence = end ? plain.slice(0, end.index + 1) : plain;
  return sentence.length > RECAP_LINE_MAX ? `${sentence.slice(0, RECAP_LINE_MAX - 1).trimEnd()}…` : sentence;
}

/**
 * What a Progress timeline row shows (NATIVE-SESSION-SPEC §5.3): `line` (collapsed), `full` (opened from the line,
 * Show less returns to it) or `open-card` (setting off: the full card, which clamps itself). `choice` is this mounted
 * row's last Show more (true) / Show less (false), null before any press.
 */
export function progressRowView(startCollapsed: boolean, choice: boolean | null): "line" | "full" | "open-card" {
  if (choice === null) return startCollapsed ? "line" : "open-card";
  return choice ? "full" : "line";
}
