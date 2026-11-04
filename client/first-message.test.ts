import { describe, expect, test } from "vitest";
import { firstMessage } from "./first-message";

const ticket = { key: "ZEN-8658", itemType: "issue", summary: "Fix the login loop" };
const pull = { key: "acme/web#12", itemType: "pull", summary: "Retry with backoff" };
const page = { key: "123456", itemType: "page", summary: "Login design" };

describe("New task first message", () => {
  test("typed text is sent as typed, without the default", () => {
    expect(firstMessage("Only fix the Safari case", [ticket])).toBe("Only fix the Safari case");
    expect(firstMessage("  Look at the logs first\n", [])).toBe("Look at the logs first");
  });
  test("empty with attached items sends the default naming them", () => {
    expect(firstMessage("", [ticket])).toBe("Start on this card: read its inputs, including ZEN-8658, then begin.");
    expect(firstMessage("", [ticket, pull, page])).toBe("Start on this card: read its inputs, including ZEN-8658, acme/web#12, Login design, then begin.");
  });
  test("empty without attached items blocks Create", () => {
    expect(firstMessage("", [])).toBeNull();
  });
  test("whitespace counts as empty", () => {
    expect(firstMessage(" \n\t ", [])).toBeNull();
    expect(firstMessage(" \n\t ", [ticket])).toBe("Start on this card: read its inputs, including ZEN-8658, then begin.");
  });
});
