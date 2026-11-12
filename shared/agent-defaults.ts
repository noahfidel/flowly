import { z } from "zod";
import { dispatcherDefaultModel } from "./dispatcher";

/** A provider + model (+ optional reasoning effort) a new session starts with (MODEL-DEFAULTS-SPEC). */
export const agentModelSchema = z.strictObject({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  /** Reasoning option id of the model; absent keeps the model's own default. */
  thinking: z.string().min(1).max(100).optional(),
  /** Permission mode id of the provider; absent gets the picker's suggestion (`suggestedMode`). */
  mode: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).optional(),
});
export type AgentModel = z.infer<typeof agentModelSchema>;

/** Where a model default comes from, strongest first: the project's, the group's, then the global one. */
export type AgentModelSource = "project" | "group" | "global";

type WithAgentModel = { agentModel?: AgentModel | null } | null | undefined;

type WithGroupDefaults = { defaults?: { agentModel?: AgentModel | null } | null } | null | undefined;

/** The model new sessions in `project` start with: the project's own default, then its group's, then the global one; none means the user chooses (no earlier session decides). */
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

/**
 * Starting point of a new session (MODEL-DEFAULTS-SPEC §2): the chosen default's provider, model, reasoning and mode;
 * null when none is set. Never taken from an earlier session. An unset mode ("") gets the picker's suggestion
 * (`suggestedMode`), an unset reasoning ("") is the model's own default, and the speed is the picker's suggestion.
 */
export function startingAgent(chosen: AgentModel | null | undefined) {
  if (!chosen) return null;
  return { provider: chosen.provider, model: chosen.model, mode: chosen.mode ?? "", thinking: chosen.thinking ?? "", speed: undefined as string | undefined };
}

/** The agent picker's first state for `defaults`; with none, provider and model stay empty until the user picks. */
export function pickerSeed(defaults: { provider: string; model: string; mode: string; thinking?: string; speed?: string } | null | undefined) {
  return {
    provider: defaults?.provider || "",
    model: defaults?.model || "",
    mode: defaults?.mode || undefined,
    thinking: defaults?.thinking || undefined,
    speed: defaults?.speed,
  };
}

/**
 * The model the picker shows (MODEL-DEFAULTS-SPEC §2): `wanted` while the provider offers it (selectable), else the
 * provider's default, else its first model. `unofferedDefault` names the configured default when that is what could
 * not be used, so the form says so instead of passing the provider's default off as the user's.
 */
export function pickModel({ wanted, provider, defaults, models }: {
  wanted: string;
  provider: string;
  defaults: { provider: string; model: string } | null | undefined;
  models: readonly { id: string; isDefault?: boolean; isSelectable?: boolean }[];
}): { id: string; unofferedDefault: string } {
  const selectable = models.filter((m) => m.isSelectable !== false);
  if (wanted && selectable.some((m) => m.id === wanted)) return { id: wanted, unofferedDefault: "" };
  const id = selectable.find((m) => m.isDefault)?.id || selectable[0]?.id || "";
  const unofferedDefault = id && wanted && defaults && defaults.provider === provider && defaults.model === wanted ? wanted : "";
  return { id, unofferedDefault };
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

/** Reasoning the picker sends: the chosen option when the model offers it, else the model's own default (""). */
export function chosenThinking(thinking: string | undefined, options: readonly { id: string }[] = []): string {
  return thinking && options.some((o) => o.id === thinking) ? thinking : "";
}
