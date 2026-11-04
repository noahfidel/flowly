/**
 * The first message New task sends to the agent it starts (UI-REFRESH-SPEC §7s, CONNECTORS-SPEC §8.2).
 * Pure: no React, no i18n. The message is agent-facing, so it stays English.
 */

type Attached = { key: string; itemType: string; summary?: string };

/** A page's key is an opaque id, so a page is named by its title; tickets, issues and PRs by their key. */
const nameOf = (item: Attached) => (item.itemType === "page" ? item.summary || item.key : item.key);

export const defaultFirstMessage = (items: readonly Attached[]) => `Start on this card: read its inputs, including ${items.map(nameOf).join(", ")}, then begin.`;

/**
 * What to send: the user's text when there is any; with items attached from a service, a default that
 * points the agent at them; otherwise null, and Create waits for an instruction.
 */
export function firstMessage(typed: string, items: readonly Attached[]): string | null {
  const text = typed.trim();
  if (text) return text;
  return items.length ? defaultFirstMessage(items) : null;
}
