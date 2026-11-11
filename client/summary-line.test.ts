import { describe, expect, it } from "vitest";
import { nativeSessionSettingsValues } from "../shared/settings";
import { RECAP_LINE_MAX, progressRowView, recapLine } from "./summary-line";

describe("recapLine", () => {
  it("is empty for an empty or blank recap", () => {
    expect(recapLine("")).toBe("");
    expect(recapLine("   \n  ")).toBe("");
  });

  it("keeps a recap without a sentence end whole", () => {
    expect(recapLine("Wired the settings switch")).toBe("Wired the settings switch");
  });

  it("takes the first of several sentences", () => {
    expect(recapLine("Added the helper. Wrote the tests! Then ran them?")).toBe("Added the helper.");
    expect(recapLine("Is it done? Not yet.")).toBe("Is it done?");
  });

  it("does not split inside a number or a file name", () => {
    expect(recapLine("Bumped to 1.9.0 and fixed summary-row.tsx. Then tested.")).toBe("Bumped to 1.9.0 and fixed summary-row.tsx.");
  });

  it("splits at a CJK sentence end", () => {
    expect(recapLine("完成了设置。然后运行了测试。")).toBe("完成了设置。");
  });

  it("uses the first non-empty line and strips its bullet", () => {
    expect(recapLine("\n- First item done\n- Second item")).toBe("First item done");
    expect(recapLine("* Star bullet")).toBe("Star bullet");
    expect(recapLine("1. Numbered item. More.")).toBe("Numbered item.");
    expect(recapLine("## Heading line")).toBe("Heading line");
  });

  it("strips markdown emphasis and code markers", () => {
    expect(recapLine("**Fixed** the `row` and _the_ __drawer__.")).toBe("Fixed the row and the drawer.");
  });

  it("collapses inner whitespace", () => {
    expect(recapLine("Fixed   the\trow")).toBe("Fixed the row");
  });

  it("caps a very long sentence with an ellipsis", () => {
    const long = "word ".repeat(200).trim();
    const line = recapLine(long);
    expect(line.length).toBeLessThanOrEqual(RECAP_LINE_MAX);
    expect(line.length).toBeGreaterThan(RECAP_LINE_MAX - 5);
    expect(line.endsWith("…")).toBe(true);
    expect(line.endsWith(" …")).toBe(false);
  });
});

describe("progressRowView", () => {
  it("starts as the one line with the setting on, and a remount (no choice yet) starts there again", () => {
    expect(progressRowView(true, null)).toBe("line");
  });
  it("Show more opens the full card with its own Show less; Show less goes back to the line", () => {
    expect(progressRowView(true, true)).toBe("full");
    expect(progressRowView(true, false)).toBe("line");
  });
  it("with the setting off, the open card that clamps itself (the earlier behaviour)", () => {
    expect(progressRowView(false, null)).toBe("open-card");
  });
  it("a press on this row wins over a setting that arrived later", () => {
    expect(progressRowView(false, false)).toBe("line");
    expect(progressRowView(false, true)).toBe("full");
  });
  it("the setting defaults to on", () => {
    expect(nativeSessionSettingsValues({}).progressCollapsed).toBe(true);
    expect(nativeSessionSettingsValues({ nextMoveTap: "copy" }).progressCollapsed).toBe(true);
  });
});
