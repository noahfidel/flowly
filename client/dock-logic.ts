/**
 * Pure parts of the left dock (DISPATCHER-SPEC §9.3; Ruling, Noah 2026-11-09): the dock is the dispatcher chat only;
 * minimized on desktop it leaves a rail on the board's left edge. No React.
 */

/** Desktop with the dock minimized: the rail with the Dispatcher button. Phones keep their header buttons; a board with no dock has no rail. */
export function railShown({ compact, dockAvailable, open }: { compact: boolean; dockAvailable: boolean; open: boolean }): boolean {
  return !compact && dockAvailable && !open;
}

/**
 * The header's bell and Dispatcher button: phones only, and only on a board (project or All projects). Desktop has the
 * rail for the chat and the overview's need-you chip for the step-through.
 */
export function toolbarDockButtons({ compact, dockAvailable }: { compact: boolean; dockAvailable: boolean }): { bell: boolean; dispatcher: boolean } {
  const on = compact && dockAvailable;
  return { bell: on, dispatcher: on };
}
