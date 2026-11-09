import { afterEach, expect, test, vi } from "vitest";
import { answeredAsks, forgetAnsweredMissing, markAsksAnswered, subscribeAnsweredAsks } from "./answered-asks";
import { attentionItems, openAskCount } from "./attention";

const now = "2026-11-08T10:00:00.000Z";
const project = { id: "p", paseoProjectId: "p", title: "p", description: "", primaryPath: "/p", repos: ["/p"], revision: 1, createdAt: now, updatedAt: now, archivedAt: null };
const task = {
  id: "a", projectId: "p", workspaceId: "wa", sourcePath: "/p", repoPaths: ["/p"], title: "a", description: "",
  status: "development" as const, priority: "normal" as const, position: 0, revision: 1, operationId: "a", createdAt: now, updatedAt: now, archivedAt: null,
};
const agents = [{ id: "s1", workspaceId: "wa", status: "idle" as const, archivedAt: null, updatedAt: now, pendingPermissions: [{ id: "r1", kind: "tool" }, { id: "r2", kind: "tool" }] }];

afterEach(() => forgetAnsweredMissing(new Set()));

test("an answered ask leaves the bell count until it leaves the live list", () => {
  const items = attentionItems({ projects: [project], tasks: [task], events: [] }, agents, [], false);
  expect(openAskCount(items)).toBe(2);
  const heard = vi.fn();
  const stop = subscribeAnsweredAsks(heard);
  markAsksAnswered(["p:s1:r1"]);
  expect(heard).toHaveBeenCalledTimes(1);
  // The session still shows the request: the count leaves it out.
  expect(openAskCount(items, answeredAsks())).toBe(1);
  // Marking again changes nothing and tells nobody.
  markAsksAnswered(["p:s1:r1"]);
  expect(heard).toHaveBeenCalledTimes(1);
  // Still live: kept. Gone from the live list: forgotten, so a later ask with that key would count again.
  forgetAnsweredMissing(new Set(["p:s1:r1", "p:s1:r2"]));
  expect(answeredAsks().has("p:s1:r1")).toBe(true);
  forgetAnsweredMissing(new Set(["p:s1:r2"]));
  expect(answeredAsks().has("p:s1:r1")).toBe(false);
  expect(heard).toHaveBeenCalledTimes(2);
  stop();
  markAsksAnswered(["p:s1:r2"]);
  expect(heard).toHaveBeenCalledTimes(2);
});
