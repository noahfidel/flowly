import { Platform } from "react-native";
import { createDoubleTapDetector, type DoubleTapDetector, type TapKeyEvent } from "./double-tap";

/**
 * Double tap of Ctrl opens the board from anywhere in Paseo (SHORTCUTS-SPEC §5). Web only, an AGENTS.md exception:
 * capture-phase keydown/keyup/pointerdown/mousedown/blur listeners on `window` (blur resets only when the window
 * itself loses focus). They never prevent or stop an event,
 * so the host and other plugins (the Workspace Switcher's Ctrl+Tab hold) see every key as before.
 *
 * Paseo evaluates the plugin client once per connected host, so each host's `contribute` installs here. One
 * listener per window lives in a `globalThis` slot with the list of live installs; a double tap opens the board of
 * the first host whose setting is on (not necessarily the host on show). The last cleanup removes the listeners.
 *
 * It fires while a text field or terminal has focus too: a bare Ctrl tap types nothing there.
 */

/** What one host's `contribute` registers. */
export interface DoubleTapInstall {
  /** Opens that host's board screen. */
  open(): void;
  /** Reads that host's *Double-tap Ctrl* setting. */
  readEnabled(): Promise<boolean>;
  /** The setting was read with a different value than before (the Command Center title follows it). */
  changed?(enabled: boolean): void;
}

type Live = DoubleTapInstall & { enabled: boolean | null; reading: Promise<boolean> | null };

type Slot = {
  installs: Live[];
  detector: DoubleTapDetector;
  remove: (() => void) | null;
};

const SLOT_KEY = "__flowlyDoubleTapCtrl";
/** The first read warms the cache after load, never during it (cold start, PERFORMANCE-SPEC). */
const WARM_DELAY_MS = 3000;
/** After a settings write, read every host again once the save has landed. */
const SETTLE_DELAY_MS = 1500;

type WindowLike = {
  addEventListener(type: string, listener: (event: unknown) => void, capture: boolean): void;
  removeEventListener(type: string, listener: (event: unknown) => void, capture: boolean): void;
};

function windowLike(): WindowLike | null {
  const g = globalThis as Partial<WindowLike>;
  return typeof g.addEventListener === "function" && typeof g.removeEventListener === "function" ? (g as WindowLike) : null;
}

function slot(): Slot | null {
  const g = globalThis as Record<string, unknown>;
  return (g[SLOT_KEY] as Slot | undefined) ?? null;
}

function now() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/**
 * Reads one host's setting. A failed read leaves the cached value as it was and answers with it, or with the
 * setting's default (on) when nothing is known yet.
 */
function refresh(install: Live): Promise<boolean> {
  if (install.reading) return install.reading;
  let read: Promise<boolean>;
  try {
    read = Promise.resolve(install.readEnabled());
  } catch (error) {
    read = Promise.reject(error);
  }
  const reading = read
    .then((enabled) => {
      const before = install.enabled;
      install.enabled = enabled;
      if (before !== enabled) {
        try {
          install.changed?.(enabled);
        } catch {
          // A failing title update must not break the gesture.
        }
      }
      return enabled;
    })
    .catch(() => install.enabled ?? true)
    .finally(() => {
      install.reading = null;
    });
  install.reading = reading;
  return reading;
}

function openOn(state: Slot, install: Live) {
  // The host may have cleaned this install up while its setting was being read.
  if (!state.installs.includes(install)) return;
  try {
    install.open();
  } catch {
    // Never throw out of a window listener.
  }
}

/**
 * Opens the board of the first host whose setting is on. With none known to be on, reads every host not known
 * to be off, together, and opens the first (in install order) that reads on.
 */
function openActive(state: Slot) {
  const on = state.installs.find((install) => install.enabled === true);
  if (on) {
    openOn(state, on);
    void refresh(on);
    return;
  }
  const candidates = state.installs.filter((install) => install.enabled !== false);
  if (candidates.length === 0) return;
  void Promise.all(candidates.map((install) => refresh(install))).then((results) => {
    const index = results.findIndex((enabled, i) => enabled && state.installs.includes(candidates[i]));
    if (index >= 0) openOn(state, candidates[index]);
  });
}

function keyEvent(raw: unknown): TapKeyEvent | null {
  const e = raw as Partial<TapKeyEvent> | null;
  if (!e || (e.type !== "keydown" && e.type !== "keyup") || typeof e.key !== "string") return null;
  return { type: e.type, key: e.key, repeat: !!e.repeat, ctrlKey: !!e.ctrlKey, shiftKey: !!e.shiftKey, altKey: !!e.altKey, metaKey: !!e.metaKey };
}

function listen(target: WindowLike, state: Slot): () => void {
  const onKey = (raw: unknown) => {
    try {
      const event = keyEvent(raw);
      if (event && state.detector.key(event, now())) openActive(state);
    } catch {
      // Never throw out of a window listener.
    }
  };
  const onReset = () => state.detector.reset();
  // Every element's blur reaches the window's capture phase; only the window itself losing focus resets.
  const onBlur = (raw: unknown) => {
    try {
      if ((raw as { target?: unknown } | null)?.target === target) state.detector.reset();
    } catch {
      // Never throw out of a window listener.
    }
  };
  const keys = ["keydown", "keyup"];
  const resets = ["pointerdown", "mousedown"];
  keys.forEach((type) => target.addEventListener(type, onKey, true));
  resets.forEach((type) => target.addEventListener(type, onReset, true));
  target.addEventListener("blur", onBlur, true);
  return () => {
    keys.forEach((type) => target.removeEventListener(type, onKey, true));
    resets.forEach((type) => target.removeEventListener(type, onReset, true));
    target.removeEventListener("blur", onBlur, true);
  };
}

/** Installs the gesture for one host; returns its cleanup. Off the web, or without a window, does nothing. Never throws. */
export function installDoubleTapCtrl(install: DoubleTapInstall): () => void {
  try {
    if (Platform.OS !== "web") return () => {};
    const target = windowLike();
    if (!target) return () => {};
    const g = globalThis as Record<string, unknown>;
    let state = slot();
    if (!state) {
      state = { installs: [], detector: createDoubleTapDetector(), remove: null };
      g[SLOT_KEY] = state;
    }
    const live: Live = { ...install, enabled: null, reading: null };
    state.installs.push(live);
    if (!state.remove) state.remove = listen(target, state);
    const warm = setTimeout(() => void refresh(live), WARM_DELAY_MS);
    const own = state;
    return () => {
      try {
        clearTimeout(warm);
        own.installs = own.installs.filter((item) => item !== live);
        if (own.installs.length === 0) {
          own.remove?.();
          own.remove = null;
          own.detector.reset();
          if (g[SLOT_KEY] === own) delete g[SLOT_KEY];
        }
      } catch {
        // Cleanup never throws either.
      }
    };
  } catch {
    return () => {};
  }
}

/**
 * The settings page switched the gesture: takes effect at once, then every host is read again so a host whose
 * own setting differs gets its value back.
 */
export function noteDoubleTapSetting(enabled: boolean) {
  try {
    const state = slot();
    if (!state) return;
    state.installs.forEach((install) => {
      const before = install.enabled;
      install.enabled = enabled;
      if (before !== enabled) install.changed?.(enabled);
    });
    setTimeout(() => {
      const current = slot();
      current?.installs.forEach((install) => void refresh(install));
    }, SETTLE_DELAY_MS);
  } catch {
    // Never throws.
  }
}
