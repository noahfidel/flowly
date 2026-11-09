import { useEffect, useState } from "react";
import { usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { AgentModel } from "../shared/agent-defaults";
import { modelOptions, providerOptions } from "./options";
import { SettingSelect, SettingsGroup } from "./settings-ui";
import { Notice } from "./ui";
import { t } from "../shared/i18n";

/**
 * Provider, model and reasoning effort of a default model, as one card of rows.
 * "None" (first provider choice) clears it: `noneLabel` says what then applies.
 */
export function ModelDefaultGroup({
  title,
  description,
  value,
  onChange,
  noneLabel,
  noneDetail,
  disabled = false,
  allowProvider,
  invalidText,
}: {
  title?: string;
  description?: string;
  value: AgentModel | null;
  onChange(next: AgentModel | null): void;
  noneLabel: string;
  noneDetail?: string;
  disabled?: boolean;
  /** Only these providers are offered; a stored value on another one shows `invalidText`. */
  allowProvider?: (provider: string) => boolean;
  invalidText?: string;
}) {
  const paseo = usePaseo();
  // A provider can be picked before its model is: the model row follows it.
  const [provider, setProvider] = useState(value?.provider ?? "");
  useEffect(() => setProvider(value?.provider ?? ""), [value?.provider]);
  const providers = useQuery({ queryKey: ["flowly", "providers"], queryFn: () => paseo.providers.listAvailable() });
  const providerInfo = useQuery({ queryKey: ["flowly", "providerSnapshot"], queryFn: () => paseo.providers.snapshot(), staleTime: 60000 });
  const models = useQuery({
    queryKey: ["flowly", "default-models", provider],
    queryFn: async () => {
      const result = await paseo.providers.listModels(provider);
      if (result.error) throw new Error(result.error);
      return result;
    },
    enabled: !!provider,
  });
  const modes = useQuery({
    queryKey: ["flowly", "default-modes", provider],
    queryFn: async () => {
      const result = await paseo.providers.listModes(provider);
      if (result.error) throw new Error(result.error);
      return result;
    },
    enabled: !!provider,
  });
  const selectable = (models.data?.models || []).filter((m) => m.isSelectable !== false);
  const sameProvider = !!value && value.provider === provider;
  const model = sameProvider ? value!.model : "";
  // Choosing a provider also chooses its default model, so the default is always complete.
  useEffect(() => {
    if (!provider || model || !models.isSuccess || !selectable.length) return;
    const pick = selectable.find((m) => m.isDefault) || selectable[0];
    onChange({ provider, model: pick.id });
  }, [provider, model, models.isSuccess, selectable.length]);
  const thinkingOptions = selectable.find((m) => m.id === model)?.thinkingOptions || [];
  const thinking = sameProvider && value!.thinking && thinkingOptions.some((o) => o.id === value!.thinking) ? value!.thinking! : "";
  const defaultThinking = selectable.find((m) => m.id === model)?.defaultThinkingOptionId;
  const defaultThinkingLabel = thinkingOptions.find((o) => o.id === defaultThinking)?.label;
  const modeList = modes.data?.modes || [];
  // Kept through model/reasoning edits even while the mode list is loading or failed; the list only filters what the Permissions row shows.
  const storedMode = sameProvider && value!.mode ? value!.mode : "";
  const mode = storedMode && modeList.some((m) => m.id === storedMode) ? storedMode : "";
  const modelDefault = defaultThinkingLabel ? t("Model default ({defaultLabel})", { defaultLabel: defaultThinkingLabel }) : t("Model default");
  return (
    <SettingsGroup title={title} description={description}>
      {!!value && !!allowProvider && !allowProvider(value.provider) && !!invalidText && <Notice>{invalidText}</Notice>}
      <SettingSelect
        title={t("Provider")}
        value={provider}
        placeholder={noneLabel}
        disabled={disabled}
        loading={providers.isPending}
        options={[{ value: "", label: noneLabel, detail: noneDetail }, ...providerOptions(providers.data?.providers || [], providerInfo.data?.entries || []).filter((o) => !allowProvider || allowProvider(o.value))]}
        onChange={(next) => {
          setProvider(next);
          if (!next) onChange(null);
        }}
      />
      {!!provider && (
        <SettingSelect
          title={t("Model")}
          value={model}
          placeholder={t("Choose a model")}
          disabled={disabled}
          loading={models.isPending}
          options={modelOptions(models.data?.models || [])}
          onChange={(next) => onChange({ provider, model: next, ...(storedMode ? { mode: storedMode } : {}) })}
        />
      )}
      {!!provider && !!model && thinkingOptions.length > 0 && (
        <SettingSelect
          title={t("Reasoning")}
          value={thinking}
          placeholder={modelDefault}
          disabled={disabled}
          options={[
            { value: "", label: modelDefault, detail: t("Use the model's default reasoning effort") },
            ...thinkingOptions.map((o) => ({ value: o.id, label: o.label, detail: o.description })),
          ]}
          onChange={(next) => onChange({ provider, model, ...(next ? { thinking: next } : {}), ...(storedMode ? { mode: storedMode } : {}) })}
        />
      )}
      {!!provider && !!model && modeList.length > 0 && (
        <SettingSelect
          title={t("Permissions")}
          value={mode}
          placeholder={t("Same as latest session")}
          disabled={disabled}
          options={[
            { value: "", label: t("Same as latest session"), detail: t("Use the latest session's permission mode when it uses this provider, else the provider's own") },
            ...modeList.map((m) => ({ value: m.id, label: m.label, detail: m.description })),
          ]}
          onChange={(next) => onChange({ provider, model, ...(thinking ? { thinking } : {}), ...(next ? { mode: next } : {}) })}
        />
      )}
    </SettingsGroup>
  );
}
