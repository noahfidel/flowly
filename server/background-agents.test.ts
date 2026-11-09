import { expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { listAttentionAgents } from "./attention-count";
import { listAgents } from "../client/resources";

// The daemon's agents.list leaves out agents in background (hidden) workspaces, where PR review cards live,
// unless the filter asks for them.
function fake() {
  const list = vi.fn(async (_input: unknown) => ({ entries: [], pageInfo: { nextCursor: null } }));
  return { list, paseo: { agents: { list } } as unknown as PaseoApi };
}

test("the attention listing asks for background workspaces", async () => {
  const f = fake();
  await listAttentionAgents(f.paseo);
  expect(f.list).toHaveBeenCalledWith(expect.objectContaining({ filter: { includeArchived: false, includeBackground: true } }));
});

test("the client's card session listing asks for background workspaces", async () => {
  const f = fake();
  await listAgents(f.paseo, "w");
  await listAgents(f.paseo, undefined, false);
  expect(f.list.mock.calls.map(([input]) => input)).toEqual([
    expect.objectContaining({ filter: { includeArchived: true, includeBackground: true } }),
    expect.objectContaining({ filter: { includeArchived: false, includeBackground: true } }),
  ]);
});
