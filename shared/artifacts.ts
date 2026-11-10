import { msg } from "./i18n";
import type { Artifact, ArtifactRole } from "./model";
import { itemLabel, itemTypeOf } from "./connectors";

/** Card artifacts: pure helpers shared by daemon, tools and client (CARD-ARTIFACTS-SPEC). */

export const isUrlTarget = (target: string) => /^https?:\/\//i.test(target.trim());

/** Whether `target` is a usable http(s) URL. */
export function validUrl(target: string) {
  try {
    const url = new URL(target.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname;
  } catch {
    return false;
  }
}

/** Last path segment of a file target ("./docs/a.md" → "a.md"). */
export const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/** The title used when none is given: the file name, or host + path of a link. */
export function defaultTitle(kind: Artifact["kind"], target: string) {
  if (kind === "file") return baseName(target).slice(0, 120);
  try {
    const url = new URL(target);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 120);
  } catch {
    return target.slice(0, 120);
  }
}

/** A stored file target resolved against the workspace directory ("./x" is relative to it). */
export function absoluteTarget(target: string, workspaceDirectory: string) {
  if (!target.startsWith("./")) return target;
  return `${workspaceDirectory.replace(/\/+$/, "")}/${target.slice(2)}`;
}

/** A card's artifacts, newest first, in display groups (outputs first, CARD-ARTIFACTS-SPEC §5.2). */
export const artifactGroups: readonly { role: ArtifactRole; title: string }[] = [
  { role: "output", title: msg("Outputs") },
  { role: "input", title: msg("Inputs") },
];
export function artifactsOf(list: readonly Artifact[], taskId: string) {
  return list.filter((a) => a.taskId === taskId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** "Input: <title>" for activity events. */
export const artifactNoteLine = (artifact: Pick<Artifact, "role" | "title">) =>
  `${artifact.role === "input" ? "Input" : "Output"}: ${artifact.title}`;

/** "- [user] Title: target — note"; the note is the user's word on how to use it, kept to one line. */
function contextLine(a: Pick<Artifact, "id" | "title" | "target" | "note" | "createdBy" | "external" | "origin">, unreadable: ReadonlySet<string>) {
  const note = a.note.replace(/\s+/g, " ").trim();
  // External links need a login: point the agent at the tool that reads them (CONNECTORS-SPEC §9).
  const label = a.external ? itemLabel(a.external.provider, itemTypeOf(a.external)) : "";
  const external = !a.external
    ? ""
    : unreadable.has(a.id)
      ? ` (${label}; its connection was removed in Flowly, so it can't be read: ask the user)`
      : ` (${label}; read it with flowly_read_external artifactId=${a.id})`;
  return `- [${a.origin ? "flowly" : a.createdBy === "human" ? "user" : "agent"}] ${a.title}${external}: ${a.target}${note ? ` — ${note.length > 200 ? `${note.slice(0, 199)}…` : note}` : ""}`;
}

/**
 * Context lines for a new session (CARD-ARTIFACTS-SPEC §4.2); at most `limit` per
 * role, the user's own first (`list` is newest first, and that order is kept within each source).
 */
export function artifactContextLines(list: readonly Artifact[], limit = 10, unreadable: ReadonlySet<string> = new Set()): string[] {
  return (
    [
      ["input", "Inputs:"],
      ["output", "Outputs so far:"],
    ] as const
  ).flatMap(([role, heading]) => {
    const own = list
      .filter((a) => a.role === role)
      .sort((a, b) => Number(a.createdBy !== "human") - Number(b.createdBy !== "human"));
    if (!own.length) return [];
    return [
      heading,
      ...own.slice(0, limit).map((a) => contextLine(a, unreadable)),
      ...(own.length > limit ? [`- …and ${own.length - limit} more`] : []),
    ];
  });
}
