import { expect, test } from "vitest";
import type { Artifact } from "../shared/model";
import { QUICK_LIMIT, prNumberOf, prStateOf, quickLinks, quickSessionState, type QuickSession } from "./quick-links";

/** Card home quick links (DRAWER-SPEC "Quick links"): which chips, their order, limits, states and "+N more". */

let n = 0;
const at = (s: number) => new Date(Date.parse("2026-11-18T10:00:00.000Z") + s * 1000).toISOString();
const artifact = (over: Partial<Artifact> & { target: string }): Artifact =>
  ({
    id: `a${++n}`,
    taskId: "t",
    projectId: "p",
    role: "output",
    kind: /^https?:/.test(over.target) ? "url" : "file",
    title: over.target,
    note: "",
    createdBy: "agent",
    createdAt: at(n),
    updatedAt: at(n),
    ...over,
  }) as Artifact;
const session = (id: string, s: number, state: QuickSession["state"] = "done", title = ""): QuickSession => ({ id, title, createdAt: at(s), state });
const kinds = (chips: ReturnType<typeof quickLinks>) => chips.map((c) => (c.kind === "more" ? `more:${c.section}:${c.count}` : `${c.kind}:${c.id}`));

test("nothing to show gives no chips (no empty row)", () => {
  expect(quickLinks({ outputs: [], sessions: [] })).toEqual([]);
  // Inputs and the plan are not outputs: still nothing.
  const input = artifact({ target: "https://example.com/spec", role: "input" });
  const plan = artifact({ target: "./plan.md", plan: { approvedAt: null, source: "manual" } as Artifact["plan"] });
  expect(quickLinks({ outputs: [input, plan], sessions: [] })).toEqual([]);
});

test("PR numbers come from the external ref, else from a GitHub / GitLab URL; other links are not PRs", () => {
  expect(prNumberOf(artifact({ target: "https://github.com/o/r/pull/42" }))).toBe("#42");
  expect(prNumberOf(artifact({ target: "https://github.com/o/r/pull/42/files" }))).toBe("#42");
  expect(prNumberOf(artifact({ target: "https://gitlab.com/g/sub/r/-/merge_requests/7" }))).toBe("!7");
  expect(
    prNumberOf(artifact({ target: "https://ghe.example.com/o/r/pull/9", external: { connectionId: "c", provider: "github", key: "o/r#9", remoteId: "", itemType: "pull" } as Artifact["external"] })),
  ).toBe("#9");
  expect(prNumberOf(artifact({ target: "https://github.com/o/r/issues/3" }))).toBeNull();
  expect(prNumberOf(artifact({ target: "./docs/pull/3" }))).toBeNull();
  expect(prNumberOf(artifact({ target: "https://example.com/report" }))).toBeNull();
});

test("PR state words: draft, open, merged, closed; unknown says nothing", () => {
  expect(prStateOf("Draft")).toBe("draft");
  expect(prStateOf("Open")).toBe("open");
  expect(prStateOf("Merged")).toBe("merged");
  expect(prStateOf("Closed")).toBe("closed");
  expect(prStateOf(undefined)).toBe("");
  expect(prStateOf("Connection removed")).toBe("");
});

test("session state for a chip: waiting (asks or an open question) beats running, error, done", () => {
  expect(quickSessionState({ label: "Waiting for your answer", active: false, waiting: true }, false)).toBe("waiting");
  expect(quickSessionState({ label: "Running", active: true }, true)).toBe("waiting");
  expect(quickSessionState({ label: "Running", active: true }, false)).toBe("running");
  expect(quickSessionState({ label: "Starting", active: true }, false)).toBe("running");
  expect(quickSessionState({ label: "Error", active: false }, false)).toBe("error");
  for (const label of ["Finished turn", "Turn ended", "Idle", "Ready", "Closed"]) expect(quickSessionState({ label, active: false }, false)).toBe("done");
});

test("order: PRs, then sessions, then other outputs; PRs carry their number and state", () => {
  const report = artifact({ target: "https://example.com/report" });
  const pr = artifact({ target: "https://github.com/o/r/pull/12" });
  const chips = quickLinks({ outputs: [report, pr], sessions: [session("s1", 1)], prStatus: new Map([[pr.id, "Merged"]]) });
  expect(kinds(chips)).toEqual([`pr:${pr.id}`, "session:s1", `output:${report.id}`]);
  expect(chips[0]).toMatchObject({ kind: "pr", number: "#12", state: "merged", url: pr.target });
});

