import { expect, test, vi } from "vitest";
import { cardBoxEscape, composerAutoFocus, composerPassThrough, requestInputFocus } from "./chat-focus-logic";

test("a chat the user opened focuses its box on web only, and not while a Paseo request is pending", () => {
  expect(composerAutoFocus({ requested: true, web: true, pendingRequests: 0 })).toBe(true);
  expect(composerAutoFocus({ requested: true, web: false, pendingRequests: 0 })).toBe(false);
  expect(composerAutoFocus({ requested: true, web: true, pendingRequests: 1 })).toBe(false);
  expect(composerAutoFocus({ requested: false, web: true, pendingRequests: 0 })).toBe(false);
});

test("only Back and Forward pass through from the box", () => {
  expect(composerPassThrough({ key: "[", ctrlKey: true }, true)).toBe("history-back");
  expect(composerPassThrough({ key: "]", ctrlKey: true }, true)).toBe("history-forward");
  expect(composerPassThrough({ key: "ArrowLeft", altKey: true }, false)).toBe("history-back");
  expect(composerPassThrough({ key: "ArrowRight", altKey: true }, false)).toBe("history-forward");
  // Other platform's chords, letters, Esc, ⌘[ and plain arrows stay with the box.
  expect(composerPassThrough({ key: "[", ctrlKey: true }, false)).toBeNull();
  expect(composerPassThrough({ key: "ArrowLeft", altKey: true }, true)).toBeNull();
  expect(composerPassThrough({ key: "o" }, true)).toBeNull();
  expect(composerPassThrough({ key: "j" }, false)).toBeNull();
  expect(composerPassThrough({ key: "Escape" }, true)).toBeNull();
  expect(composerPassThrough({ key: "[", metaKey: true }, true)).toBeNull();
  expect(composerPassThrough({ key: "ArrowLeft" }, true)).toBeNull();
  expect(composerPassThrough({ key: "ArrowRight" }, false)).toBeNull();
  expect(composerPassThrough({ key: "[", ctrlKey: true, repeat: true }, true)).toBeNull();
});

test("Esc in the card box: a draft only blurs, an empty box runs the board's chain", () => {
  expect(cardBoxEscape(false)).toBe("blur");
  expect(cardBoxEscape(true)).toBe("chain");
});

test("a focus request focuses a mounted input at once, else flags the next mount", () => {
  const input = { focus: vi.fn() };
  const flag = { current: false };
  expect(requestInputFocus(input, flag)).toBe(true);
  expect(input.focus).toHaveBeenCalledTimes(1);
  expect(flag.current).toBe(false);
  expect(requestInputFocus(null, flag)).toBe(false);
  expect(flag.current).toBe(true);
});
