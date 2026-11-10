/**
 * Pure parts of the left dock (DISPATCHER-SPEC §9.3; Ruling, Noah 2026-11-09): the dock is the dispatcher chat only;
 * minimized on desktop it leaves nothing on the board, and the toolbar's Dispatcher button (or D) opens it again; only Esc closes it with the keyboard. No React.
 */

/**
 * The header's buttons. The Dispatcher button is on every board (project or All projects), desktop and phone; the bell is
 * phones only (desktop has the overview's need-you chip for the step-through).
 */
export function toolbarDockButtons({ compact, dockAvailable }: { compact: boolean; dockAvailable: boolean }): { bell: boolean; dispatcher: boolean } {
  return { bell: compact && dockAvailable, dispatcher: dockAvailable };
}

/**
 * What D does (Ruling, Noah 2026-11-09): opens the dock when it is closed and focuses its message box; when it is
 * already open it just focuses the box. D never closes it, only Esc does (escAction). D never reaches here while a text
 * field has focus (board shortcuts are blocked there), so a focused box types "d". Nothing on a board without a dock.
 */
export function dockShortcut({ dockAvailable }: { dockAvailable: boolean }): "focus" | null {
  return dockAvailable ? "focus" : null;
}

/**
 * What Esc does (Ruling, Noah 2026-11-09): it acts on the area the user is in. An open modal takes it first. When the dock
 * is the active area (its box gained focus, or the user pressed inside it, and nothing else on the board since): a
 * focused box with a draft only blurs (the dock stays active, the draft stays); otherwise the dock closes. Else the
 * usual chain (back from session, close sidebar, leave a page), and an open dock stays.
 */
export function escAction({ modalOpen, dockActive, boxFocused, draftEmpty }: { modalOpen: boolean; dockActive: boolean; boxFocused: boolean; draftEmpty: boolean }): "modal" | "blur" | "closeDock" | "chain" {
  if (modalOpen) return "modal";
  if (!dockActive) return "chain";
  return boxFocused && !draftEmpty ? "blur" : "closeDock";
}
