/**
 * Pure parts of the left dock (DISPATCHER-SPEC §9.3; Ruling, Noah 2026-11-09): the dock is the dispatcher chat only;
 * minimized on desktop it leaves nothing on the board, and the toolbar's Dispatcher button (or D) opens it again. No React.
 */

/**
 * The header's buttons. The Dispatcher button is on every board (project or All projects), desktop and phone; the bell is
 * phones only (desktop has the overview's need-you chip for the step-through).
 */
export function toolbarDockButtons({ compact, dockAvailable }: { compact: boolean; dockAvailable: boolean }): { bell: boolean; dispatcher: boolean } {
  return { bell: compact && dockAvailable, dispatcher: dockAvailable };
}

/**
 * What D does: opens a minimized dock, or minimizes an open one. Opening never focuses the message box (Ruling, Noah
 * 2026-11-09), so a second D closes it again. D never reaches here while a text field has focus (board shortcuts are
 * blocked there), so an open dock with typing in it is left alone.
 * Nothing on a board without a dock.
 */
export function dockShortcut({ dockAvailable, open }: { dockAvailable: boolean; open: boolean }): "open" | "minimize" | null {
  if (!dockAvailable) return null;
  return open ? "minimize" : "open";
}
