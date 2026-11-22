import { expect, test } from "vitest";
import { cardActivities, cardActivity, isAgentActive, type RunningAgent } from "./card-running";
import { parentAgentLabel } from "./subagents";

const child = (id: string, parent: string, workspaceId: string, over: Partial<RunningAgent> = {}): RunningAgent => ({
  id,
  workspaceId,
  status: "running",
  labels: { [parentAgentLabel]: parent },
  createdAt: "2026-11-22T10:05:00Z",
  ...over,
});

test("an idle parent with a running provider subagent makes the card run", () => {
  const agents = [{ id: "s", workspaceId: "w", status: "idle" }];
  const out = cardActivity({ cardWorkspaceId: "w", agents, providerRunning: { running: { s: 2 }, since: { s: "2026-11-22T10:00:00Z" } } });
  expect(out).toEqual({ sessions: 0, starting: 0, subagents: 2, running: true, since: "2026-11-22T10:00:00Z" });
});

test("an active child in another workspace counts for the card whose session started it", () => {
  const agents = [{ id: "s", workspaceId: "w", status: "idle" }, child("c", "s", "helper")];
  expect(cardActivity({ cardWorkspaceId: "w", agents })).toMatchObject({ sessions: 0, subagents: 1, running: true, since: "2026-11-22T10:05:00Z" });
  // A starting child counts too; an idle one does not.
  expect(cardActivity({ cardWorkspaceId: "w", agents: [agents[0], child("c", "s", "helper", { status: "initializing" })] }).running).toBe(true);
  expect(cardActivity({ cardWorkspaceId: "w", agents: [agents[0], child("c", "s", "helper", { status: "idle" })] }).running).toBe(false);
});

test("a child in the card's own workspace counts once, as a session", () => {
  const agents = [{ id: "s", workspaceId: "w", status: "idle" }, child("c", "s", "w")];
  expect(cardActivity({ cardWorkspaceId: "w", agents })).toMatchObject({ sessions: 1, subagents: 0, running: true });
});

test("archived children and archived parents never count", () => {
  const archivedChild = [{ id: "s", workspaceId: "w", status: "idle" }, child("c", "s", "helper", { archivedAt: "2026-11-22T11:00:00Z" })];
  expect(cardActivity({ cardWorkspaceId: "w", agents: archivedChild }).running).toBe(false);
  const archivedParent = [{ id: "s", workspaceId: "w", status: "idle", archivedAt: "2026-11-22T11:00:00Z" }, child("c", "s", "helper")];
  expect(cardActivity({ cardWorkspaceId: "w", agents: archivedParent, providerRunning: { running: { s: 1 } } }).running).toBe(false);
});

test("a starting session counts; nothing working is idle", () => {
  expect(isAgentActive("initializing")).toBe(true);
  expect(isAgentActive("idle")).toBe(false);
  expect(cardActivity({ cardWorkspaceId: "w", agents: [{ id: "s", workspaceId: "w", status: "initializing" }] })).toMatchObject({ starting: 1, running: true });
  expect(cardActivity({ cardWorkspaceId: "w", agents: [{ id: "s", workspaceId: "w", status: "idle" }, { id: "x", workspaceId: "other", status: "running" }] })).toEqual({
    sessions: 0,
    starting: 0,
    subagents: 0,
    running: false,
    since: null,
  });
});

test("one pass covers every card; a provider count for a session outside the cards is ignored", () => {
  const agents = [
    { id: "a", workspaceId: "w-a", status: "running", activeTurn: { startedAt: "2026-11-22T10:03:00Z" } },
    { id: "b", workspaceId: "w-b", status: "idle" },
    { id: "z", workspaceId: "w-z", status: "idle" },
  ];
  const out = cardActivities(new Set(["w-a", "w-b"]), agents, { running: { b: 1, z: 4 } });
  expect([...out.keys()].sort()).toEqual(["w-a", "w-b"]);
  expect(out.get("w-a")).toMatchObject({ sessions: 1, running: true, since: "2026-11-22T10:03:00Z" });
  expect(out.get("w-b")).toMatchObject({ subagents: 1, running: true, since: null });
});
