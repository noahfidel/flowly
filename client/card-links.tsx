import { createContext } from "react";

export type CardLinkInfo = { title: string; archived: boolean; openable: boolean };
export type CardLinks = {
  /** The card's current state on the board, or null when the board does not know it. */
  resolve(taskId: string): CardLinkInfo | null;
  open(taskId: string): void;
  /** Changes when the board's cards change, so memoized chips refresh. */
  version: unknown;
};

/** No provider: card links and ids render as before (card sessions, drawer, connectors). */
export const CardLinkContext = createContext<CardLinks | null>(null);

/** What a card chip shows and does, from what the board knows. */
export function cardChipState(info: CardLinkInfo | null): "open" | "archived" | "project-archived" | "missing" {
  return !info ? "missing" : !info.openable ? "project-archived" : info.archived ? "archived" : "open";
}
