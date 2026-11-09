import { afterEach, expect, test, vi } from "vitest";
import { answeredAsks, bellResolved, forgetAnsweredMissing, markAsksAnswered, subscribeAnsweredAsks } from "./answered-asks";
import { dispatcherStartMessage, startAgainMessage } from "./start-again";
import { dispatcherProviderSupported } from "../shared/dispatcher";
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

test("after a reload the bell leaves out what the daemon resolved, with an empty client set", () => {
  const items = attentionItems({ projects: [project], tasks: [task], events: [] }, agents, [], false);
  const fresh = new Set<string>();
  expect(openAskCount(items, bellResolved(["p:s1:r1"], fresh))).toBe(1);
  // Not read yet: only the client's own.
  expect(openAskCount(items, bellResolved(undefined, new Set(["p:s1:r2"])))).toBe(1);
  expect(openAskCount(items, bellResolved(["p:s1:r1"], new Set(["p:s1:r2"])))).toBe(0);
  // Nothing on either side: the same set object every time, so memoized counts do not recompute.
  expect(bellResolved(undefined, fresh)).toBe(fresh);
});

test("Start again's refusals are shown in the user's words", () => {
  expect(startAgainMessage("NEEDS_WORKTREE: The card works in a directory workspace…")).toBe(
    "This card's folder already had sessions, or Flowly didn't create it for the card. Switch the card to a worktree from its menu, then start again.",
  );
  expect(startAgainMessage("CARD_HAS_SESSION: The card already has a live session (s1).")).toBe("The card already has a running session. Send it a message instead.");
  expect(startAgainMessage("CARD_FINISHED: The card is Done or Cancelled; only the user reopens it.")).toBe("The card is Done or Cancelled; only the user reopens it.");
  expect(startAgainMessage("Network down")).toBe("Network down");
});

test("the dispatcher runs only on Claude; a refused start says why and what to pick (ruling, Noah 2026-11-09)", () => {
  expect(dispatcherProviderSupported("claude/claude-sonnet-5-5")).toBe(true);
  expect(dispatcherProviderSupported("claude")).toBe(true);
  for (const p of ["codex/gpt-5", "opencode/x", "my-claude/claude-sonnet-5-5", ""]) expect(dispatcherProviderSupported(p), p).toBe(false);
  expect(dispatcherStartMessage("DISPATCHER_PROVIDER_UNSUPPORTED: The dispatcher runs only on Claude…")).toBe(
    "The dispatcher runs only on Claude: on other providers Flowly can't keep it from answering cards' questions and permission requests. Choose a Claude model for the dispatcher in Settings → Models.",
  );
  expect(dispatcherStartMessage("HOST_UNSUPPORTED: This Paseo host can't run the dispatcher.")).toBe("This Paseo host can't run the dispatcher.");
  expect(dispatcherStartMessage("Network down")).toBe("Network down");
});
