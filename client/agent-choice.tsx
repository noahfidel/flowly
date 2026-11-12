import { chosenThinking as thinkingFor, pickerSeed, pickModel, providerBase, quickTaskMode, suggestedMode } from "../shared/agent-defaults";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Label, font, space } from "./ui";
import { PickerGroup, PickerRow } from "./picker";
import { modelOptions, providerOptions } from "./options";
import { t } from "../shared/i18n";
import { suggestedSpeed, speedFeature, speedFeatureValues } from "../shared/agent-speed";

export type AgentDefaults = { provider: string; model: string; mode: string; thinking?: string; speed?: string } | null | undefined;

/**
 * Provider / model / reasoning / speed / permission choice shared by "New
 * session" and "New task → Start an agent now". Defaults fall back to the
 * provider's defaults when no longer offered; with no default the provider and
 * model stay empty until picked. A mode or speed not chosen yet (undefined) gets
 * its suggestion; reasoning not chosen is the model's own (MODEL-DEFAULTS-SPEC).
 * `cwd` scopes model/mode discovery.
 */
export function useAgentChoice({ enabled, cwd, defaults, planFirst = false }: { enabled: boolean; cwd?: string; defaults: AgentDefaults; /** Quick task: start in `plan` when the provider offers it, unless a mode is picked. */ planFirst?: boolean }) {
  const paseo = usePaseo();
  const [seed] = useState(() => pickerSeed(defaults));
  const [provider, setProviderState] = useState(seed.provider),
    [model, setModel] = useState(seed.model),
    [mode, setMode] = useState<string | undefined>(seed.mode),
    [thinking, setThinking] = useState<string | undefined>(seed.thinking),
    [speed, setSpeed] = useState<string | undefined>(seed.speed);
  const providers = useQuery({
    queryKey: ["flowly", "providers"],
    queryFn: () => paseo.providers.listAvailable(),
    enabled,
  });
  const providerInfo = useQuery({
    queryKey: ["flowly", "providerSnapshot"],
    queryFn: () => paseo.providers.snapshot(),
    enabled,
    staleTime: 60000,
  });
  const models = useQuery({
    queryKey: ["flowly", "models", provider, cwd],
    queryFn: async () => {
      const result = await paseo.providers.listModels(provider, { cwd });
      if (result.error) throw new Error(result.error);
      return result;
    },
    enabled: enabled && !!cwd && !!provider,
  });
  const modes = useQuery({
    queryKey: ["flowly", "modes", provider, cwd],
    queryFn: async () => {
      const result = await paseo.providers.listModes(provider, { cwd });
      if (result.error) throw new Error(result.error);
      return result;
    },
    enabled: enabled && !!cwd && !!provider,
  });
  // A default whose provider is not available here falls back to an available one; no default stays empty.
  useEffect(() => {
    const available = providers.data?.providers.filter((p) => p.available) || [];
    if (!provider || !providers.isSuccess || !available.length) return;
    if (!available.some((p) => p.provider === provider)) {
      setProviderState(available.find((p) => p.provider === "codex")?.provider || available[0].provider);
      setModel("");
      setMode(undefined);
      setThinking(undefined);
      setSpeed(undefined);
    }
  }, [providers.data, provider]);
  const selectable = (models.data?.models || []).filter((m) => m.isSelectable !== false);
  // A default the provider no longer offers is named in the picker, never passed off as the default (MODEL-DEFAULTS-SPEC §2).
  const { id: chosenModel, unofferedDefault } = pickModel({ wanted: model, provider, defaults, models: models.data?.models || [] });
  // Reasoning effort: the model's own options; "" keeps the model default.
  const thinkingOptions = selectable.find((m) => m.id === chosenModel)?.thinkingOptions || [];
  const defaultThinking = selectable.find((m) => m.id === chosenModel)?.defaultThinkingOptionId || "";
  const chosenThinking = thinkingFor(thinking, thinkingOptions);
  // A custom provider (`codex-connected`, …) gets its base provider's suggestions.
  const base = providerBase(provider, modes.data?.modes?.map((m) => m.id));
  const modeIds = modes.data?.modes?.map((m) => m.id);
  const wantedMode = planFirst ? quickTaskMode({ provider: base, modeIds, explicit: mode }) : (mode ?? suggestedMode(base));
  const chosenMode =
    wantedMode && (!modes.isSuccess || modes.data?.modes?.some((m) => m.id === wantedMode)) ? wantedMode : "";
  // Speed: a provider feature of the chosen model (AGENT-SPEED-SPEC); "" is the provider's normal speed.
  const features = useQuery({
    queryKey: ["flowly", "features", provider, chosenModel, cwd],
    queryFn: async () => {
      const result = await paseo.providers.listFeatures({ provider: `${provider}/${chosenModel}`, cwd: cwd! });
      if (result.error) throw new Error(result.error);
      return result;
    },
    enabled: enabled && !!cwd && !!chosenModel,
    staleTime: 300000,
  });
  const speedChoice = useMemo(() => speedFeature(features.data?.features), [features.data]);
  const wantedSpeed = speed ?? suggestedSpeed(base, undefined, speedChoice?.options);
  const chosenSpeed = wantedSpeed && speedChoice?.options.some((o) => o.id === wantedSpeed) ? wantedSpeed : "";
  const providerAvailable = !!providers.data?.providers.some((p) => p.available && p.provider === provider);
  return {
    provider,
    setProvider(next: string) {
      if (next === provider) return;
      setProviderState(next);
      setModel("");
      setMode(undefined);
      setThinking(undefined);
      setSpeed(undefined);
    },
    setModel,
    setMode,
    setThinking,
    setSpeed,
    reset(next: AgentDefaults) {
      const seed = pickerSeed(next);
      setProviderState(seed.provider);
      setModel(seed.model);
      setMode(seed.mode);
      setThinking(seed.thinking);
      setSpeed(seed.speed);
    },
    chosenModel,
    /** The configured default model when the provider does not offer it (another model is shown instead); else "". */
    unofferedDefault,
    chosenMode,
    chosenThinking,
    chosenSpeed,
    thinkingOptions,
    defaultThinking,
    speedChoice,
    /** `featureValues` of the new session: the chosen speed, or undefined for normal speed. */
    featureValues: speedFeatureValues(speedChoice, chosenSpeed),
    providers,
    providerInfo,
    models,
    modes,
    features,
    /** A model and provider are selectable, modes are known and did not fail, and a wanted speed is not still being checked. */
    ready:
      models.isSuccess &&
      !!chosenModel &&
      providerAvailable &&
      !modes.isPending &&
      (!chosenMode || !modes.isError) &&
      (!wantedSpeed || !features.isPending),
    providerAvailable,
  };
}
export type AgentChoice = ReturnType<typeof useAgentChoice>;

