import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { detectCommands, detectProjectCommands } from "./review-detect";

const roots: string[] = [];
afterAll(() => Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }))));

test("a pnpm TS project: typecheck, lint and test ticked, build unticked, test:watch left out (§13.2)", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowly-detect-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run", build: "vite build", "test:watch": "vitest" } }));
  await writeFile(join(root, "pnpm-lock.yaml"), "");
  const commands = await detectProjectCommands(root);
  expect(commands).toEqual([
    { name: "Typecheck", argv: ["pnpm", "run", "typecheck"], checked: true },
    { name: "Lint", argv: ["pnpm", "run", "lint"], checked: true },
    { name: "Tests", argv: ["pnpm", "run", "test"], checked: true },
    { name: "Build", argv: ["pnpm", "run", "build"], checked: false },
  ]);
});

test("package manager by lockfile, other ecosystems, Makefile targets, at most 6", () => {
  const pkg = JSON.stringify({ scripts: { test: "jest", "e2e:run": "playwright test" } });
  expect(detectCommands({ packageJson: pkg, lockfiles: ["yarn.lock"], cargo: false, goMod: false }).map((c) => [c.argv.join(" "), c.checked])).toEqual([
    ["yarn run test", true],
    ["yarn run e2e:run", false],
  ]);
  expect(detectCommands({ packageJson: pkg, lockfiles: ["bun.lock"], cargo: false, goMod: false })[0]!.argv[0]).toBe("bun");
  expect(detectCommands({ packageJson: pkg, lockfiles: [], cargo: false, goMod: false })[0]!.argv[0]).toBe("npm");
  expect(detectCommands({ lockfiles: [], cargo: true, goMod: false })).toEqual([{ name: "Cargo test", argv: ["cargo", "test"], checked: true }]);
  expect(detectCommands({ lockfiles: [], cargo: false, goMod: true }).map((c) => c.argv.join(" "))).toEqual(["go vet ./...", "go test ./..."]);
  expect(detectCommands({ lockfiles: [], cargo: false, goMod: false, pythonConfig: "[tool.pytest.ini_options]" })[0]!.argv).toEqual(["python", "-m", "pytest"]);
  expect(detectCommands({ lockfiles: [], cargo: false, goMod: false, pythonConfig: "[tool.black]" })).toEqual([]);
  expect(detectCommands({ lockfiles: [], cargo: false, goMod: false, makefile: "build:\n\tx\ntest: build\n\tgo test\ncheck:\n" }).map((c) => c.argv.join(" "))).toEqual(["make test", "make check"]);
  const all = detectCommands({ packageJson: JSON.stringify({ scripts: { typecheck: "x", lint: "x", test: "x", build: "x" } }), lockfiles: [], cargo: true, goMod: true, makefile: "lint:\n" });
  expect(all).toHaveLength(6);
  // Broken package.json: nothing from it, no throw.
  expect(detectCommands({ packageJson: "{", lockfiles: [], cargo: false, goMod: false })).toEqual([]);
});
