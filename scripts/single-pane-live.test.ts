import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dispatcherStates } from "../shared/dispatcher";

// The live script lives in docs/verification (outside typecheck and `npm test`); this tests only what needs no daemon:
// the argument parsing, the check list and `--help`.
const scriptPath = fileURLToPath(new URL("../docs/verification/single-pane-live.mjs", import.meta.url));
type Script = {
  parseArgs: (argv: string[]) => { help: boolean; only: Set<number> | null; ids: string | null; backlog: string | null; useExistingDispatcher: boolean; keepDispatcher: boolean; yesArchiveDispatcher: boolean; cleanup: string | null; home: string };
  helpText: () => string;
  CHECKS: { id: number; title: string; needs: string[]; needsFinalFix?: string }[];
  UsageError: new (message: string) => Error;
  RecordError: new (problems: string[]) => Error & { problems: string[] };
  runIdPattern: RegExp;
  fixtureDirPrefix: string;
  runDirMarker: string;
  signalExitCodes: Record<string, number>;
  isFixtureDir: (dir: unknown, tmp?: string) => boolean;
  ownBranchPattern: (runId: string) => RegExp;
  branchCheckedOut: (porcelain: string, branch: string, exists?: (p: string) => boolean) => boolean;
  validateRecord: (data: unknown, file: string, opts?: { tmp?: string }) => Record<string, unknown>;
  decideDispatcher: (status: { agentId: string | null; state: string }, useExisting: boolean) => { action: "start" | "use" | "skip"; reason?: string };
  retryCommand: (file: string, args: { home?: string; keepDispatcher?: boolean }, defaultHome?: string) => string;
  cleanup: (ctx: unknown, opts: { keepDispatcher: boolean; unattended?: boolean; yesArchiveDispatcher?: boolean }) => Promise<{ problems: string[]; done: string[] }>;
  dispatcherArchivePlan: (o: { ours: boolean; keep: boolean; unattended: boolean; yes: boolean }) => "archive" | "keep" | "hold";
  memoryUnavailable: (result: { view?: { enabled?: boolean } | null; error?: unknown }) => string | null;
  createReport: (log: (line: string) => void, retry: string) => (result: { problems: string[]; done: string[] }) => boolean;
  interruptNotice: (retry: string) => string[];
};

