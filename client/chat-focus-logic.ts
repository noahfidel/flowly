import { resolveShortcut, type ShortcutKey } from "./shortcuts";

/** Opening a card's chat focuses its message box (SHORTCUTS-SPEC §2.2, Ruling, Noah 2026-11-23). */

/**
 * Whether a freshly opened chat takes keyboard focus: only for a chat the user opened (`requested`), only on web, and not
 * while the session waits on a Paseo request, whose buttons and ←/→ question keys must stay usable.
 */
export function composerAutoFocus({ requested, web, pendingRequests }: { requested: boolean; web: boolean; pendingRequests: number }): boolean {
  return requested && web && pendingRequests === 0;
}

/**
 * The only board shortcuts that work from the card chat's message box: Back and Forward through what was opened
 * (⌃[ / ⌃] on Apple systems, Alt+←/→ elsewhere). Everything else stays typing.
 */
export function composerPassThrough(event: ShortcutKey, apple: boolean): "history-back" | "history-forward" | null {
  const action = resolveShortcut(event, true, apple);
  return action === "history-back" || action === "history-forward" ? action : null;
}

/** Esc in the card chat's box, like the dispatcher's: a draft only leaves the box; an empty box runs the board's Esc chain. */
export function cardBoxEscape(draftEmpty: boolean): "blur" | "chain" {
  return draftEmpty ? "chain" : "blur";
}

/**
 * Focuses the box now when its input is mounted; otherwise flags the next mount to autofocus (the flag is cleared once
 * that mount happened). Returns whether it focused at once.
 */
export function requestInputFocus(input: { focus?(): void } | null | undefined, flag: { current: boolean }): boolean {
  if (input?.focus) {
    input.focus();
    return true;
  }
  flag.current = true;
  return false;
}
