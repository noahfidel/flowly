import { describe, expect, test } from "vitest";
import { DOUBLE_TAP_MS, createDoubleTapDetector, type TapKeyEvent } from "./double-tap";

const plain = { repeat: false, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
const down = (key: string, extra: Partial<TapKeyEvent> = {}): TapKeyEvent => ({ ...plain, type: "keydown", key, ctrlKey: key === "Control", ...extra });
const up = (key: string, extra: Partial<TapKeyEvent> = {}): TapKeyEvent => ({ ...plain, type: "keyup", key, ...extra });

/** Feeds [event, time] pairs and returns the times at which the detector fired. */
function run(steps: [TapKeyEvent, number][], windowMs?: number) {
  const detector = createDoubleTapDetector(windowMs);
  return steps.filter(([event, now]) => detector.key(event, now)).map(([, now]) => now);
}

describe("double tap of Ctrl (SHORTCUTS-SPEC §8)", () => {
  test("the window is 300 ms", () => {
    expect(DOUBLE_TAP_MS).toBe(300);
  });

  test("two quick taps fire on the second keyup", () => {
    expect(run([[down("Control"), 0], [up("Control"), 60], [down("Control"), 200], [up("Control"), 260]])).toEqual([260]);
  });

  test("a second tap that starts too late does not fire", () => {
    expect(run([[down("Control"), 0], [up("Control"), 60], [down("Control"), 400], [up("Control"), 450]])).toEqual([]);
  });

  test("a slow second tap starts a new first tap", () => {
    expect(run([[down("Control"), 0], [up("Control"), 60], [down("Control"), 400], [up("Control"), 450], [down("Control"), 550], [up("Control"), 600]])).toEqual([600]);
  });

  test("a held Ctrl is not a tap", () => {
    // First press held past the window.
    expect(run([[down("Control"), 0], [up("Control"), 500], [down("Control"), 600], [up("Control"), 650]])).toEqual([]);
    // Second press held past the window.
    expect(run([[down("Control"), 0], [up("Control"), 50], [down("Control"), 100], [up("Control"), 700]])).toEqual([]);
  });

  test("a single tap does not fire", () => {
    expect(run([[down("Control"), 0], [up("Control"), 60]])).toEqual([]);
  });

  test("another key between the taps resets", () => {
    expect(run([[down("Control"), 0], [up("Control"), 50], [down("x"), 100], [up("x"), 120], [down("Control"), 150], [up("Control"), 200]])).toEqual([]);
  });

  test("Ctrl combos are not taps (Ctrl+Tab, then a Ctrl tap)", () => {
    expect(run([[down("Control"), 0], [down("Tab", { ctrlKey: true }), 40], [up("Tab", { ctrlKey: true }), 60], [up("Control"), 80], [down("Control"), 150], [up("Control"), 200]])).toEqual([]);
    expect(run([[down("Control"), 0], [down("`", { ctrlKey: true }), 40], [up("Control"), 80], [down("Control"), 150], [up("Control"), 200]])).toEqual([]);
  });

  test("a missed Tab keydown still cannot fire through a long hold", () => {
    // The switcher swallowed the Tab keydown while its hold mode was open; the hold itself fails the duration rule.
    expect(run([[down("Control"), 0], [up("Control"), 900], [down("Control"), 1000], [up("Control"), 1050]])).toEqual([]);
  });

  test("Ctrl with Shift, Alt or Meta is not a tap", () => {
    expect(run([[down("Control", { shiftKey: true }), 0], [up("Control"), 50], [down("Control", { shiftKey: true }), 100], [up("Control"), 150]])).toEqual([]);
    expect(run([[down("Control"), 0], [down("Shift", { ctrlKey: true, shiftKey: true }), 20], [up("Shift"), 40], [up("Control"), 60], [down("Control"), 100], [up("Control"), 150]])).toEqual([]);
    expect(run([[down("Control", { altKey: true }), 0], [up("Control"), 50], [down("Control", { altKey: true }), 100], [up("Control"), 150]])).toEqual([]);
    expect(run([[down("Control", { metaKey: true }), 0], [up("Control"), 50], [down("Control", { metaKey: true }), 100], [up("Control"), 150]])).toEqual([]);
  });

  test("repeat keydowns are ignored", () => {
    // Auto-repeat of Ctrl within a short press neither counts nor resets.
    expect(run([[down("Control"), 0], [down("Control", { repeat: true }), 30], [up("Control"), 60], [down("Control"), 100], [down("Control", { repeat: true }), 130], [up("Control"), 160]])).toEqual([160]);
    // A repeating other key does not reset either (it can only be a held key that started before).
    expect(run([[down("Control"), 0], [up("Control"), 50], [down("a", { repeat: true }), 70], [down("Control"), 100], [up("Control"), 150]])).toEqual([150]);
  });

  test("reset (pointer down, window blur) between taps prevents firing", () => {
    const detector = createDoubleTapDetector();
    expect(detector.key(down("Control"), 0)).toBe(false);
    expect(detector.key(up("Control"), 50)).toBe(false);
    detector.reset();
    expect(detector.key(down("Control"), 100)).toBe(false);
    expect(detector.key(up("Control"), 150)).toBe(false);
  });

  test("reset during a press drops that press", () => {
    const detector = createDoubleTapDetector();
    detector.key(down("Control"), 0);
    detector.key(up("Control"), 50);
    detector.key(down("Control"), 100);
    detector.reset();
    expect(detector.key(up("Control"), 150)).toBe(false);
  });

  test("a triple tap fires once: after firing, the next tap is a first tap again", () => {
    const taps = (count: number) => {
      const steps: [TapKeyEvent, number][] = [];
      [0, 100, 200, 300].slice(0, count).forEach((at) => steps.push([down("Control"), at], [up("Control"), at + 40]));
      return steps;
    };
    expect(run(taps(3))).toEqual([140]);
    // The third tap started fresh, so the fourth completes a new pair.
    expect(run(taps(4))).toEqual([140, 340]);
  });

  test("a Ctrl keydown after a missed keyup restarts from that press", () => {
    // Keyup at 50 was missed; the press at 100 is a first tap, the one at 200 the second.
    expect(run([[down("Control"), 0], [down("Control"), 100], [up("Control"), 140], [down("Control"), 200], [up("Control"), 240]])).toEqual([240]);
    // Missed keyup, then only one more tap: no fire.
    expect(run([[down("Control"), 0], [down("Control"), 100], [up("Control"), 140]])).toEqual([]);
  });

  test("a stray keyup without a keydown does nothing", () => {
    expect(run([[up("Control"), 0], [down("Control"), 50], [up("Control"), 100]])).toEqual([]);
  });

  test("a custom window is honoured", () => {
    expect(run([[down("Control"), 0], [up("Control"), 50], [down("Control"), 400], [up("Control"), 450]], 500)).toEqual([450]);
  });
});
