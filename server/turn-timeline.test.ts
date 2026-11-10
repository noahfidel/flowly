import { expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { turnTimeline } from "./turn-timeline";

vi.mock("./error-report", () => ({ logFailure: vi.fn() }));

const paseoWith = (refetch: (...args: unknown[]) => unknown) =>
  ({ agents: { ref: () => ({ timeline: { refetch } }) } }) as unknown as PaseoApi;

test("the turn is the last one of the newest page", async () => {
  const refetch = vi.fn(async () => ({
    entries: [
      { item: { type: "user_message", text: "old" } },
      { item: { type: "assistant_message", text: "old reply" } },
      { item: { type: "user_message", text: "new" } },
      { item: { type: "tool_call", name: "Bash" } },
      { item: { type: "assistant_message", text: "new reply" } },
    ],
  }));
  const turn = await turnTimeline<{ type: string }>(paseoWith(refetch), "agent-1");
  expect(turn.map((i) => i.type)).toEqual(["user_message", "tool_call", "assistant_message"]);
  expect(refetch).toHaveBeenCalledWith({ direction: "tail", limit: 200, projection: "projected" });
});

test("a failed read gives an empty turn", async () => {
  const turn = await turnTimeline<{ type: string }>(paseoWith(async () => { throw new Error("gone"); }), "a");
  expect(turn).toEqual([]);
});
