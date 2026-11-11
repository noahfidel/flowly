import type { Artifact, ArtifactPlan } from "./model";
import { baseName } from "./artifacts";

/** A card's plan (CARD-PLAN-SPEC): pure helpers shared by daemon, tools and client. */

export type PlanArtifact = Artifact & { plan: ArtifactPlan };

/** The card's plan artifact (the one artifact of the card with `plan`), or null (§1.1). */
export function planOf(artifacts: readonly Artifact[], taskId: string): PlanArtifact | null {
  return (artifacts.find((a) => a.taskId === taskId && a.plan) as PlanArtifact | undefined) ?? null;
}

/** Whether the plan is approved (a draft has `approvedAt: null`). */
export function planApproved(plan: Pick<Artifact, "plan"> | null | undefined): boolean {
  return !!plan?.plan?.approvedAt;
}

/** The artifacts without the plan, for the Inputs and Outputs lists (§2.1, §5.3). */
export function withoutPlan<T extends Pick<Artifact, "plan">>(list: readonly T[]): T[] {
  return list.filter((a) => !a.plan);
}

/** The session context line before Inputs (§5.3). */
export function planContextLine(plan: Pick<Artifact, "title" | "target" | "plan">) {
  return `Plan (${planApproved(plan) ? "approved" : "draft"}): ${plan.title}: ${plan.target}`;
}

/**
 * The permission mode of a new session once the normal defaults are resolved (§6): an explicit mode wins;
 * otherwise an approved plan turns a resolved `plan` mode into the provider's usual suggestion.
 */
export function suggestPlanAwareMode({
  resolved,
  explicit,
  approvedPlan,
  suggested,
}: {
  resolved: string;
  explicit?: string;
  approvedPlan: boolean;
  suggested: string;
}): string {
  if (explicit !== undefined) return explicit;
  return approvedPlan && resolved === "plan" ? suggested : resolved;
}

type Metadata = Record<string, unknown> | undefined;
const pathKeys: readonly (readonly ["input" | "metadata", string])[] = [
  ["input", "planFilePath"],
  ["input", "plan_file_path"],
  ["input", "filePath"],
  ["input", "file_path"],
  ["metadata", "planFilePath"],
  ["metadata", "filePath"],
];

/** The plan text and file path of a plan-mode request (§4 step 1); `path` is the first non-empty string of the known keys. */
export function planRequestFacts(request: { input?: Metadata | null; metadata?: Metadata | null }): { text: string; path: string | null } {
  const text = typeof request.input?.plan === "string" ? request.input.plan : "";
  for (const [where, key] of pathKeys) {
    const value = request[where]?.[key];
    if (typeof value === "string" && value.trim()) return { text, path: value.trim() };
  }
  return { text, path: null };
}

/** The plan's title (§4 step 2): its first Markdown heading, else the file name, else "Plan"; at most 120 characters. */
export function planTitle(text: string, path: string | null | undefined): string {
  const heading = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(text)?.[1]?.trim();
  return (heading || (path ? baseName(path) : "") || "Plan").slice(0, 120);
}
