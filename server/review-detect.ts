import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

/** A check command found in the repository (AUTO-REVIEW-SPEC §6.1); `checked` is the default. */
export type DetectedCommand = { name: string; argv: string[]; checked: boolean };

/** What detection reads from the project root; never runs anything. */
export type RepoFiles = {
  packageJson?: string | null;
  lockfiles: readonly string[];
  cargo: boolean;
  goMod: boolean;
  pythonConfig?: string | null;
  makefile?: string | null;
};

const MAX = 6;
const scriptNames: Record<string, string> = { typecheck: "Typecheck", "type-check": "Typecheck", tsc: "Typecheck", lint: "Lint", test: "Tests" };

function packageManager(lockfiles: readonly string[]) {
  if (lockfiles.includes("pnpm-lock.yaml")) return "pnpm";
  if (lockfiles.includes("yarn.lock")) return "yarn";
  if (lockfiles.includes("bun.lockb") || lockfiles.includes("bun.lock")) return "bun";
  return "npm";
}

/** Deterministic detection from the files' content (§6.1): at most 6, scripts with "watch" skipped. */
export function detectCommands(files: RepoFiles): DetectedCommand[] {
  const out: DetectedCommand[] = [];
  let scripts: Record<string, unknown> = {};
  try {
    const parsed = files.packageJson ? (JSON.parse(files.packageJson) as { scripts?: unknown }) : null;
    if (parsed?.scripts && typeof parsed.scripts === "object") scripts = parsed.scripts as Record<string, unknown>;
  } catch {
    scripts = {};
  }
  const names = Object.keys(scripts).filter((n) => typeof scripts[n] === "string" && !/watch/i.test(n));
  const pm = packageManager(files.lockfiles);
  const run = (name: string) => [pm, "run", name];
  // One typecheck script, in this order of preference.
  const typecheck = ["typecheck", "type-check", "tsc"].find((n) => names.includes(n));
  if (typecheck) out.push({ name: scriptNames[typecheck], argv: run(typecheck), checked: true });
  for (const n of ["lint", "test"]) if (names.includes(n)) out.push({ name: scriptNames[n], argv: run(n), checked: true });
  if (files.cargo) out.push({ name: "Cargo test", argv: ["cargo", "test"], checked: true });
  if (files.goMod) out.push({ name: "Go vet", argv: ["go", "vet", "./..."], checked: true }, { name: "Go test", argv: ["go", "test", "./..."], checked: true });
  if (files.pythonConfig && /\bpytest\b/.test(files.pythonConfig)) out.push({ name: "Pytest", argv: ["python", "-m", "pytest"], checked: true });
  if (files.makefile)
    for (const target of ["test", "lint", "check"])
      if (new RegExp(`^${target}\\s*:`, "m").test(files.makefile) && !out.some((c) => c.argv.join(" ") === `make ${target}`)) out.push({ name: `make ${target}`, argv: ["make", target], checked: true });
  // Offered unticked: slow or environment-bound.
  if (names.includes("build")) out.push({ name: "Build", argv: run("build"), checked: false });
  for (const n of names.filter((x) => /e2e/i.test(x))) out.push({ name: n, argv: run(n), checked: false });
  return out.slice(0, MAX);
}

/** §4.5 weekly: a package script name on the whitelist (`test*`, `lint*`, `typecheck`, `type-check`, `tsc`, `check`, `vet`), never a watcher. */
export const whitelisted = (name: string) => !/watch/i.test(name) && (/^(test|lint)/i.test(name) || ["typecheck", "type-check", "tsc", "check", "vet"].includes(name));

/**
 * Every whitelisted check in the repository for the weekly re-detection (GUARDRAILS-SPEC §4.5): each matching package
 * script (`test:e2e` included) and the build-file checks of `detectCommands`, unlimited. Whether one joins is decided
 * by the usage evidence, not here.
 */
export function whitelistCommands(files: RepoFiles): DetectedCommand[] {
  let scripts: Record<string, unknown> = {};
  try {
    const parsed = files.packageJson ? (JSON.parse(files.packageJson) as { scripts?: unknown }) : null;
    if (parsed?.scripts && typeof parsed.scripts === "object") scripts = parsed.scripts as Record<string, unknown>;
  } catch {
    scripts = {};
  }
  const pm = packageManager(files.lockfiles);
  const out: DetectedCommand[] = Object.keys(scripts)
    .filter((n) => typeof scripts[n] === "string" && whitelisted(n))
    .map((n) => ({ name: scriptNames[n] ?? n, argv: [pm, "run", n], checked: true }));
  for (const c of detectCommands({ ...files, packageJson: null })) if (c.checked && !out.some((o) => o.argv.join(" ") === c.argv.join(" "))) out.push(c);
  return out;
}

/** Package script names and Makefile targets, to tell when a command's script is gone (§4.5); null when unreadable. */
export function scriptNamesOf(files: Pick<RepoFiles, "packageJson" | "makefile">): { scripts: Set<string> | null; targets: Set<string> | null } {
  let scripts: Set<string> | null = null;
  try {
    const parsed = files.packageJson ? (JSON.parse(files.packageJson) as { scripts?: unknown }) : null;
    if (parsed) scripts = new Set(parsed.scripts && typeof parsed.scripts === "object" ? Object.keys(parsed.scripts as object) : []);
  } catch {
    scripts = null;
  }
  const targets = files.makefile ? new Set([...files.makefile.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].map((m) => m[1])) : null;
  return { scripts, targets };
}

const text = (path: string) => readFile(path, "utf8").catch(() => null);
const exists = (path: string) => access(path).then(
  () => true,
  () => false,
);

/** Reads the project root's build files and detects (§6.1). */
export async function detectProjectCommands(root: string): Promise<DetectedCommand[]> {
  return detectCommands(await readRepoFiles(root));
}

/** The build files detection reads in the project root; never runs anything. */
export async function readRepoFiles(root: string): Promise<RepoFiles> {
  const locks = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"];
  const [packageJson, present, cargo, goMod, pyproject, pytestIni, setupCfg, makefile] = await Promise.all([
    text(join(root, "package.json")),
    Promise.all(locks.map((l) => exists(join(root, l)))),
    exists(join(root, "Cargo.toml")),
    exists(join(root, "go.mod")),
    text(join(root, "pyproject.toml")),
    exists(join(root, "pytest.ini")),
    text(join(root, "setup.cfg")),
    text(join(root, "Makefile")),
  ]);
  return {
    packageJson,
    lockfiles: locks.filter((_, i) => present[i]),
    cargo,
    goMod,
    pythonConfig: [pyproject, setupCfg, pytestIni ? "pytest" : ""].filter(Boolean).join("\n"),
    makefile,
  };
}
