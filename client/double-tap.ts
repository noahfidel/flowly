/**
 * Double tap of Ctrl (SHORTCUTS-SPEC §5): a pure detector, no React, no DOM. The window listener
 * (`client/double-tap-install.ts`) feeds it every keydown/keyup and calls `reset` on pointer down
 * and window blur; it fires on the keyup that completes the second tap.
 */

/** How short a press must be to count as a tap, and how soon the second tap must start after the first. */
export const DOUBLE_TAP_MS = 300;

/** The fields of a KeyboardEvent the detector reads. */
export interface TapKeyEvent {
  type: "keydown" | "keyup";
  key: string;
  repeat: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface DoubleTapDetector {
  /** Feeds one key event; true means a double tap just completed. */
  key(event: TapKeyEvent, now: number): boolean;
  /** Forgets every press and tap (pointer down, window blur). */
  reset(): void;
}

/**
 * A tap is a Ctrl keydown (no Shift, Alt or Meta held, not a repeat) and its keyup, with no other
 * keydown between them and at most `windowMs` apart. Two taps fire when the second keydown comes
 * within `windowMs` of the first keyup. Holding Ctrl longer is never a tap, so a hold mode (another
 * plugin's Ctrl+Tab) cannot fire even when its other keys never reach us. Repeats are ignored.
 */
export function createDoubleTapDetector(windowMs: number = DOUBLE_TAP_MS): DoubleTapDetector {
  /** When the clean Ctrl press now down started; null when none is. */
  let pressAt: number | null = null;
  /** The press now down is the second tap. */
  let second = false;
  /** When the first tap ended; null when there is no first tap. */
  let firstUpAt: number | null = null;
  const reset = () => {
    pressAt = null;
    second = false;
    firstUpAt = null;
  };
  return {
    reset,
    key(event, now) {
      if (event.type === "keydown") {
        if (event.repeat) return false;
        if (event.key !== "Control" || event.shiftKey || event.altKey || event.metaKey) {
          reset();
          return false;
        }
        // Ctrl already down (its keyup was missed): this press is a first tap.
        if (pressAt !== null) {
          reset();
          pressAt = now;
          return false;
        }
        second = firstUpAt !== null && now - firstUpAt <= windowMs;
        if (!second) firstUpAt = null;
        pressAt = now;
        return false;
      }
      if (event.key !== "Control" || pressAt === null) return false;
      const held = now - pressAt;
      pressAt = null;
      if (held > windowMs) {
        reset();
        return false;
      }
      if (second) {
        reset();
        return true;
      }
      firstUpAt = now;
      return false;
    },
  };
}
