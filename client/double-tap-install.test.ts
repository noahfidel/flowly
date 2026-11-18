import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
const { installDoubleTapCtrl, noteDoubleTapSetting } = await import("./double-tap-install");

type Listener = (event: unknown) => void;
let listeners: Map<string, Set<Listener>>;
const fire = (type: string, event: Record<string, unknown>) => listeners.get(type)?.forEach((listener) => listener({ type, ...event }));
const key = (type: "keydown" | "keyup") => fire(type, { key: "Control", repeat: false, ctrlKey: type === "keydown", shiftKey: false, altKey: false, metaKey: false });
const tap = () => {
  key("keydown");
  key("keyup");
};
const doubleTap = () => {
  tap();
  tap();
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  listeners = new Map();
  vi.stubGlobal("addEventListener", (type: string, listener: Listener) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(listener);
  });
  vi.stubGlobal("removeEventListener", (type: string, listener: Listener) => listeners.get(type)?.delete(listener));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function host(read: () => Promise<boolean> | boolean) {
  const open = vi.fn();
  const readEnabled = vi.fn(read as () => Promise<boolean>);
  return { open, readEnabled, install: { open, readEnabled } };
}

describe("double-tap Ctrl install (SHORTCUTS-SPEC §5)", () => {
  test("with several hosts, opens the first host whose setting is on", async () => {
    const a = host(async () => false);
    const b = host(async () => true);
    const stops = [installDoubleTapCtrl(a.install), installDoubleTapCtrl(b.install)];
    doubleTap();
    await flush();
    expect(a.open).not.toHaveBeenCalled();
    expect(b.open).toHaveBeenCalledTimes(1);
    // Now known: A off, B on; the next double tap opens B at once without waiting for a read.
    doubleTap();
    expect(b.open).toHaveBeenCalledTimes(2);
    stops.forEach((stop) => stop());
  });

  test("a failed read with nothing known falls back to on; a synchronous throw does not escape", async () => {
    const failing = host(async () => {
      throw new Error("offline");
    });
    const stop = installDoubleTapCtrl(failing.install);
    doubleTap();
    await flush();
    expect(failing.open).toHaveBeenCalledTimes(1);
    stop();
    const throwing = host(() => {
      throw new Error("sync");
    });
    const stop2 = installDoubleTapCtrl(throwing.install);
    expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
    await flush();
    doubleTap();
    await flush();
    expect(throwing.open).toHaveBeenCalledTimes(1);
    stop2();
  });

  test("a host switched off does not open, at once", async () => {
    const a = host(async () => true);
    const stop = installDoubleTapCtrl(a.install);
    noteDoubleTapSetting(false);
    doubleTap();
    await flush();
    expect(a.open).not.toHaveBeenCalled();
    expect(a.readEnabled).not.toHaveBeenCalled();
    stop();
  });

  test("an element's blur between taps keeps the gesture; the window's own blur resets it", async () => {
    const a = host(async () => true);
    const stop = installDoubleTapCtrl(a.install);
    tap();
    fire("blur", { target: {} });
    tap();
    await flush();
    expect(a.open).toHaveBeenCalledTimes(1);
    tap();
    fire("blur", { target: globalThis });
    tap();
    await flush();
    expect(a.open).toHaveBeenCalledTimes(1);
    stop();
  });

  test("the last cleanup removes every listener", () => {
    const stops = [installDoubleTapCtrl(host(async () => true).install), installDoubleTapCtrl(host(async () => true).install)];
    stops[0]();
    expect(listeners.get("keydown")?.size).toBe(1);
    stops[1]();
    ["keydown", "keyup", "pointerdown", "mousedown", "blur"].forEach((type) => expect(listeners.get(type)?.size ?? 0).toBe(0));
  });
});
