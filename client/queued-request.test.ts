import { expect, test } from "vitest";
import { bannerRequestId } from "./queued-request";

test("a session's queued-messages banner denies a request only when it is the session's one pending request (DISPATCHER-SPEC §9.4; ruling, Noah 2026-11-16)", () => {
  expect(bannerRequestId([])).toBeUndefined();
  expect(bannerRequestId([{ id: "a" }])).toBe("a");
  expect(bannerRequestId([{ id: "a" }, { id: "b" }])).toBeUndefined();
});
