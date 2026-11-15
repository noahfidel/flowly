import type { PluginTheme } from "@getpaseo/plugin";

type Colors = PluginTheme["colors"];

/** The one place a session/card state maps to a host theme token (UI-REFRESH-SPEC, status color semantics). */
export function stateColors(c: Colors) {
  return { running: c.accent, unread: c.statusSuccess, needsYou: c.statusWarning, error: c.statusDanger };
}
