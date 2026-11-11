import type { Artifact, ArtifactRole } from "../shared/model";
import { providerBase, suggestedMode } from "../shared/agent-defaults";
import { suggestPlanAwareMode } from "../shared/plans";

/** Pure decisions for the card's Plan row and the artifact form's Plan role (CARD-PLAN-SPEC §2, §6.2). No React. */

/** The artifact form's role choice: Input, Output, or the card's Plan (§2.2). */
export type ArtifactFormRole = ArtifactRole | "plan";

type FormArtifact = Pick<Artifact, "role" | "plan" | "origin" | "external">;

/** The form's first role: Plan when asked for (Set plan, Replace…) or for the plan artifact itself, else its role or Input. */
export function initialFormRole(artifact: FormArtifact | null, preset?: ArtifactFormRole): ArtifactFormRole {
  if (preset) return preset;
  if (artifact?.plan) return "plan";
  return artifact?.role ?? "input";
}

/** A review ledger or an external item can't be the plan (§1.1), so the form doesn't offer Plan for them. */
export function planChoiceAllowed(artifact: FormArtifact | null): boolean {
  return !artifact || (!artifact.external && artifact.origin !== "review-ledger");
}

/**
 * The RPC steps that save the form (§2.2), in order. `update` edits title and note (and the role unless Plan is
 * chosen) from the artifact as it is after the earlier steps; `artifacts.update` never touches `plan`, so the plan
 * artifact edited to Input or Output is updated first (its `updatedAt` still matches) and the slot cleared after.
 */
export type ArtifactSaveStep = "create" | "update" | "plan-set" | "plan-clear";
export function artifactSaveSteps(artifact: Pick<Artifact, "plan"> | null, role: ArtifactFormRole, note: string): ArtifactSaveStep[] {
  if (!artifact) return role === "plan" ? (note.trim() ? ["plan-set", "update"] : ["plan-set"]) : ["create"];
  if (role === "plan") return artifact.plan ? ["update"] : ["update", "plan-set"];
  return artifact.plan ? ["update", "plan-clear"] : ["update"];
}

/**
 * The Start session form's starting point (§6.2): with an approved plan, a default `plan` mode becomes the provider's
 * usual suggestion ("" for a provider without one, which the picker then suggests). The user can still pick Plan.
 */
export function planAwareDefaults<T extends { provider: string; mode: string }>(defaults: T | null | undefined, approvedPlan: boolean): T | null | undefined {
  if (!defaults) return defaults;
  const mode = suggestPlanAwareMode({ resolved: defaults.mode, approvedPlan, suggested: suggestedMode(providerBase(defaults.provider)) });
  return mode === defaults.mode ? defaults : { ...defaults, mode };
}
