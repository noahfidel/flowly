import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { stateColors } from "./state-colors";

const light = { accent: "#2563eb", statusSuccess: "#16a34a", statusWarning: "#d97706", statusDanger: "#dc2626" };
const dark = { accent: "#60a5fa", statusSuccess: "#4ade80", statusWarning: "#fbbf24", statusDanger: "#f87171" };

describe("state colors", () => {
  for (const [name, palette] of [["light", light], ["dark", dark]] as const) {
    test(`${name} palette maps each state to its host token`, () => {
      const s = stateColors(palette as never);
      expect(s.running).toBe(palette.accent);
      expect(s.unread).toBe(palette.statusSuccess);
      expect(s.needsYou).toBe(palette.statusWarning);
      expect(s.error).toBe(palette.statusDanger);
      expect(s.running).not.toBe(s.unread);
    });
  }

  test("the overview bar takes running and updated colors from the one mapping", () => {
    const src = readFileSync(new URL("./overview-bar.tsx", import.meta.url), "utf8");
    expect(src).toContain("stateColors(");
    expect(src).toContain("<PulseDot color={state.running}");
    expect(src).toContain("<Dot size={7} color={state.unread}");
    expect(src).not.toContain("colors.statusSuccess");
    expect(src).not.toMatch(/<(Pulse)?Dot[^>]*color={colors\./);
  });
});
