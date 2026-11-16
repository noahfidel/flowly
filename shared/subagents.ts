/**
 * A session's subagents: Paseo-native child agents and provider subagents (SUBAGENTS-SPEC). Pure: no React, no SDK calls.
 */
import { z } from "zod";

/** Paseo's `PARENT_AGENT_ID_LABEL` (@getpaseo/protocol agent-labels). */
export const parentAgentLabel = "paseo.parent-agent-id";

export type SubagentBucket = "running" | "needs_input" | "failed" | "attention" | "done";

/** Buckets shown as chip segments, in Paseo's order; `done` is never a segment. */
export const segmentBuckets = ["running", "needs_input", "failed", "attention"] as const satisfies readonly SubagentBucket[];

export interface SubagentSource {
  id: string;
  createdAt: string;
  status: string;
  labels?: Record<string, string> | null;
  archivedAt?: string | null;
  pendingPermissions?: readonly unknown[] | null;
  requiresAttention?: boolean | null;
  attentionReason?: string | null;
}

export const parentOf = (agent: Pick<SubagentSource, "labels">): string | null => {
  const id = agent.labels?.[parentAgentLabel];
  return typeof id === "string" && id.trim() ? id.trim() : null;
};

/** Live children of `parentId`, oldest first (Paseo's order). */
export function childAgents<T extends SubagentSource>(agents: readonly T[], parentId: string): T[] {
  return agents
    .filter((a) => a.id !== parentId && !a.archivedAt && parentOf(a) === parentId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
}

export function subagentBucket(agent: SubagentSource): SubagentBucket {
  if (agent.pendingPermissions?.length || agent.attentionReason === "permission") return "needs_input";
  if (agent.status === "error" || agent.attentionReason === "error") return "failed";
  if (agent.status === "running" || agent.status === "initializing") return "running";
  if (agent.requiresAttention && agent.attentionReason === "finished") return "attention";
  return "done";
}

export type SubagentCounts = Record<SubagentBucket, number>;

export function subagentCounts(agents: readonly SubagentSource[]): SubagentCounts {
  const counts: SubagentCounts = { running: 0, needs_input: 0, failed: 0, attention: 0, done: 0 };
  for (const agent of agents) counts[subagentBucket(agent)]++;
  return counts;
}

/** The chip's segments: non-empty buckets in order; empty means "N subagents". */
export const chipSegments = (counts: SubagentCounts) =>
  segmentBuckets.filter((b) => counts[b] > 0).map((bucket) => ({ bucket, count: counts[bucket] }));

export interface SessionNode<T> {
  agent: T;
  /** Descendants started from this session, oldest first (grandchildren are flattened in). */
  children: T[];
}

/**
 * A card's sessions as main sessions with their subagents (DRAWER-SPEC, Main and sub sessions).
 * A session whose parent (or any ancestor) is also in the list goes under its top-most
 * such ancestor; everything else is a main session, in the given order. Cycles and
 * missing parents fall back to main sessions, so no session is ever hidden.
 */
export function sessionTree<T extends SubagentSource>(agents: readonly T[]): SessionNode<T>[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const rootOf = (agent: T): T => {
    let current = agent;
    const seen = new Set([agent.id]);
    for (;;) {
      const parent = parentOf(current);
      const next = parent ? byId.get(parent) : undefined;
      if (!next) return current;
      // A parent loop has no top: keep the session itself as a main session.
      if (seen.has(next.id)) return agent;
      seen.add(next.id);
      current = next;
    }
  };
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const agent of agents) {
    const root = rootOf(agent);
    if (root.id === agent.id) roots.push(agent);
    else children.set(root.id, [...(children.get(root.id) || []), agent]);
  }
  const oldestFirst = (a: T, b: T) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1);
  return roots.map((agent) => ({ agent, children: (children.get(agent.id) || []).sort(oldestFirst) }));
}

