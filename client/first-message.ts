/**
 * The first message New task sends to the agent it starts (UI-REFRESH-SPEC §7s, CONNECTORS-SPEC §8.2).
 * Pure: no React, no i18n. The message is agent-facing, so it stays English.
 */

import { itemName, type AttachedItem as Attached } from "../shared/start-prompt";

export const defaultFirstMessage = (items: readonly Attached[]) => `Start on this card: read its inputs, including ${items.map(itemName).join(", ")}, then begin.`;

/**
 * What to send: the user's text when there is any; else the project's Start prompt rendered for the new card
 * (START-PROMPT-TEMPLATE-SPEC §4); else, with items attached from a service, a default that points the agent at
 * them; otherwise null, and Create waits for an instruction.
 */
export function firstMessage(typed: string, items: readonly Attached[], startPrompt?: string | null): string | null {
  const text = typed.trim();
  if (text) return text;
  if (startPrompt) return startPrompt;
  return items.length ? defaultFirstMessage(items) : null;
}