/** A fake of the script's context for `cleanup`, over an in-memory board and agent list; records every write. */
type FakeTask = { id: string; title: string; projectId: string; workspaceId: string; revision: number };
type FakeAgent = { id: string; labels: Record<string, string>; workspaceId: string; status: string; archivedAt?: string; createdAt?: string };
function fakeContext(opts: {
  data: Record<string, unknown>;
  tasks: FakeTask[];
  projects?: { id: string; title: string; primaryPath: string; revision: number }[];
  agents?: FakeAgent[];
  memory?: Record<string, { id: string; projectId: string; title: string; revision: number }[]>;
  file?: string;
}) {
  const calls: { archived: string[]; cancelled: string[]; rpc: [string, unknown][] } = { archived: [], cancelled: [], rpc: [] };
  const board = { tasks: opts.tasks, projects: opts.projects ?? [{ id: "tl", title: "Tinylink", primaryPath: "/x/tinylink", revision: 1 }] };
  const agents = opts.agents ?? [];
  const ctx = {
    rec: { data: opts.data, file: opts.file ?? `/x/single-pane-live-${RUN}.json`, card: () => {} },
    client: {
      archiveAgent: async (id: string) => {
        calls.archived.push(id);
        const a = agents.find((x) => x.id === id);
        if (a) a.archivedAt = "now";
      },
      cancelAgent: async (id: string) => void calls.cancelled.push(id),
    },
    rpc: async (method: string, input: Record<string, unknown>) => {
      calls.rpc.push([method, input]);
      if (method === "memory.read") return { value: { enabled: true, entries: opts.memory?.[String(input.projectId)] ?? [] } };
      if (method === "tasks.delete") {
        board.tasks = board.tasks.filter((t) => t.id !== input.id);
        return {};
      }
      if (method === "projects.remove") {
        board.projects = board.projects.filter((p) => p.id !== input.id);
        return { paseo: { removed: true } };
      }
      return {};
    },
    board: async () => ({ tasks: board.tasks, projects: board.projects }),
    agents: async () => agents,
    agent: async (id: string) => agents.find((a) => a.id === id) ?? null,
    workspaces: async () => [],
    needTinylink: async () => ({ id: "tl", title: "Tinylink", root: "/x/tinylink" }),
    noteBranch: async () => {},
  };
  return { ctx, calls, deletes: () => calls.rpc.filter(([m]) => m === "tasks.delete" || m === "memory.delete" || m === "projects.remove").map(([m]) => m) };
}
const marker = "[single-pane-live a1b2c3]"; // RUN's marker (RUN is declared further down)
const baseData = (over: Record<string, unknown> = {}) => ({
  runId: RUN,
  marker,
  tinylinkProjectId: "tl",
  cards: [{ id: "c1", title: `${marker} card`, projectId: "tl", workspaces: ["w1"], branches: [] }],
  agents: ["s1"],
  tmpDirs: [],
  fixtureProjects: [],
  memory: [],
  dispatcher: null,
  ...over,
});
const realSession = (over: Partial<FakeAgent> = {}): FakeAgent => ({ id: "s1", labels: { "flowly-task": "c1" }, workspaceId: "w1", status: "idle", ...over });
const TMP = "/var/fake-tmp";
const RUN = "a1b2c3";
const goodRecord = () => ({
  runId: RUN,
  marker: `[single-pane-live ${RUN}]`,
  tinylinkProjectId: null as string | null,
  cards: [{ id: "c1", title: `[single-pane-live ${RUN}] card`, projectId: "p1", workspaces: ["w1"], branches: [`kanban/single-pane-live-${RUN}-card-abc123`] }] as Record<string, unknown>[],
  agents: ["a1"] as unknown[],
  tmpDirs: [`${TMP}/single-pane-live-fixture-xyz`] as unknown[],
  fixtureProjects: [{ path: `${TMP}/single-pane-live-fixture-xyz`, id: "fp1" }] as Record<string, unknown>[],
  memory: [{ projectId: "fp1", id: "m1" }],
  dispatcher: { agentId: "d1", prior: null, ours: true } as unknown,
});
const goodFile = `/anywhere/single-pane-live-${RUN}.json`;
const load = async () => (await import(/* @vite-ignore */ scriptPath)) as Script;

