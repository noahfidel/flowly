import { afterEach, expect, test, vi } from "vitest";

// A minimal hook runner: one component instance per `mount`, effects run after each render, cleanups on dependency
// change and at unmount. Enough to replay the focus/blur sequences of SHORTCUTS-SPEC §2.2 without a DOM.
const fake = vi.hoisted(() => {
  type Slot = { deps?: unknown[]; cleanup?: void | (() => void); value?: unknown };
  let slots: Slot[] = [];
  let index = 0;
  let pending: (() => void)[] = [];
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return {
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const slot = (slots[index] ??= {});
      index++;
      if (same(slot.deps, deps)) return;
      slot.deps = deps;
      pending.push(() => {
        if (typeof slot.cleanup === "function") slot.cleanup();
        slot.cleanup = effect();
      });
    },
    useRef<T>(initial: T) {
      const slot = (slots[index] ??= { value: { current: initial } });
      index++;
      return slot.value as { current: T };
    },
    mount(render: () => void) {
      const own: Slot[] = [];
      const run = () => {
        slots = own;
        index = 0;
        pending = [];
        render();
        const effects = pending;
        effects.forEach((e) => e());
      };
      run();
      return {
        rerender: run,
        unmount() {
          own.forEach((slot) => typeof slot.cleanup === "function" && slot.cleanup());
        },
      };
    },
  };
});
vi.mock("react", () => ({ useEffect: fake.useEffect, useRef: fake.useRef }));
afterEach(() => vi.resetModules());

test("an input removed while focused releases its owner's shortcut block (React drops that blur)", async () => {
  const { shortcutsBlocked, useShortcutBlock, useBlurOnUnmount } = await import("./shortcuts");
  // The owner (TagEditor, OptionList, the composer's parent) tracks focus through the input's onFocus/onBlur.
  let focused = false;
  const owner = fake.mount(() => useShortcutBlock(focused));
  const input = fake.mount(() => useBlurOnUnmount(focused, () => {
    focused = false;
    owner.rerender();
  }));
  focused = true;
  owner.rerender();
  input.rerender();
  expect(shortcutsBlocked()).toBe(true);
  // Esc closes the tag input (or the dispatcher box goes away): the input unmounts, no onBlur arrives from React.
  input.unmount();
  expect(focused).toBe(false);
  expect(shortcutsBlocked()).toBe(false);
  owner.unmount();
});

test("an input unmounted after a normal blur reports nothing more, and the latest onBlur is the one called", async () => {
  const { useBlurOnUnmount } = await import("./shortcuts");
  const first = vi.fn();
  const latest = vi.fn();
  let focused = true;
  let onBlur = first;
  const input = fake.mount(() => useBlurOnUnmount(focused, onBlur));
  onBlur = latest;
  input.rerender();
  input.unmount();
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(1);

  const blurred = vi.fn();
  focused = true;
  const other = fake.mount(() => useBlurOnUnmount(focused, blurred));
  focused = false;
  other.rerender();
  other.unmount();
  expect(blurred).not.toHaveBeenCalled();
});

test("a handled shortcut hands focus back to the board root, except D which focuses the dispatcher box", async () => {
  const { shortcutRefocusesBoard } = await import("./shortcuts");
  // Back / Forward and J/K/H/L remount the card sidebar (keyed by card), which drops focus held inside it to the page body.
  for (const action of ["history-back", "history-forward", "next", "previous", "left", "right", "escape", "search"] as const)
    expect(shortcutRefocusesBoard(action)).toBe(true);
  expect(shortcutRefocusesBoard("dispatcher")).toBe(false);
});
