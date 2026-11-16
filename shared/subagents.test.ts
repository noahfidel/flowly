import { describe, expect, it } from "vitest";
import { chipSegments, childAgents, mergedCounts, parentAgentLabel, providerBucket, providerListOrThrow, providerOrder, providerTitle, sessionTree, subagentBucket, subagentCounts, subagentRows, type ProviderSubagent, type SubagentSource } from "./subagents";

const agent = (over: Partial<SubagentSource> & { id: string }): SubagentSource => ({
  createdAt: "2026-10-19T08:00:00.000Z",
  status: "idle",
  labels: {},
  ...over,
});
const child = (id: string, parent: string, over: Partial<SubagentSource> = {}) =>
  agent({ id, labels: { "paseo.parent-agent-id": parent }, ...over });

describe("childAgents", () => {
  it("lists live children of the parent only, oldest first", () => {
    const list = [
      child("b", "p", { createdAt: "2026-10-19T08:02:00.000Z" }),
      child("a", "p", { createdAt: "2026-10-19T08:01:00.000Z" }),
      child("x", "other"),
      child("gone", "p", { archivedAt: "2026-10-19T09:00:00.000Z" }),
      agent({ id: "p" }),
      agent({ id: "plain" }),
    ];
    expect(childAgents(list, "p").map((a) => a.id)).toEqual(["a", "b"]);
  });
  it("ignores a self-reference and blank labels", () => {
    expect(childAgents([child("p", "p"), child("y", " ")], "p")).toEqual([]);
  });
});

describe("subagentBucket", () => {
  it("puts waiting before failure and failure before running", () => {
    expect(subagentBucket(agent({ id: "1", status: "running", pendingPermissions: [{}] }))).toBe("needs_input");
    expect(subagentBucket(agent({ id: "2", status: "idle", attentionReason: "permission" }))).toBe("needs_input");
    expect(subagentBucket(agent({ id: "3", status: "error" }))).toBe("failed");
    expect(subagentBucket(agent({ id: "4", status: "idle", attentionReason: "error" }))).toBe("failed");
    expect(subagentBucket(agent({ id: "5", status: "initializing" }))).toBe("running");
    expect(subagentBucket(agent({ id: "6", requiresAttention: true, attentionReason: "finished" }))).toBe("attention");
    expect(subagentBucket(agent({ id: "7", requiresAttention: false, attentionReason: "finished" }))).toBe("done");
    expect(subagentBucket(agent({ id: "8", status: "closed" }))).toBe("done");
  });
});

describe("chipSegments", () => {
  it("shows non-empty buckets in Paseo's order and never done", () => {
    const counts = subagentCounts([
      agent({ id: "1", status: "error" }),
      agent({ id: "2", status: "running" }),
      agent({ id: "3", status: "running" }),
      agent({ id: "4" }),
    ]);
    expect(chipSegments(counts)).toEqual([
      { bucket: "running", count: 2 },
      { bucket: "failed", count: 1 },
    ]);
  });
  it("is empty when every child is done", () => {
    expect(chipSegments(subagentCounts([agent({ id: "1" })]))).toEqual([]);
  });
});

describe("sessionTree", () => {
  const agent = (id: string, createdAt: string, parent?: string): SubagentSource => ({
    id,
    createdAt,
    status: "idle",
    labels: parent ? { [parentAgentLabel]: parent } : {},
  });

  it("nests children under their parent, oldest first, and keeps main sessions in order", () => {
    const list = [agent("main-b", "2026-10-19T03:00:00Z"), agent("c2", "2026-10-19T02:30:00Z", "main-a"), agent("main-a", "2026-10-19T01:00:00Z"), agent("c1", "2026-10-19T02:00:00Z", "main-a")];
    expect(sessionTree(list).map((n) => [n.agent.id, n.children.map((c) => c.id)])).toEqual([
      ["main-b", []],
      ["main-a", ["c1", "c2"]],
    ]);
  });

  it("a grandchild goes under the top-most ancestor on the card", () => {
    const list = [agent("main", "1"), agent("child", "2", "main"), agent("grandchild", "3", "child")];
    expect(sessionTree(list)).toEqual([{ agent: list[0], children: [list[1], list[2]] }]);
  });

  it("a child whose parent is not on the card, and a cycle, stay main sessions", () => {
    const orphan = agent("orphan", "1", "elsewhere");
    const a = agent("a", "2", "b");
    const b = agent("b", "3", "a");
    expect(sessionTree([orphan]).map((n) => n.agent.id)).toEqual(["orphan"]);
    const tree = sessionTree([a, b]);
    expect(tree.map((n) => [n.agent.id, n.children.length])).toEqual([["a", 0], ["b", 0]]);
  });
});

