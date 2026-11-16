import { beforeEach, describe, expect, it } from "vitest";
import { DESCRIPTION_CLAMP_HEIGHT, clampOverflows, descriptionOpen, resetDescriptionOpen, setDescriptionOpen } from "./description-clamp";

// SessionMarkdown body text is 14 pt with lineHeight size * 1.55 (client/session-content.tsx).
const LINE_HEIGHT = 14 * 1.55;

describe("DESCRIPTION_CLAMP_HEIGHT", () => {
  it("is about six lines of the description text", () => {
    expect(DESCRIPTION_CLAMP_HEIGHT).toBeGreaterThan(5 * LINE_HEIGHT);
    expect(DESCRIPTION_CLAMP_HEIGHT).toBeLessThan(7 * LINE_HEIGHT);
  });
});

describe("clampOverflows", () => {
  const clamp = 120;
  it("is false for content that fits or is only a few points over", () => {
    expect(clampOverflows(0, clamp)).toBe(false);
    expect(clampOverflows(clamp, clamp)).toBe(false);
    expect(clampOverflows(clamp + 8, clamp)).toBe(false);
  });

  it("is true past the 8 point slack", () => {
    expect(clampOverflows(clamp + 9, clamp)).toBe(true);
  });
});

describe("description open state", () => {
  beforeEach(() => resetDescriptionOpen());

  it("starts collapsed", () => {
    expect(descriptionOpen("a")).toBe(false);
  });

  it("is kept per card", () => {
    setDescriptionOpen("a", true);
    expect(descriptionOpen("a")).toBe(true);
    expect(descriptionOpen("b")).toBe(false);
  });

  it("keeps the choice when the drawer is reopened", () => {
    setDescriptionOpen("a", true);
    expect(descriptionOpen("a")).toBe(true);
    expect(descriptionOpen("a")).toBe(true);
  });

  it("collapses again when closed", () => {
    setDescriptionOpen("a", true);
    setDescriptionOpen("a", false);
    expect(descriptionOpen("a")).toBe(false);
  });
});
