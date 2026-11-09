import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// docs/promo/setup.mjs builds the Tinylink fixture against the running daemon; this tests only what needs no daemon.
const scriptPath = fileURLToPath(new URL("../docs/promo/setup.mjs", import.meta.url));
type Setup = { setupArgs: (argv: string[]) => { sessions: boolean; help: boolean } };
const load = async () => (await import(/* @vite-ignore */ scriptPath)) as Setup;

describe("Tinylink setup script", () => {
  it("starts the Haiku sessions by default and skips them with --no-sessions", async () => {
    const { setupArgs } = await load();
    expect(setupArgs([])).toEqual({ sessions: true, help: false });
    expect(setupArgs(["--no-sessions"])).toEqual({ sessions: false, help: false });
    expect(setupArgs(["--help"]).help).toBe(true);
    expect(() => setupArgs(["--bogus"])).toThrow(/--bogus/);
  });

  it("refuses an unknown option with exit 64 before connecting, and prints --help with exit 0", () => {
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [scriptPath, "--bogus"], { encoding: "utf8", stdio: "pipe", timeout: 20_000 });
    } catch (e) {
      ({ status, stderr } = e as { status: number; stderr: string });
    }
    expect(status).toBe(64);
    expect(stderr).toContain("--no-sessions");
    const out = execFileSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8", timeout: 20_000 });
    expect(out).toContain("--no-sessions");
  });

  it("runs as the main script through a symlinked path too (only --help: it prints and connects to nothing)", () => {
    // Node gives the main module its real path in import.meta.url while argv[1] keeps the link.
    const dir = mkdtempSync(join(tmpdir(), "promo-setup-link-"));
    try {
      const link = join(dir, "setup.mjs");
      symlinkSync(scriptPath, link);
      const out = execFileSync(process.execPath, [link, "--help"], { encoding: "utf8", timeout: 20_000 });
      expect(out).toContain("--no-sessions");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