export function AgentPicker({ choice, disabled = false }: { choice: AgentChoice; disabled?: boolean }) {
  const [picker, setPicker] = useState<"provider" | "model" | "thinking" | "speed" | "mode" | null>(null);
  const toggle = (next: "provider" | "model" | "thinking" | "speed" | "mode") => setPicker(picker === next ? null : next);
  const defaultLabel = choice.thinkingOptions.find((t) => t.id === choice.defaultThinking)?.label;
  const normalSpeed = choice.speedChoice?.normalLabel || t("Standard");
  return (
    <View style={{ gap: space[1.5] }}>
      <Label medium size={font.sm} muted>
        {t("Agent")}</Label>
      <PickerGroup>
        <PickerRow
          first
          title={t("Provider")}
          icon="Bot"
          open={picker === "provider"}
          disabled={disabled}
          loading={choice.providers.isPending}
          value={choice.provider}
          placeholder={t("Choose a provider")}
          options={providerOptions(choice.providers.data?.providers || [], choice.providerInfo.data?.entries || [])}
          onToggle={() => toggle("provider")}
          onChange={(p) => {
            choice.setProvider(p);
            setPicker(null);
          }}
        />
        <PickerRow
          title={t("Model")}
          icon="Cpu"
          open={picker === "model"}
          disabled={disabled}
          loading={!!choice.provider && choice.models.isPending}
          value={choice.chosenModel}
          placeholder={t("Choose a model")}
          options={modelOptions(choice.models.data?.models || [])}
          onToggle={() => toggle("model")}
          onChange={(m) => {
            choice.setModel(m);
            setPicker(null);
          }}
        />
        {choice.thinkingOptions.length > 0 && (
          <PickerRow
            title={t("Reasoning")}
            icon="Brain"
            open={picker === "thinking"}
            disabled={disabled}
            loading={false}
            value={choice.chosenThinking}
            placeholder={defaultLabel ? t("Model default ({defaultLabel})", { defaultLabel }) : t("Model default")}
            options={[
              { value: "", label: defaultLabel ? t("Model default ({defaultLabel})", { defaultLabel }) : t("Model default"), detail: t("Use the model's default reasoning effort") },
              ...choice.thinkingOptions.map((t) => ({ value: t.id, label: t.label, detail: t.description })),
            ]}
            onToggle={() => toggle("thinking")}
            onChange={(t) => {
              choice.setThinking(t);
              setPicker(null);
            }}
          />
        )}
        {choice.speedChoice && (
          <PickerRow
            title={t("Speed")}
            icon="Zap"
            open={picker === "speed"}
            disabled={disabled}
            loading={false}
            value={choice.chosenSpeed}
            placeholder={normalSpeed}
            options={[
              { value: "", label: normalSpeed },
              ...choice.speedChoice.options.map((o) => ({ value: o.id, label: o.label, detail: o.description })),
            ]}
            onToggle={() => toggle("speed")}
            onChange={(s) => {
              choice.setSpeed(s);
              setPicker(null);
            }}
          />
        )}
        <PickerRow
          title={t("Permissions")}
          icon="ShieldCheck"
          open={picker === "mode"}
          disabled={disabled}
          loading={!!choice.provider && choice.modes.isPending}
          value={choice.chosenMode}
          placeholder={t("Provider default")}
          options={[
            { value: "", label: t("Provider default"), detail: t("Use the provider's configured permission mode") },
            ...(choice.modes.data?.modes || []).map((m) => ({
              value: m.id,
              label: m.label,
              detail: m.description,
            })),
          ]}
          onToggle={() => toggle("mode")}
          onChange={(m) => {
            choice.setMode(m);
            setPicker(null);
          }}
        />
      </PickerGroup>
      {!!choice.unofferedDefault && (
        <Label size={font.sm} muted>
          {t("Default model {model} is not offered by {provider}. Choose another default in Settings → Models.", { model: choice.unofferedDefault, provider: choice.provider })}
        </Label>
      )}
      {!choice.provider && (
        <Label size={font.sm} muted>
          {t("No default model. Set one in Settings → Models.")}
        </Label>
      )}
    </View>
  );
}