/**
 * A subagent the provider runs inside a session (Claude Code's Agent tool, Codex subagents), as
 * `subagents.provider-list` returns it (SUBAGENTS-SPEC §9.2). Not a Paseo agent.
 */
export const providerSubagentStatuses = ["running", "completed", "failed", "canceled"] as const;
export type ProviderSubagentStatus = (typeof providerSubagentStatuses)[number];
export const providerSubagentSchema = z.strictObject({
  id: z.string().min(1).max(200),
  parentSubagentId: z.string().max(200).nullable(),
  provider: z.string().max(100),
  title: z.string().max(200).nullable(),
  description: z.string().max(500).nullable(),
  status: z.enum(providerSubagentStatuses),
  createdAt: z.string().max(64),
  updatedAt: z.string().max(64),
  /** Provider-formatted (`sonnet-coder · Sonnet 5.5 · Medium · 29.8k tokens`): display only, never parsed. */
  subtitle: z.string().max(300).nullable(),
});
export type ProviderSubagent = z.infer<typeof providerSubagentSchema>;

/** Provider states to the chip's buckets; a provider subagent's permission prompts show on its parent session. */
export function providerBucket(status: ProviderSubagentStatus): SubagentBucket {
  return status === "running" ? "running" : status === "failed" ? "failed" : "done";
}

/** The chip's counts over the native children and the provider subagents together. */
export function mergedCounts(native: readonly SubagentSource[], provider: readonly Pick<ProviderSubagent, "status">[]): SubagentCounts {
  const counts = subagentCounts(native);
  for (const subagent of provider) counts[providerBucket(subagent.status)]++;
  return counts;
}

/** The row title: the task's description, else the agent type; null means "Untitled agent". */
export const providerTitle = (s: Pick<ProviderSubagent, "description" | "title">) => s.description?.trim() || s.title?.trim() || null;

type ProviderNode = Pick<ProviderSubagent, "id" | "parentSubagentId" | "createdAt">;

/**
 * Provider subagents oldest first; a nested one (`parentSubagentId`) follows its parent, indented
 * one step at any depth. A missing parent or a parent cycle leaves it a top-level row: none is lost.
 */
export function providerOrder<T extends ProviderNode>(list: readonly T[]): { subagent: T; depth: 0 | 1 }[] {
  const sorted = [...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  const byId = new Map(sorted.map((s) => [s.id, s]));
  const nested = (s: T) => {
    // Nested when its parent is listed and following parents ends at a top-level row (no cycle).
    const seen = new Set([s.id]);
    let current = s;
    for (;;) {
      const parent = current.parentSubagentId ? byId.get(current.parentSubagentId) : undefined;
      if (!parent) return current !== s;
      if (seen.has(parent.id)) return false;
      seen.add(parent.id);
      current = parent;
    }
  };
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const s of sorted) {
    if (nested(s)) children.set(s.parentSubagentId!, [...(children.get(s.parentSubagentId!) || []), s]);
    else roots.push(s);
  }
  const rows: { subagent: T; depth: 0 | 1 }[] = [];
  const visit = (s: T, depth: 0 | 1) => {
    rows.push({ subagent: s, depth });
    for (const c of children.get(s.id) || []) visit(c, 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

export type SubagentListRow<N, P> = { kind: "native"; agent: N } | { kind: "provider"; subagent: P; depth: 0 | 1 };

/** The list's one order: native children (already in §3 order), then provider subagents (`providerOrder`). */
export function subagentRows<N, P extends ProviderNode>(native: readonly N[], provider: readonly P[]): SubagentListRow<N, P>[] {
  return [
    ...native.map((agent) => ({ kind: "native" as const, agent })),
    ...providerOrder(provider).map(({ subagent, depth }) => ({ kind: "provider" as const, subagent, depth })),
  ];
}

/** A read that reports `unavailable` is an error for the query, which then keeps its last good list. */
export function providerListOrThrow<T extends { unavailable: boolean }>(response: T): T {
  if (response.unavailable) throw new Error("Provider subagents are unavailable.");
  return response;
}