test("every PR gets a chip (newest first), duplicates of the same URL once, and PRs never count toward the outputs limit", () => {
  const a = artifact({ target: "https://github.com/o/r/pull/1" });
  const b = artifact({ target: "https://github.com/o/r/pull/2" });
  const again = artifact({ target: "https://github.com/o/r/pull/1" });
  const c = artifact({ target: "https://github.com/o/r/pull/3" });
  const d = artifact({ target: "https://github.com/o/r/pull/4" });
  // Callers pass outputs newest first, as the Artifacts section lists them.
  const chips = quickLinks({ outputs: [d, c, again, b, a], sessions: [] });
  expect(chips.map((c) => (c.kind === "pr" ? c.number : c.kind))).toEqual(["#4", "#3", "#1", "#2"]);
});

test("sessions: waiting first, then running, error, done; newest first within each; numbered by start order when untitled", () => {
  const chips = quickLinks({
    outputs: [],
    sessions: [session("old-done", 1), session("run", 2, "running"), session("wait", 3, "waiting"), session("new-done", 4, "done", "Fix the build")],
  });
  expect(kinds(chips)).toEqual(["session:wait", "session:run", "session:new-done", "more:sessions:1"]);
  const sessions = chips.filter((c) => c.kind === "session");
  expect(sessions.map((c) => c.id)).toEqual(["wait", "run", "new-done"]);
  // "Session N" by start order: old-done is 1, run 2, wait 3.
  expect(sessions.map((c) => (c.kind === "session" ? [c.title, c.number] : null))).toEqual([
    ["", 3],
    ["", 2],
    ["Fix the build", 4],
  ]);
});

test(`at most ${QUICK_LIMIT} sessions, then "+N more" for the Sessions section`, () => {
  const list = [1, 2, 3, 4, 5].map((s) => session(`s${s}`, s));
  expect(kinds(quickLinks({ outputs: [], sessions: list }))).toEqual(["session:s5", "session:s4", "session:s3", "more:sessions:2"]);
  expect(kinds(quickLinks({ outputs: [], sessions: list.slice(0, 3) }))).toEqual(["session:s3", "session:s2", "session:s1"]);
});

test(`at most ${QUICK_LIMIT} other outputs (URLs and files, newest first), then "+N more" for the Artifacts section`, () => {
  const outs = [artifact({ target: "./a.md" }), artifact({ target: "https://example.com/b" }), artifact({ target: "./c.png" }), artifact({ target: "./d" }), artifact({ target: "./e" })];
  const chips = quickLinks({ outputs: outs, sessions: [] });
  expect(kinds(chips)).toEqual([`output:${outs[0].id}`, `output:${outs[1].id}`, `output:${outs[2].id}`, "more:artifacts:2"]);
  expect(chips[1]).toMatchObject({ kind: "output", file: false });
  expect(chips[0]).toMatchObject({ kind: "output", file: true });
  // Exactly the limit: no "+N more".
  expect(kinds(quickLinks({ outputs: outs.slice(0, 3), sessions: [] })).some((k) => k.startsWith("more"))).toBe(false);
});

test("a full card: PR, sessions with a waiting one, outputs past the limit", () => {
  const pr = artifact({ target: "https://github.com/o/r/pull/88" });
  const outs = [artifact({ target: "./1" }), pr, artifact({ target: "./2" }), artifact({ target: "./3" }), artifact({ target: "./4" })];
  const chips = quickLinks({
    outputs: outs,
    sessions: [session("a", 1, "running"), session("b", 2, "waiting", "Review")],
    prStatus: new Map([[pr.id, "Draft"]]),
  });
  expect(kinds(chips)).toEqual([`pr:${pr.id}`, "session:b", "session:a", `output:${outs[0].id}`, `output:${outs[2].id}`, `output:${outs[3].id}`, "more:artifacts:1"]);
  expect(chips[0]).toMatchObject({ state: "draft" });
  expect(chips[1]).toMatchObject({ state: "waiting", title: "Review" });
});