describe("provider subagents (SUBAGENTS-SPEC §9.3)", () => {
  const provider = (id: string, over: Partial<ProviderSubagent> = {}): ProviderSubagent => ({
    id,
    parentSubagentId: null,
    provider: "claude",
    title: "sonnet-coder",
    description: null,
    status: "completed",
    createdAt: "2026-11-16T10:00:00.000Z",
    updatedAt: "2026-11-16T10:00:00.000Z",
    subtitle: null,
    ...over,
  });

  it("maps provider states to buckets; a provider subagent never needs input", () => {
    expect(providerBucket("running")).toBe("running");
    expect(providerBucket("failed")).toBe("failed");
    expect(providerBucket("completed")).toBe("done");
    expect(providerBucket("canceled")).toBe("done");
  });

  it("counts native children and provider subagents together", () => {
    const counts = mergedCounts(
      [agent({ id: "n1", status: "running" }), agent({ id: "n2", pendingPermissions: [{}] })],
      [provider("p1", { status: "running" }), provider("p2", { status: "failed" }), provider("p3"), provider("p4", { status: "canceled" })],
    );
    expect(counts).toEqual({ running: 2, needs_input: 1, failed: 1, attention: 0, done: 2 });
    expect(chipSegments(counts).map((s) => s.bucket)).toEqual(["running", "needs_input", "failed"]);
  });

  it("orders provider subagents oldest first, a nested one after its parent, indented one step", () => {
    const list = [
      provider("late", { createdAt: "2026-11-16T10:05:00.000Z" }),
      provider("grandchild", { createdAt: "2026-11-16T10:04:00.000Z", parentSubagentId: "child" }),
      provider("child", { createdAt: "2026-11-16T10:03:00.000Z", parentSubagentId: "first" }),
      provider("first", { createdAt: "2026-11-16T10:01:00.000Z" }),
      provider("orphan", { createdAt: "2026-11-16T10:02:00.000Z", parentSubagentId: "missing" }),
    ];
    expect(providerOrder(list).map((r) => [r.subagent.id, r.depth])).toEqual([
      ["first", 0],
      ["child", 1],
      ["grandchild", 1],
      ["orphan", 0],
      ["late", 0],
    ]);
  });

  it("never loses a subagent in a parent cycle", () => {
    const list = [provider("a", { parentSubagentId: "b" }), provider("b", { parentSubagentId: "a", createdAt: "2026-11-16T10:01:00.000Z" })];
    expect(providerOrder(list).map((r) => r.subagent.id).sort()).toEqual(["a", "b"]);
  });

  it("lists native children first, then provider subagents", () => {
    const native = [child("n1", "p")];
    const rows = subagentRows(native, [provider("x")]);
    expect(rows.map((r) => (r.kind === "native" ? r.agent.id : r.subagent.id))).toEqual(["n1", "x"]);
  });

  it("titles a provider subagent by its description, else its type", () => {
    expect(providerTitle(provider("1", { description: " Fix the chip ", title: "sonnet-coder" }))).toBe("Fix the chip");
    expect(providerTitle(provider("2", { description: " ", title: "browser-qa" }))).toBe("browser-qa");
    expect(providerTitle(provider("3", { description: null, title: null }))).toBeNull();
  });
});

describe("providerListOrThrow", () => {
  it("returns a good answer and throws on an unavailable one, so the last good list stays", () => {
    const answer = { subagents: [], unavailable: false };
    expect(providerListOrThrow(answer)).toBe(answer);
    expect(() => providerListOrThrow({ subagents: [], unavailable: true })).toThrow();
  });
});