describe("single-pane live script", () => {
  it("lists checks 1 to 7 once each, in order", async () => {
    const { CHECKS } = await load();
    expect(CHECKS.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const c of CHECKS) expect(c.title.length).toBeGreaterThan(10);
  });

  it("defaults to every check, no existing-dispatcher use and archiving its own dispatcher", async () => {
    const { parseArgs } = await load();
    const args = parseArgs([]);
    expect(args).toMatchObject({ help: false, only: null, ids: null, backlog: null, useExistingDispatcher: false, keepDispatcher: false, cleanup: null });
  });

  it("reads --only as a set of known check numbers", async () => {
    const { parseArgs } = await load();
    expect([...parseArgs(["--only", "1, 3,7"]).only!].sort()).toEqual([1, 3, 7]);
  });

  it("reads the option flags and values", async () => {
    const { parseArgs } = await load();
    const args = parseArgs(["--ids", "/x/ids.json", "--backlog", "/x/b.md", "--use-existing-dispatcher", "--keep-dispatcher", "--cleanup", "/tmp/r.json", "--home", "/h", "--help"]);
    expect(args).toMatchObject({ ids: "/x/ids.json", backlog: "/x/b.md", useExistingDispatcher: true, keepDispatcher: true, cleanup: "/tmp/r.json", home: "/h", help: true });
  });

  it("refuses unknown checks, unknown options and missing values", async () => {
    const { parseArgs, UsageError } = await load();
    for (const argv of [["--only", "8"], ["--only", "x"], ["--only"], ["--only", "--help"], ["--nope"], ["--ids"], ["1"]]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(UsageError);
    }
  });

  it("marks the checks that need the final fix round in the help text", async () => {
    const { helpText, CHECKS } = await load();
    const text = helpText();
    for (const c of CHECKS) expect(text).toContain(`${c.id}. ${c.title}`);
    const marked = CHECKS.filter((c) => c.needsFinalFix);
    expect(marked.map((c) => c.id)).toEqual([1]);
    expect(text).toContain("needs the final fix round");
  });

  describe("--cleanup record validation", () => {
    it("accepts a sound record", async () => {
      const { validateRecord } = await load();
      expect(() => validateRecord(goodRecord(), goodFile, { tmp: TMP })).not.toThrow();
    });

    it("refuses a bad runId, a mismatched marker or a mismatched file name", async () => {
      const { validateRecord, RecordError, runIdPattern } = await load();
      expect(runIdPattern.test("a1b2c3")).toBe(true);
      for (const bad of ["A1B2C3", "a1b2c", "a1b2c3d", "../../x", "zzzzzz"]) {
        const r = { ...goodRecord(), runId: bad, marker: `[single-pane-live ${bad}]` };
        expect(() => validateRecord(r, `/x/single-pane-live-${bad}.json`, { tmp: TMP }), bad).toThrow(RecordError);
      }
      expect(() => validateRecord({ ...goodRecord(), marker: "[single-pane-live ffffff]" }, goodFile, { tmp: TMP })).toThrow(/marker/);
      expect(() => validateRecord(goodRecord(), "/x/single-pane-live-ffffff.json", { tmp: TMP })).toThrow(/file name/);
      expect(() => validateRecord(null, goodFile, { tmp: TMP })).toThrow(RecordError);
      expect(() => validateRecord([], goodFile, { tmp: TMP })).toThrow(RecordError);
    });

    it("refuses fixture directories that are the temp dir, outside it, nested, or without the prefix", async () => {
      const { validateRecord } = await load();
      for (const dir of [TMP, "/", "/Users/noah", `${TMP}/other`, `${TMP}/single-pane-live-fixture-x/nested`, `${TMP}/../etc/single-pane-live-fixture-x`, `/elsewhere/single-pane-live-fixture-x`, ""]) {
        const r = { ...goodRecord(), tmpDirs: [dir], fixtureProjects: [] };
        expect(() => validateRecord(r, goodFile, { tmp: TMP }), JSON.stringify(dir)).toThrow(/tmpDirs/);
      }
    });

    it("refuses a fixture project whose path is not a recorded fixture directory", async () => {
      const { validateRecord } = await load();
      const r = { ...goodRecord(), fixtureProjects: [{ path: "/Users/noah/Developer/personal/flowly-test/tinylink", id: "fp1" }] };
      expect(() => validateRecord(r, goodFile, { tmp: TMP })).toThrow(/not one of the recorded fixture directories/);
    });

    it("refuses a card without the run's marker in its title, and malformed entries", async () => {
      const { validateRecord } = await load();
      const noMarker = goodRecord();
      noMarker.cards[0].title = "Real card";
      expect(() => validateRecord(noMarker, goodFile, { tmp: TMP })).toThrow(/marker in its title/);
      const wrongRun = goodRecord();
      wrongRun.cards[0].title = "[single-pane-live ffffff] card";
      expect(() => validateRecord(wrongRun, goodFile, { tmp: TMP })).toThrow(/marker in its title/);
      expect(() => validateRecord({ ...goodRecord(), agents: [1] }, goodFile, { tmp: TMP })).toThrow(/agents/);
      expect(() => validateRecord({ ...goodRecord(), dispatcher: { agentId: 5 } }, goodFile, { tmp: TMP })).toThrow(/dispatcher/);
      expect(() => validateRecord({ ...goodRecord(), cards: [{ id: "c1" }] }, goodFile, { tmp: TMP })).toThrow(/malformed/);
    });

    it("lists every problem in one refusal", async () => {
      const { validateRecord, RecordError } = await load();
      const r = { ...goodRecord(), marker: "x", tmpDirs: ["/"], fixtureProjects: [] };
      try {
        validateRecord(r, goodFile, { tmp: TMP });
        throw new Error("did not throw");
      } catch (e) {
        expect(e).toBeInstanceOf(RecordError);
        expect((e as { problems: string[] }).problems.length).toBeGreaterThanOrEqual(3);
      }
    });

    it("never carries a tinylinkRoot: it is not in the validated shape", async () => {
      const { validateRecord } = await load();
      const data = validateRecord({ ...goodRecord(), tinylinkProjectId: "tl-1" }, goodFile, { tmp: TMP });
      expect(data).not.toHaveProperty("tinylinkRoot");
    });
  });

  describe("fixture directory guard", () => {
    it("accepts only direct children of the temp dir with the prefix", async () => {
      const { isFixtureDir, fixtureDirPrefix } = await load();
      expect(isFixtureDir(`${TMP}/${fixtureDirPrefix}1`, TMP)).toBe(true);
      expect(isFixtureDir(`${TMP}/${fixtureDirPrefix}1/`, TMP)).toBe(true);
      for (const d of [TMP, `${TMP}/x`, `${TMP}/${fixtureDirPrefix}1/sub`, `/${fixtureDirPrefix}1`, undefined, 7, null]) expect(isFixtureDir(d, TMP), String(d)).toBe(false);
    });
  });

  describe("branch guard", () => {
    it("matches only branches generated from this run's marker", async () => {
      const { ownBranchPattern } = await load();
      const re = ownBranchPattern(RUN);
      expect(re.test(`kanban/single-pane-live-${RUN}-two-things-abc123`)).toBe(true);
      for (const b of ["kanban/fix-login-abc123", "main", `kanban/single-pane-live-ffffff-x-abc123`, `kanban/single-pane-live-${RUN}`, `feature/single-pane-live-${RUN}-x`, `xkanban/single-pane-live-${RUN}-x`]) expect(re.test(b), b).toBe(false);
    });

    it("counts a branch as checked out only while its worktree directory exists", async () => {
      const { branchCheckedOut } = await load();
      const porcelain = ["worktree /repo", "HEAD aaa", "branch refs/heads/main", "", "worktree /gone/wt", "HEAD bbb", "branch refs/heads/kanban/x-1", "", "worktree /live/wt", "HEAD ccc", "branch refs/heads/kanban/y-2", ""].join("\n");
      const exists = (p: string) => p !== "/gone/wt";
      expect(branchCheckedOut(porcelain, "kanban/x-1", exists)).toBe(false); // stale entry: prune would drop it
      expect(branchCheckedOut(porcelain, "kanban/y-2", exists)).toBe(true);
      expect(branchCheckedOut(porcelain, "main", exists)).toBe(true);
      expect(branchCheckedOut(porcelain, "kanban/none", exists)).toBe(false);
    });
  });

  describe("dispatcher the user already has", () => {
    it("starts its own only when there is no dispatcher record at all", async () => {
      const { decideDispatcher } = await load();
      expect(decideDispatcher({ agentId: null, state: "none" }, false)).toEqual({ action: "start" });
      expect(decideDispatcher({ agentId: null, state: "none" }, true)).toEqual({ action: "start" });
    });

    it("skips for a running, idle or ended dispatcher without the flag, naming the flag and the consequence", async () => {
      const { decideDispatcher } = await load();
      for (const state of ["running", "idle", "ended"]) {
        const d = decideDispatcher({ agentId: "d1", state }, false);
        expect(d.action, state).toBe("skip");
        expect(d.reason).toContain("--use-existing-dispatcher");
        expect(d.reason).toContain("real dispatcher");
      }
      expect(decideDispatcher({ agentId: "d1", state: "ended" }, false).reason).toContain("archives that ended session");
      expect(decideDispatcher({ agentId: null, state: "ended" }, false).action).toBe("skip");
    });

    it("with the flag uses a live dispatcher and replaces an ended one", async () => {
      const { decideDispatcher } = await load();
      expect(decideDispatcher({ agentId: "d1", state: "idle" }, true).action).toBe("use");
      expect(decideDispatcher({ agentId: "d1", state: "running" }, true).action).toBe("use");
      expect(decideDispatcher({ agentId: "d1", state: "ended" }, true).action).toBe("start");
    });
  });

  describe("cleanup acts on the live board, not on the record", () => {
    const liveTask = (over: Partial<FakeTask> = {}): FakeTask => ({ id: "c1", title: `${marker} card`, projectId: "tl", workspaceId: "w1", revision: 1, ...over });

    it("archives nothing for a forged record that pairs a real card id with a marked title and a real session", async () => {
      const { cleanup } = await load();
      // The record claims card c1 carries the marker; on the board c1 is a real card without it.
      const fake = fakeContext({ data: baseData(), tasks: [liveTask({ title: "Real card" })], agents: [realSession()] });
      const { problems } = await cleanup(fake.ctx, { keepDispatcher: false });
      expect(fake.calls.archived).toEqual([]);
      expect(fake.calls.cancelled).toEqual([]);
      expect(fake.deletes()).toEqual([]);
      expect(problems.join("\n")).toContain("left in place");
    });

    it("archives nothing when the marked card sits outside Tinylink and the fixture projects", async () => {
      const { cleanup } = await load();
      const fake = fakeContext({ data: baseData(), tasks: [liveTask({ projectId: "other" })], agents: [realSession()], projects: [{ id: "tl", title: "Tinylink", primaryPath: "/x/tinylink", revision: 1 }, { id: "other", title: "Real project", primaryPath: "/x/other", revision: 1 }] });
      await cleanup(fake.ctx, { keepDispatcher: false });
      expect(fake.calls.archived).toEqual([]);
      expect(fake.deletes()).toEqual([]);
    });

    it("archives a session through the card label and deletes the card when the live card carries the marker in Tinylink", async () => {
      const { cleanup } = await load();
      const fake = fakeContext({ data: baseData(), tasks: [liveTask()], agents: [realSession()] });
      const { problems } = await cleanup(fake.ctx, { keepDispatcher: false });
      expect(fake.calls.archived).toEqual(["s1"]);
      expect(fake.deletes()).toEqual(["tasks.delete"]);
      expect(problems).toEqual([]);
    });

    it("finds a session by its card label in the card's workspace only for live marked cards", async () => {
      const { cleanup } = await load();
      const other = realSession({ id: "s2", labels: { "flowly-task": "c9" }, workspaceId: "w1" });
      const fake = fakeContext({ data: baseData({ agents: [] }), tasks: [liveTask(), liveTask({ id: "c9", title: "Real card" })], agents: [other] });
      await cleanup(fake.ctx, { keepDispatcher: false });
      expect(fake.calls.archived).toEqual([]);
    });
  });

  describe("memory cleanup", () => {
    const fixtureDir = () => join(tmpdir(), "single-pane-live-fixture-memtest");
    const withFixture = (memory: Record<string, unknown>[], entries: Record<string, { id: string; projectId: string; title: string; revision: number }[]>) =>
      fakeContext({
        data: baseData({ cards: [], agents: [], tmpDirs: [fixtureDir()], fixtureProjects: [{ path: fixtureDir(), id: "fp" }], memory }),
        tasks: [],
        projects: [{ id: "tl", title: "Tinylink", primaryPath: "/x/tinylink", revision: 1 }, { id: "fp", title: `${marker} fixture`, primaryPath: fixtureDir(), revision: 1 }],
        memory: entries,
      });

    it("refuses an entry whose project is not a validated fixture project (Tinylink's memory is never deleted)", async () => {
      const { cleanup } = await load();
      const fake = withFixture([{ projectId: "tl", id: "m1" }], { tl: [{ id: "m1", projectId: "tl", title: `${marker} memory`, revision: 3 }] });
      const { problems } = await cleanup(fake.ctx, { keepDispatcher: false });
      expect(fake.calls.rpc.some(([m]) => m === "memory.delete")).toBe(false);
      expect(problems.join("\n")).toMatch(/delete memory m1: .*not a validated fixture project/);
    });

    it("refuses an entry in the fixture project that does not carry the marker in its title", async () => {
      const { cleanup } = await load();
      const fake = withFixture([{ projectId: "fp", id: "m1" }], { fp: [{ id: "m1", projectId: "fp", title: "Real memory", revision: 3 }] });
      await cleanup(fake.ctx, { keepDispatcher: false });
      expect(fake.calls.rpc.some(([m]) => m === "memory.delete")).toBe(false);
    });

    it("deletes the script's own entry in the fixture project, reading it first for its revision", async () => {
      const { cleanup } = await load();
      const fake = withFixture([{ projectId: "fp", id: "m1" }], { fp: [{ id: "m1", projectId: "fp", title: `${marker} export memory`, revision: 3 }] });
      await cleanup(fake.ctx, { keepDispatcher: false });
      const calls = fake.calls.rpc.map(([m]) => m);
      expect(calls.indexOf("memory.read")).toBeLessThan(calls.indexOf("memory.delete"));
      expect(fake.calls.rpc.find(([m]) => m === "memory.delete")?.[1]).toEqual({ id: "m1", revision: 3 });
    });

    it("skips check 6 when memory is off or memory.read throws", async () => {
      const { memoryUnavailable } = await load();
      expect(memoryUnavailable({ view: { enabled: false } })).toMatch(/memory/i);
      expect(memoryUnavailable({ error: new Error("Project not found.") })).toMatch(/memory/i);
      expect(memoryUnavailable({ view: null })).toMatch(/memory/i);
      expect(memoryUnavailable({ view: { enabled: true } })).toBeNull();
    });
  });

  describe("run labels and fixture directories", () => {
    it("archives a session the script started only when it carries this run's id", async () => {
      const { cleanup } = await load();
      const own = { id: "s1", labels: { "flowly-started-by": "single-pane-live", "single-pane-live-run": RUN }, workspaceId: "wx", status: "idle" };
      const older = { id: "s2", labels: { "flowly-started-by": "single-pane-live", "single-pane-live-run": "ffffff" }, workspaceId: "wx", status: "idle" };
      const unlabelled = { id: "s3", labels: { "flowly-started-by": "single-pane-live" }, workspaceId: "wx", status: "idle" };
      const fake = fakeContext({ data: baseData({ cards: [], agents: ["s1", "s2", "s3"] }), tasks: [], agents: [own, older, unlabelled] });
      const { problems } = await cleanup(fake.ctx, { keepDispatcher: false });
      expect(fake.calls.archived).toEqual(["s1"]);
      expect(problems.join("\n")).toMatch(/s2: left in place/);
      expect(problems.join("\n")).toMatch(/s3: left in place/);
    });

    it("removes its fixture projects' temp directories and its own unregistered one, never another", async () => {
      const { cleanup, fixtureDirPrefix, runDirMarker } = await load();
      const tied = mkdtempSync(join(tmpdir(), fixtureDirPrefix));
      // The run failed between recording the directory and registering its project: the run's marker file says it is ours.
      const ours = mkdtempSync(join(tmpdir(), fixtureDirPrefix));
      writeFileSync(join(ours, runDirMarker), RUN);
      const other = mkdtempSync(join(tmpdir(), fixtureDirPrefix));
      writeFileSync(join(other, runDirMarker), "ffffff");
      const loose = mkdtempSync(join(tmpdir(), fixtureDirPrefix));
      try {
        const fake = fakeContext({ data: baseData({ cards: [], agents: [], tmpDirs: [tied, ours, other, loose], fixtureProjects: [{ path: tied, id: "fp" }] }), tasks: [] });
        const { done } = await cleanup(fake.ctx, { keepDispatcher: false });
        expect(existsSync(tied)).toBe(false);
        expect(existsSync(ours)).toBe(false);
        expect(existsSync(other)).toBe(true);
        expect(existsSync(loose)).toBe(true);
        expect(done.join("\n")).toContain(`left in place: ${loose}`);
        expect(done.join("\n")).toContain(`left in place: ${other}`);
      } finally {
        for (const dir of [tied, ours, other, loose]) rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("the dispatcher in --cleanup mode", () => {
    const startedAt = "2026-11-09T10:00:00.000Z";
    const withDispatcher = (createdAt = "2026-11-09T10:05:00.000Z", data: Record<string, unknown> = { startedAt }) =>
      fakeContext({
        data: baseData({ cards: [], agents: ["d1"], dispatcher: { agentId: "d1", prior: null, ours: true }, ...data }),
        tasks: [],
        agents: [{ id: "d1", labels: { "flowly-dispatcher": "1" }, workspaceId: "dw", status: "idle", createdAt }],
      });

    it("never archives a dispatcher created before the run started, or when the record has no start time", async () => {
      const { cleanup } = await load();
      const older = withDispatcher("2026-11-09T09:00:00.000Z");
      const { done } = await cleanup(older.ctx, { keepDispatcher: false, unattended: true, yesArchiveDispatcher: true });
      expect(older.calls.archived).toEqual([]);
      expect(done.join("\n")).toMatch(/left in place: dispatcher d1.*before this run started/);
      const undated = withDispatcher(undefined, {});
      await cleanup(undated.ctx, { keepDispatcher: false });
      expect(undated.calls.archived).toEqual([]);
      // Its creation time cannot be read: treated as not this run's.
      const unread = withDispatcher();
      const read = unread.ctx.agent;
      let first = true;
      unread.ctx.agent = async (id: string) => {
        if (id === "d1" && first) {
          first = false;
          throw new Error("socket closed");
        }
        return read(id);
      };
      const result = await cleanup(unread.ctx, { keepDispatcher: false });
      expect(unread.calls.archived).toEqual([]);
      expect(result.done.join("\n")).toMatch(/left in place: dispatcher d1.*could not be read/);
    });

    it("leaves it in place and lists it unless --yes-archive-dispatcher is given", async () => {
      const { cleanup } = await load();
      const fake = withDispatcher();
      const { done } = await cleanup(fake.ctx, { keepDispatcher: false, unattended: true });
      expect(fake.calls.archived).toEqual([]);
      expect(done.join("\n")).toMatch(/left in place: dispatcher d1.*--yes-archive-dispatcher/);
    });

    it("archives it with the flag, and in a normal run", async () => {
      const { cleanup } = await load();
      const flagged = withDispatcher();
      await cleanup(flagged.ctx, { keepDispatcher: false, unattended: true, yesArchiveDispatcher: true });
      expect(flagged.calls.archived).toEqual(["d1"]);
      const normal = withDispatcher();
      await cleanup(normal.ctx, { keepDispatcher: false });
      expect(normal.calls.archived).toEqual(["d1"]);
    });

    it("plans archive, keep or hold", async () => {
      const { dispatcherArchivePlan } = await load();
      expect(dispatcherArchivePlan({ ours: true, keep: false, unattended: false, yes: false })).toBe("archive");
      expect(dispatcherArchivePlan({ ours: true, keep: false, unattended: true, yes: false })).toBe("hold");
      expect(dispatcherArchivePlan({ ours: true, keep: false, unattended: true, yes: true })).toBe("archive");
      expect(dispatcherArchivePlan({ ours: true, keep: true, unattended: true, yes: true })).toBe("keep");
      expect(dispatcherArchivePlan({ ours: false, keep: false, unattended: false, yes: true })).toBe("keep");
    });

    it("reads --yes-archive-dispatcher", async () => {
      const { parseArgs } = await load();
      expect(parseArgs([]).yesArchiveDispatcher).toBe(false);
      expect(parseArgs(["--cleanup", "/x.json", "--yes-archive-dispatcher"]).yesArchiveDispatcher).toBe(true);
    });
  });

  describe("dispatcher states", () => {
    it("handles every state the daemon reports (shared/dispatcher.ts dispatcherStates)", async () => {
      const { decideDispatcher } = await load();
      for (const state of dispatcherStates) {
        if (state === "none") {
          expect(decideDispatcher({ agentId: null, state }, false).action).toBe("start");
          continue;
        }
        const without = decideDispatcher({ agentId: "d1", state }, false);
        expect(without.action, state).toBe("skip");
        expect(without.reason).toContain("--use-existing-dispatcher");
        // server/dispatcher.ts run(): only an ended (dead) session may be replaced; a live one is messaged.
        expect(decideDispatcher({ agentId: "d1", state }, true).action, state).toBe(state === "ended" ? "start" : "use");
      }
    });

    it("mentions archiving the old session only for an ended dispatcher", async () => {
      const { decideDispatcher } = await load();
      expect(decideDispatcher({ agentId: "d1", state: "ended" }, false).reason).toContain("archives that ended session");
      for (const state of ["running", "idle"]) expect(decideDispatcher({ agentId: "d1", state }, false).reason, state).not.toContain("archives that ended session");
    });
  });

  describe("interruption reporting", () => {
    it("prints the cleanup report only once", async () => {
      const { createReport } = await load();
      const lines: string[] = [];
      const report = createReport((l) => lines.push(l), "node x --cleanup /r.json");
      expect(report({ problems: [], done: ["archived session s1"] })).toBe(true);
      const count = lines.length;
      expect(count).toBeGreaterThan(0);
      expect(report({ problems: ["late"], done: ["again"] })).toBe(false);
      expect(lines.length).toBe(count);
      expect(lines.join("\n")).not.toContain("late");
    });

    it("says a blocked check may still have created things, and gives the retry command", async () => {
      const { interruptNotice } = await load();
      const text = interruptNotice("node docs/verification/single-pane-live.mjs --cleanup /r.json").join("\n");
      expect(text).toContain("long RPC");
      expect(text).toContain("--yes-archive-dispatcher");
      expect(text).toContain("node docs/verification/single-pane-live.mjs --cleanup /r.json");
    });
  });

  describe("interruption", () => {
    it("exits 130 after SIGINT and 143 after SIGTERM", async () => {
      const { signalExitCodes } = await load();
      expect(signalExitCodes).toEqual({ SIGINT: 130, SIGTERM: 143 });
    });

    it("prints the exact retry command, with --home only when it is not the default", async () => {
      const { retryCommand } = await load();
      expect(retryCommand("/tmp/single-pane-live-a1b2c3.json", { home: "/h/.paseo" }, "/h/.paseo")).toBe("node docs/verification/single-pane-live.mjs --cleanup /tmp/single-pane-live-a1b2c3.json");
      expect(retryCommand("/tmp/single-pane-live-a1b2c3.json", { home: "/other" }, "/h/.paseo")).toBe("node docs/verification/single-pane-live.mjs --cleanup /tmp/single-pane-live-a1b2c3.json --home /other");
      expect(retryCommand("/tmp/a b/x.json", { home: "/h/.paseo", keepDispatcher: true }, "/h/.paseo")).toBe("node docs/verification/single-pane-live.mjs --cleanup '/tmp/a b/x.json' --keep-dispatcher");
    });

    it("refuses a bad --cleanup record with exit 1 before connecting", () => {
      let status = 0;
      let stderr = "";
      try {
        execFileSync(process.execPath, [scriptPath, "--cleanup", "/nonexistent/single-pane-live-a1b2c3.json"], { encoding: "utf8", stdio: "pipe", env: { ...process.env, FLOWLY_TELEMETRY: "0" } });
      } catch (e) {
        const err = e as { status: number; stderr: string };
        status = err.status;
        stderr = err.stderr;
      }
      expect(status).toBe(1);
      expect(stderr).toContain("Refusing to clean up from this record");
    });
  });

  it("prints the checks for --help and exits 0 without a daemon", () => {
    const out = execFileSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8", env: { ...process.env, FLOWLY_TELEMETRY: "0" } });
    expect(out).toContain("Usage:");
    for (let id = 1; id <= 7; id++) expect(out).toContain(`  ${id}. `);
  });
});
