import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The live script lives in docs/verification (outside typecheck and `npm test`); this tests only what needs no daemon:
// the argument parsing, the check list and `--help`.
const scriptPath = fileURLToPath(new URL("../docs/verification/single-pane-live.mjs", import.meta.url));
type Script = {
  parseArgs: (argv: string[]) => { help: boolean; only: Set<number> | null; ids: string | null; backlog: string | null; useExistingDispatcher: boolean; keepDispatcher: boolean; cleanup: string | null; home: string };
  helpText: () => string;
  CHECKS: { id: number; title: string; needs: string[]; needsFinalFix?: string }[];
  UsageError: new (message: string) => Error;
  RecordError: new (problems: string[]) => Error & { problems: string[] };
  runIdPattern: RegExp;
  fixtureDirPrefix: string;
  signalExitCodes: Record<string, number>;
  isFixtureDir: (dir: unknown, tmp?: string) => boolean;
  ownBranchPattern: (runId: string) => RegExp;
  branchCheckedOut: (porcelain: string, branch: string, exists?: (p: string) => boolean) => boolean;
  validateRecord: (data: unknown, file: string, opts?: { tmp?: string }) => Record<string, unknown>;
  decideDispatcher: (status: { agentId: string | null; state: string }, useExisting: boolean) => { action: "start" | "use" | "skip"; reason?: string };
  retryCommand: (file: string, args: { home?: string; keepDispatcher?: boolean }, defaultHome?: string) => string;
};
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
      for (const state of ["running", "idle", "ended", "context_full"]) {
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
