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
};
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

  it("prints the checks for --help and exits 0 without a daemon", () => {
    const out = execFileSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8", env: { ...process.env, FLOWLY_TELEMETRY: "0" } });
    expect(out).toContain("Usage:");
    for (let id = 1; id <= 7; id++) expect(out).toContain(`  ${id}. `);
  });
});
