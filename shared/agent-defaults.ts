import { z } from "zod";
import { dispatcherDefaultModel } from "./dispatcher";

/** A provider + model (+ optional reasoning effort) a new session starts with (MODEL-DEFAULTS-SPEC). */
export const agentModelSchema = z.strictObject({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  /** Reasoning option id of the model; absent gets the picker's suggestion (`suggestedThinking`). */
  thinking: z.string().min(1).max(100).optional(),
  /** Permission mode id of the provider; absent keeps the latest session's (same provider) or the provider default. */
  mode: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).optional(),
});
export type AgentModel = z.infer<typeof agentModelSchema>;

/** Where a model default comes from, strongest first: the project's, the group's, then the global one. */
export type AgentModelSource = "project" | "group" | "global";

type WithAgentModel = { agentModel?: AgentModel | null } | null | undefined;

type WithGroupDefaults = { defaults?: { agentModel?: AgentModel | null } | null } | null | undefined;

/** The model new sessions in `project` start with: the project's own default, then its group's, then the global one; none means "follow the latest session". */
export function effectiveAgentModel(project: WithAgentModel, group: WithGroupDefaults, global: AgentModel | null | undefined): { model: AgentModel; source: AgentModelSource } | null {
  if (project?.agentModel) return { model: project.agentModel, source: "project" };
  if (group?.defaults?.agentModel) return { model: group.defaults.agentModel, source: "group" };
  if (global) return { model: global, source: "global" };
  return null;
}

/**
 * The model a group's dispatcher starts with when Start passes none (DISPATCHER-SPEC §0, §3): the group's
 * `defaults.dispatcherModel`, else the host's Dispatcher model setting (`models.dispatcherModel`), else the server
 * default. Both stored values are `agentModelSchema` values; an absent or null one inherits.
 */
export function effectiveDispatcherModel(
  group: { defaults?: { dispatcherModel?: AgentModel | null } | null } | null | undefined,
  host: AgentModel | null | undefined,
): AgentModel {
  return group?.defaults?.dispatcherModel ?? host ?? { ...dispatcherDefaultModel };
}

type LastSession ={ provider: string; model: string; mode: string; thinking?: string; speed?: string } | null | undefined;

/**
 * Starting point of the session form: the chosen default replaces provider,
 * model and reasoning of the latest session; the permission mode and the speed
 * (AGENT-SPEED-SPEC) are only kept when they belong to the same provider.
 * A mode or speed left unset here gets the picker's suggestion (`suggestedMode`, `suggestedSpeed`).
 */
export function startingAgent(last: LastSession, chosen: AgentModel | null | undefined) {
  if (!chosen) return last ?? null;
  const sameProvider = !!last && last.provider === chosen.provider;
  return {
    provider: chosen.provider,
    model: chosen.model,
    mode: chosen.mode ?? (sameProvider ? last.mode : ""),
    thinking: chosen.thinking ?? "",
    speed: sameProvider ? last.speed : undefined,
  };
}

/** Flat host-setting values (`defaultProvider`/`defaultModel`/`defaultThinking`/`defaultMode`) as a model, or null while incomplete. */
export function agentModelFromValues(values: { defaultProvider?: string; defaultModel?: string; defaultThinking?: string; defaultMode?: string } | null | undefined): AgentModel | null {
  if (!values?.defaultProvider || !values.defaultModel) return null;
  return {
    provider: values.defaultProvider,
    model: values.defaultModel,
    ...(values.defaultThinking ? { thinking: values.defaultThinking } : {}),
    ...(values.defaultMode ? { mode: values.defaultMode } : {}),
  };
}

/** Automatic approval suggestion; explicit and remembered modes win. Pass the base provider (`providerBase`). */
export function suggestedMode(provider: string, remembered?: string): string {
  return remembered || (provider === "claude" ? "auto" : provider === "codex" ? "auto-review" : "");
}

/**
 * Permission mode of a Quick task (QUICK-TASK-SPEC §1): `plan` whenever the
 * provider offers it, else the usual suggestion. An explicit pick (including
 * "" for the provider default) always wins. `provider` is the base provider.
 */
export function quickTaskMode({ provider, modeIds, explicit }: { provider: string; modeIds?: readonly string[]; explicit?: string }): string {
  if (explicit !== undefined) return explicit;
  return modeIds?.includes("plan") ? "plan" : suggestedMode(provider);
}

/**
 * The built-in provider whose suggestions apply: `claude`/`codex` themselves,
 * or a custom provider extending one (`claude-connected`, `codex-connected`).
 * Paseo does not tell clients what a custom provider extends, so it is
 * recognised by its base's permission modes; anything else stays itself.
 */
export function providerBase(provider: string, modeIds: readonly string[] = []): string {
  if (provider === "claude" || provider === "codex") return provider;
  if (modeIds.includes("auto-review")) return "codex";
  if (modeIds.includes("acceptEdits") && modeIds.includes("bypassPermissions")) return "claude";
  return provider;
}

/** Reasoning suggestion for any provider: Extra High (`xhigh`) when the model offers it, else the model's own default (""). */
export function suggestedThinking(options: readonly { id: string }[] = []): string {
  return options.some((o) => o.id === "xhigh") ? "xhigh" : "";
}
