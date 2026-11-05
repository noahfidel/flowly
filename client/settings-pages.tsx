import { useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import { Collapse } from "./disclosure";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { AUTO_MODELS, summaryModelsOf, type SummarySettings, modelLabel, summarySettings, summarySettingsValues } from "../shared/summary";
import {
  aiLanguageSettings,
  aiLanguageSettingsValues,
  boardViewSettings,
  boardViewValues,
  featureSettings,
  featureSettingsValues,
  ideasSettings,
  ideasSettingsValues,
  nativeSessionSettings,
  nativeSessionSettingsValues,
  languageSettings,
  languageSettingsValues,
  modelSettings,
  modelSettingsValues,
  statusSettings,
  statusSettingsValues,
  telemetrySettings,
  telemetrySettingsValues,
  wrapupSettings,
  wrapupSettingsValues,
} from "../shared/settings";
import { agentModelFromValues, type AgentModel } from "../shared/agent-defaults";
import { deviceLocale, formatLocale, getLocale, locales, msg, t, tn } from "../shared/i18n";
import { hideFinishedChoices } from "./finished-cards";
import { useBoardView } from "./board-view";
import { sendBehaviors, sendBehaviorText, type SendBehavior } from "./send-queue";
import { modelOptions, providerOptions } from "./options";
import { ModelDefaultGroup } from "./model-default";
import { SettingRow, SettingSelect, SettingSwitch, SettingsGroup, SettingsPage } from "./settings-ui";
import { useOnboarding } from "./onboarding-state";
import { useStored } from "./stored-settings";
import { whatsNew } from "./whats-new";
import { Button, IconButton, Notice, space, useTheme } from "./ui";
import { compactNumber } from "../shared/usage";
import { dollars, roundTokens, runCost, runTokens, type AiRun } from "../shared/ai-cost";
import * as rpc from "../shared/rpc";
import { localZone } from "./queries";
import { INTERVALS, WORKFLOW_AUTO_MODELS, usageIn, workflowInsightsSettings, workflowSettingsValues } from "../shared/workflow-insights";

/** A Flowly AI run's estimated size and price (shared/ai-cost.ts): with a price for Claude models, tokens only otherwise. */
const costTexts: Record<AiRun, readonly [string, string]> = {
  progress: [msg("About {tokens} tokens per agent turn: {cost} with {model} at API prices, {hundred} for 100 turns."), msg("About {tokens} tokens per agent turn.")],
  outside: [msg("About {tokens} tokens per agent turn: {cost} with {model} at API prices, {hundred} for 100 turns."), msg("About {tokens} tokens per agent turn.")],
  memoryReview: [msg("About {tokens} tokens per finished card: {cost} with {model} at API prices."), msg("About {tokens} tokens per finished card.")],
  digest: [msg("About {tokens} tokens per digest: {cost} with {model} at API prices."), msg("About {tokens} tokens per digest.")],
  workflow: [msg("About {tokens} tokens per run: {cost} with {model} at API prices."), msg("About {tokens} tokens per run.")],
  quickTitle: [msg("About {tokens} tokens per quick task: {cost} with {model} at API prices."), msg("About {tokens} tokens per quick task.")],
};
export function aiCostText(run: AiRun, model: string): string {
  const cost = runCost(run, model);
  const tokens = roundTokens(runTokens(run));
  return cost === null
    ? t(costTexts[run][1], { tokens })
    : t(costTexts[run][0], { tokens, cost: dollars(cost), hundred: dollars(cost * 100), model: modelLabel(model) });
}
/** The model a summary-model run uses: the chosen one, or Auto's first. */
export const summaryModelOf = (stored: SummarySettings | null | undefined) => summaryModelsOf(stored)[0];

const AUTO = "";

function Problem({ text }: { text?: string }) {
  return text ? <Notice>{text}</Notice> : null;
}

/** General: interface language and the welcome tour. */
export function GeneralPage({ onTour, onWhatsNew }: { onTour(): void; /** Reopens What's new (WHATS-NEW-SPEC §5.1). */ onWhatsNew(): void }) {
  const language = useStored(useSettings(languageSettings), languageSettingsValues);
  const onboarding = useOnboarding();
  const [reset, setReset] = useState(false);
  return (
    <SettingsPage title={t("General")}>
      <Problem text={language.problem} />
      <SettingsGroup
        title={t("Language")}
      >
        <InterfaceLanguageRow />
      </SettingsGroup>
      <SettingsGroup
        title={t("Sending messages")}
      >
        <SendBehaviorRow />
      </SettingsGroup>
      <SettingsGroup
        title={t("Welcome tour")}
      >
        <SettingRow title={t("Show welcome tour")} onPress={onTour} trailing={<ChevronRight />} />
        {whatsNew.length > 0 && <SettingRow title={t("What's new")} onPress={onWhatsNew} trailing={<ChevronRight />} />}
        <SettingRow
          title={t("Show tips again")}
          detail={reset ? t("Tips will show again") : undefined}
          disabled={!onboarding.values || reset}
          onPress={() => {
            setReset(true);
            void onboarding.resetTips();
          }}
          trailing={<ChevronRight />}
        />
      </SettingsGroup>
      <UsageDataGroup />
    </SettingsPage>
  );
}

/** Anonymous daily usage data (TELEMETRY-SPEC §5): Settings → General and the tour's last page. */
export function UsageDataGroup({ bare = false }: { bare?: boolean }) {
  const telemetry = useStored(useSettings(telemetrySettings), telemetrySettingsValues);
  const readStatus = useRpc(rpc.telemetryStatus);
  const status = useQuery({ queryKey: ["flowly", "telemetry-status"], queryFn: () => readStatus({}), staleTime: Infinity });
  const builtOff = status.data?.builtOff === true;
  const forced = builtOff || status.data?.forcedOff === true;
  return (
    <SettingsGroup title={bare ? undefined : t("Usage data")}>
      <SettingSwitch
        title={t("Send anonymous usage data")}
        detail={builtOff ? t("Turned off in this build.") : forced ? t("Turned off by DO_NOT_TRACK on this computer.") : t("Once a day: versions, which features are on and usage counts. On errors: where in Flowly's code. Never your content, paths or code.")}
        value={!forced && (telemetry.values?.enabled ?? true)}
        disabled={forced || telemetry.busy}
        onChange={(enabled) => telemetry.save({ enabled })}
      />
    </SettingsGroup>
  );
}

/** What Enter does while a session is running (the choice that used to sit under the message box). */
function SendBehaviorRow() {
  const view = useBoardView();
  const current: SendBehavior = view.values?.sendBehavior || "steer";
  return (
    <SettingSelect
      title={t("When a session is running")}
      detail={t(sendBehaviorText[current].detail)}
      value={current}
      placeholder={t(sendBehaviorText[current].label)}
      disabled={!view.values}
      options={sendBehaviors.map((b) => ({ value: b, label: t(sendBehaviorText[b].label) }))}
      onChange={(next) => void view.update({ sendBehavior: next as SendBehavior })}
    />
  );
}

/** Interface language (Settings → General and the welcome tour's first page). */
export function InterfaceLanguageRow() {
  const language = useStored(useSettings(languageSettings), languageSettingsValues);
  const deviceName = locales.find((l) => l.code === deviceLocale())?.name ?? "English";
  const autoLabel = t("Device ({language})", { language: deviceName });
  return (
    <SettingSelect
      title={t("Interface language")}
      value={language.values?.language ?? "auto"}
      placeholder={autoLabel}
      disabled={language.busy}
      options={[{ value: "auto", label: autoLabel }, ...locales.map((l) => ({ value: l.code as string, label: l.name }))]}
      onChange={(next) => language.save({ language: next as NonNullable<typeof language.values>["language"] })}
    />
  );
}

/** AI output language (Settings → AI features and the welcome tour's Built in page). */
export function AiLanguageRow() {
  const aiLanguage = useStored(useSettings(aiLanguageSettings), aiLanguageSettingsValues);
  const interfaceName = locales.find((l) => l.code === getLocale())?.name ?? "English";
  const sameAsInterface = t("Same as interface language ({language})", { language: interfaceName });
  return (
    <SettingSelect
      title={t("AI output language")}
      value={aiLanguage.values?.aiLanguage ?? "interface"}
      placeholder={sameAsInterface}
      disabled={aiLanguage.busy}
      options={[{ value: "interface", label: sameAsInterface }, ...locales.map((l) => ({ value: l.code as string, label: l.name }))]}
      onChange={(next) => aiLanguage.save({ aiLanguage: next as NonNullable<typeof aiLanguage.values>["aiLanguage"] })}
    />
  );
}

function ChevronRight() {
  const { colors } = useTheme();
  return <Icon name="ChevronRight" size={16} color={colors.foregroundMuted} />;
}

/** Models: the default model of new sessions, and the one that writes summaries. */
export function ModelsPage({ active }: { active: boolean }) {
  const models = useStored(useSettings(modelSettings), modelSettingsValues);
  const current = agentModelFromValues(models.values);
  return (
    <SettingsPage title={t("Models")}>
      <Problem text={models.problem} />
      <ModelDefaultGroup
        title={t("Default model")}
        value={current}
        disabled={models.busy}
        noneLabel={t("Automatic")}
        noneDetail={t("Start from the latest session's settings")}
        onChange={(next: AgentModel | null) => models.save({ defaultProvider: next?.provider ?? "", defaultModel: next?.model ?? "", defaultThinking: next?.thinking ?? "", defaultMode: next?.mode ?? "" })}
      />
      <SummaryModelGroup active={active} />
    </SettingsPage>
  );
}

/** Ordered summary fallback models, shared by Settings and the welcome tour. */
export function SummaryModelGroup({ active, bare = false, extra }: { active: boolean; bare?: boolean; extra?: ReactNode }) {
  const paseo = usePaseo();
  const summary = useStored(useSettings(summarySettings), summarySettingsValues);
  const selected = summaryModelsOf(summary.values);
  const onboarding = useOnboarding();
  const modelTipSeen = onboarding.values?.tipsSeen.includes("summary-models");
  useEffect(() => {
    if (active && onboarding.values && !modelTipSeen) void onboarding.markTipSeen("summary-models");
  }, [active, onboarding.status, modelTipSeen]);
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState("");
  const providers = useQuery({ queryKey: ["flowly", "providers"], queryFn: () => paseo.providers.listAvailable(), enabled: active });
  const providerInfo = useQuery({ queryKey: ["flowly", "providerSnapshot"], queryFn: () => paseo.providers.snapshot(), enabled: active, staleTime: 60000 });
  const models = useQuery({
    queryKey: ["flowly", "summary-models", provider],
    queryFn: async () => {
      const result = await paseo.providers.listModels(provider);
      if (result.error) throw new Error(result.error);
      return result;
    },
    enabled: active && adding && !!provider,
  });
  const save = (summaryModels: string[]) => summary.save({ summaryModels, summaryModel: "" });
  const move = (index: number, step: number) => {
    const next = [...selected];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    save(next);
  };
  return (
    <>
      <Problem text={summary.problem} />
      <SettingsGroup
        title={bare ? t("Progress models") : t("Summary models")}
      >
        {selected.map((id, index) => (
          <SettingRow
            key={id}
            title={`${index + 1}. ${modelLabel(id)}`}
            trailing={
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1] }}>
                <IconButton icon="ArrowUp" label={t("Move {model} up", { model: modelLabel(id) })} disabled={summary.busy || index === 0} onPress={() => move(index, -1)} />
                <IconButton icon="ArrowDown" label={t("Move {model} down", { model: modelLabel(id) })} disabled={summary.busy || index === selected.length - 1} onPress={() => move(index, 1)} />
                <IconButton icon="X" label={t("Remove {model}", { model: modelLabel(id) })} disabled={summary.busy || selected.length === 1} onPress={() => save(selected.filter((entry) => entry !== id))} />
              </View>
            }
          />
        ))}
        <SettingRow title={t("Add model")} disabled={summary.busy} state={{ expanded: adding }} onPress={() => setAdding(!adding)} trailing={<Icon name={adding ? "ChevronUp" : "Plus"} size={16} />} />
        <Collapse open={adding} id="summary-model-add">
          <SettingSelect title={t("Provider")} value={provider} placeholder={t("Choose a provider")} disabled={summary.busy} loading={providers.isPending} options={providerOptions(providers.data?.providers || [], providerInfo.data?.entries || [])} onChange={setProvider} />
          {!!provider && <SettingSelect
            title={t("Model")} value="" placeholder={t("Choose a model")} disabled={summary.busy} loading={models.isPending}
            options={modelOptions(models.data?.models || []).map((option) => ({ ...option, disabled: selected.includes(`${provider}/${option.value}`) }))}
            onChange={(model) => {
              const id = `${provider}/${model}`;
              if (selected.includes(id)) return;
              save([...selected, id]);
              setAdding(false);
              setProvider("");
            }}
          />}
          <View style={{ padding: space[3], alignItems: "flex-start" }}><Button small quiet onPress={() => { setAdding(false); setProvider(""); }}>{t("Cancel")}</Button></View>
        </Collapse>
        <SettingRow title={t("Restore defaults")} disabled={summary.busy} onPress={() => save([...AUTO_MODELS])} trailing={<Icon name="RotateCcw" size={16} />} />
        <SettingRow title={t("First model estimate")} detail={aiCostText("progress", summaryModelOf(summary.values))} />
        {extra}
      </SettingsGroup>
      {providers.error && <Notice tone="warning">{t("Could not list models: {error}", { error: String(providers.error) })}</Notice>}
      {models.error && <Notice tone="warning">{t("Could not list models: {error}", { error: String(models.error) })}</Notice>}
    </>
  );
}

/** Workflow: when cards move by themselves and what happens when they finish. */
export function WorkflowPage() {
  const status = useStored(useSettings(statusSettings), statusSettingsValues);
  const wrapup = useStored(useSettings(wrapupSettings), wrapupSettingsValues);
  const view = useStored(useSettings(boardViewSettings), boardViewValues);
  const hideAfter = view.values?.hideFinishedAfterDays ?? 14;
  const dayLabel = (days: number) => (days ? tn(days, "After {n} day", "After {n} days") : t("Never"));
  const hideOptions = [...new Set<number>([...hideFinishedChoices, hideAfter])]
    .sort((a, b) => a - b)
    .map((days) => ({ value: String(days), label: dayLabel(days) }));
  return (
    <SettingsPage title={t("Workflow")}>
      <Problem text={status.problem || wrapup.problem || view.problem} />
      <SettingsGroup title={t("Moving cards")}>
        <SettingSwitch
          title={t("Auto-update status from sessions")}
          value={status.values?.autoStatus ?? true}
          disabled={status.busy}
          onChange={(autoStatus) => status.save({ autoStatus })}
        />
      </SettingsGroup>
      <SettingsGroup title={t("Finishing cards")}>
        <SettingSwitch
          title={t("Auto wrap up")}
          detail={t("Archive without asking when nothing blocks it: no running session, no uncommitted or unpushed work. Otherwise the card is left for manual Wrap up.")}
          value={wrapup.values?.autoWrapup ?? false}
          disabled={wrapup.busy}
          onChange={(autoWrapup) => wrapup.save({ autoWrapup })}
        />
        <SettingSwitch
          title={t("Auto archive on delete")}
          value={wrapup.values?.archiveOnDelete ?? false}
          disabled={wrapup.busy}
          onChange={(archiveOnDelete) => wrapup.save({ archiveOnDelete })}
        />
        <SettingSelect
          title={t("Hide old finished cards")}
          value={String(hideAfter)}
          placeholder={dayLabel(hideAfter)}
          disabled={view.busy}
          options={hideOptions}
          onChange={(next) => view.save({ hideFinishedAfterDays: Number(next) })}
        />
      </SettingsGroup>
      <QuickTaskGroup />
    </SettingsPage>
  );
}

/** Quick task (QUICK-TASK-SPEC §6): what New task opens, the AI title and the workspace. */
function QuickTaskGroup() {
  const view = useBoardView();
  const summary = useStored(useSettings(summarySettings), summarySettingsValues);
  const mode = view.values?.quickTaskMode ?? "worktree";
  const modes = [
    { value: "worktree", label: t("New isolated worktree") },
    { value: "directory", label: t("New in directory") },
  ];
  return (
    <SettingsGroup title={t("Quick task")}>
      <SettingSwitch
        title={t("Quick task for New task")}
        value={view.values?.quickTaskDefault ?? true}
        disabled={!view.values}
        onChange={(quickTaskDefault) => void view.update({ quickTaskDefault })}
      />
      <SettingSwitch
        title={t("AI titles for quick tasks")}
        detail={`${t("The summary model names the card and suggests its type and tags. Spends tokens.")} ${aiCostText("quickTitle", summaryModelOf(summary.values))}`}
        value={view.values?.quickTaskAiTitle ?? true}
        disabled={!view.values}
        onChange={(quickTaskAiTitle) => void view.update({ quickTaskAiTitle })}
      />
      <SettingSelect
        title={t("Workspace for quick tasks")}
        value={mode}
        placeholder={modes.find((m) => m.value === mode)!.label}
        disabled={!view.values}
        options={modes}
        onChange={(next) => void view.update({ quickTaskMode: next as "worktree" | "directory" })}
      />
    </SettingsGroup>
  );
}

/** AI features: what the plugin writes for you, and the ideas agents propose. */
export function AiPage() {
  const summary = useStored(useSettings(summarySettings), summarySettingsValues);
  const ideas = useStored(useSettings(ideasSettings), ideasSettingsValues);
  const native = useStored(useSettings(nativeSessionSettings), nativeSessionSettingsValues);
  const features = useStored(useSettings(featureSettings), featureSettingsValues);
  const tapOptions = [
    { value: "fill", label: t("Fill the message box") },
    { value: "copy", label: t("Copy") },
  ];
  return (
    <SettingsPage title={t("AI features")}>
      <Problem text={summary.problem || ideas.problem || native.problem || features.problem} />
      <SettingsGroup
        title={t("Output language")}
      >
        <AiLanguageRow />
      </SettingsGroup>
      <SettingsGroup
        title={t("Task progress summary")}
      >
        <SettingSwitch
          title={t("Auto summary")}
          value={summary.values?.summaryEnabled ?? true}
          disabled={summary.busy}
          onChange={(summaryEnabled) => summary.save({ summaryEnabled })}
        />
      </SettingsGroup>
      <MemoryFeatureGroup />
      <InsightsFeatureGroup />
      {(features.values?.insights ?? true) && <WorkflowInsightsGroup />}
      <SettingsGroup title={t("Ideas")}>
        <SettingSwitch
          title={t("Ideas")}
          detail={t("Off: the Ideas page, the card sections and the lightbulb counts are hidden, and agents can no longer propose ideas. Existing ideas are kept and come back when you turn this on.")}
          value={ideas.values?.ideas ?? true}
          disabled={ideas.busy}
          onChange={(value) => ideas.save({ ideas: value })}
        />
      </SettingsGroup>
      <SettingsGroup
        title={t("Paseo's session view")}
      >
        <SettingSelect
          title={t("Tapping a suggested next step")}
          value={native.values?.nextMoveTap ?? "fill"}
          placeholder={tapOptions.find((o) => o.value === (native.values?.nextMoveTap ?? "fill"))?.label ?? ""}
          disabled={native.busy}
          options={tapOptions}
          onChange={(next) => native.save({ nextMoveTap: next === "copy" ? "copy" : "fill" })}
        />
        <SettingSwitch
          title={t("Sessions outside Flowly")}
          detail={`${t("Also give sessions Flowly does not manage a progress row, suggested next steps and ideas. After each completed turn, the summary model reads the recent conversation (sent to that model's provider) in a short child session that is archived right after.")} ${aiCostText("outside", summaryModelOf(summary.values))}`}
          value={native.values?.outside ?? false}
          disabled={native.busy}
          onChange={(outside) => native.save({ outside })}
        />
        <SettingSwitch
          title={t("Progress")}
          value={native.values?.outsideProgress ?? true}
          disabled={native.busy || !native.values?.outside}
          onChange={(outsideProgress) => native.save({ outsideProgress })}
        />
        <SettingSwitch
          title={t("Suggested next steps")}
          value={native.values?.outsideNextMoves ?? true}
          disabled={native.busy || !native.values?.outside}
          onChange={(outsideNextMoves) => native.save({ outsideNextMoves })}
        />
        <SettingSwitch
          title={t("Ideas")}
          value={native.values?.outsideIdeas ?? true}
          disabled={native.busy || !native.values?.outside}
          onChange={(outsideIdeas) => native.save({ outsideIdeas })}
        />
      </SettingsGroup>
      <SettingsGroup title={t("Artifacts")}>
        <SettingSwitch
          title={t("Agent artifacts")}
          detail={t("Off: agents can no longer add or remove artifacts and list deliverables in their replies instead. Existing artifacts are kept.")}
          value={ideas.values?.artifacts ?? true}
          disabled={ideas.busy}
          onChange={(value) => ideas.save({ artifacts: value })}
        />
      </SettingsGroup>
      <SettingsGroup title={t("Cards")}>
        <SettingSwitch
          title={t("Agents create and edit cards")}
          detail={t("Only when you ask. Sessions in a project's folders that are not on a card get these tools too.")}
          value={ideas.values?.agentCards ?? true}
          disabled={ideas.busy}
          onChange={(agentCards) => ideas.save({ agentCards })}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}

/** Project memory as a whole and its finished-card review (Settings → AI features and the welcome tour). */
export function MemoryFeatureGroup({ bare = false }: { bare?: boolean }) {
  const summary = useStored(useSettings(summarySettings), summarySettingsValues);
  const features = useStored(useSettings(featureSettings), featureSettingsValues);
  const on = features.values?.memory ?? true;
  return (
    <SettingsGroup
      title={bare ? undefined : t("Project memory")}
    >
      <SettingSwitch
        title={t("Project memory")}
        value={on}
        disabled={features.busy}
        onChange={(memory) => features.save({ memory })}
      />
      <SettingSwitch
        title={t("Find memories in finished cards")}
        detail={aiCostText("memoryReview", summaryModelOf(summary.values))}
        value={on && (summary.values?.retroEnabled ?? true)}
        disabled={summary.busy || !on}
        onChange={(retroEnabled) => summary.save({ retroEnabled })}
      />
    </SettingsGroup>
  );
}

/** Insights as a whole, its daily digest and, in the welcome tour, the Skills switch. */
export function InsightsFeatureGroup({ bare = false, workflow = false }: { bare?: boolean; workflow?: boolean }) {
  const summary = useStored(useSettings(summarySettings), summarySettingsValues);
  const features = useStored(useSettings(featureSettings), featureSettingsValues);
  const on = features.values?.insights ?? true;
  return (
    <SettingsGroup
      title={bare ? undefined : t("Insights")}
    >
      <SettingSwitch
        title={t("Insights")}
        value={on}
        disabled={features.busy}
        onChange={(insights) => features.save({ insights })}
      />
      <SettingSwitch
        title={t("Daily digest")}
        detail={aiCostText("digest", summaryModelOf(summary.values))}
        value={on && (summary.values?.digestEnabled ?? true)}
        disabled={summary.busy || !on}
        onChange={(digestEnabled) => summary.save({ digestEnabled })}
      />
      {workflow && <WorkflowSwitch disabled={!on} />}
    </SettingsGroup>
  );
}

/** Just the Skills switch (workflow insights); its model and cadence stay in Settings. */
function WorkflowSwitch({ disabled }: { disabled: boolean }) {
  const prefs = useStored(useSettings(workflowInsightsSettings), workflowSettingsValues);
  const on = !disabled && !!prefs.values?.enabled;
  return (
    <SettingSwitch
      title={t("Skills")}
      detail={`${t("A model reads your cards and commands each week and drafts skills. Spends tokens; model and schedule are in Settings.")} ${aiCostText("workflow", prefs.values?.model || WORKFLOW_AUTO_MODELS[0])}`}
      value={on}
      disabled={prefs.busy || disabled}
      onChange={(enabled) => prefs.save({ enabled, timeZone: localZone() || "" })}
    />
  );
}

const intervalLabels: Record<(typeof INTERVALS)[number], string> = { 1: msg("Daily"), 3: msg("Every 3 days"), 7: msg("Weekly"), 14: msg("Every 2 weeks") };
const hourLabel = (hour: number) => new Date(Date.UTC(2020, 0, 1, hour)).toLocaleTimeString(formatLocale(), { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/** Skills, formerly Workflow insights (INSIGHTS-REDESIGN-SPEC §5, WORKFLOW-INSIGHTS-SPEC §2.3): the switch, model, cadence and the collected data. */
function WorkflowInsightsGroup() {
  const paseo = usePaseo();
  const prefs = useStored(useSettings(workflowInsightsSettings), workflowSettingsValues);
  const values = prefs.values;
  // Every save carries the device zone, so "Run after" means this device's local hour.
  const save = (patch: Partial<NonNullable<typeof values>>) => prefs.save({ ...patch, timeZone: localZone() || "" });
  const stored = values?.model || AUTO;
  const storedProvider = stored ? stored.slice(0, stored.indexOf("/")) : AUTO;
  const [provider, setProvider] = useState(storedProvider);
  useEffect(() => setProvider(storedProvider), [storedProvider]);
  const on = !!values?.enabled;
  const providers = useQuery({ queryKey: ["flowly", "providers"], queryFn: () => paseo.providers.listAvailable(), enabled: on });
  const providerInfo = useQuery({ queryKey: ["flowly", "providerSnapshot"], queryFn: () => paseo.providers.snapshot(), enabled: on, staleTime: 60000 });
  const models = useQuery({
    queryKey: ["flowly", "workflow-models", provider],
    queryFn: async () => {
      const result = await paseo.providers.listModels(provider);
      if (result.error) throw new Error(result.error);
      return result;
    },
    enabled: on && provider !== AUTO,
  });
  const readOverview = useRpc(rpc.workflowInsightsOverview);
  const overview = useQuery({ queryKey: ["flowly", "workflow-overview"], queryFn: () => readOverview({}), staleTime: 30_000 });
  const purge = useRpc(rpc.purgeWorkflowCommands);
  const [confirm, setConfirm] = useState<"" | "ask" | "done" | "error">("");
  const autoLabel = t("Auto ({models})", { models: WORKFLOW_AUTO_MODELS.map(modelLabel).join(t(", then ")) });
  const storedModel = stored && provider === storedProvider ? stored.slice(stored.indexOf("/") + 1) : "";
  const interval = values?.intervalDays ?? 7;
  const last = overview.data?.lastRun;
  const cost = typeof last?.usage?.totalCostUsd === "number" ? last.usage.totalCostUsd : null;
  // Every included project runs once per cycle: the estimate adds up each one's latest run (§2.3).
  const cycle = overview.data?.cycleCostUsd ?? null;
  const projects = overview.data?.costProjects ?? 0;
  const lastLine = last?.usage
    ? [
        cost !== null
          ? t("Last run: {in} in · {out} out · ${cost}.", { in: compactNumber(usageIn(last.usage)), out: compactNumber(last.usage.outputTokens ?? 0), cost: cost.toFixed(2) })
          : t("Last run: {in} in · {out} out.", { in: compactNumber(usageIn(last.usage)), out: compactNumber(last.usage.outputTokens ?? 0) }),
        cycle !== null && projects
          ? tn(projects, "About ${month} per month for {n} project at this pace.", "About ${month} per month for {n} projects at this pace.", { month: ((cycle * 30) / interval).toFixed(2) })
          : "",
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  return (
    <>
      <SettingsGroup
        title={t("Skills")}
      >
        <SettingSwitch
          title={t("Skills")}
          detail={`${t("Every week a model reads this project's cards, your messages and the commands agents ran, and drafts skills and scripts worth keeping. Spends tokens and keeps a local log of commands.")} ${aiCostText("workflow", values?.model || WORKFLOW_AUTO_MODELS[0])}`}
          value={on}
          disabled={prefs.busy}
          onChange={(enabled) => save({ enabled })}
        />
        {on && (
          <>
            <SettingSelect
              title={t("Provider")}
              value={provider}
              placeholder={autoLabel}
              disabled={prefs.busy}
              loading={providers.isPending}
              options={[{ value: AUTO, label: autoLabel, detail: t("Falls back to the Summary model when neither is available") }, ...providerOptions(providers.data?.providers || [], providerInfo.data?.entries || [])]}
              onChange={(next) => {
                setProvider(next);
                if (next === AUTO) save({ model: "" });
              }}
            />
            {provider !== AUTO && (
              <SettingSelect
                title={t("Model")}
                value={storedModel}
                placeholder={t("Choose a model")}
                disabled={prefs.busy}
                loading={models.isPending}
                options={modelOptions(models.data?.models || [])}
                onChange={(model) => save({ model: `${provider}/${model}` })}
              />
            )}
            <SettingSelect
              title={t("How often")}
              value={String(interval)}
              placeholder={t(intervalLabels[interval as (typeof INTERVALS)[number]] ?? intervalLabels[7])}
              disabled={prefs.busy}
              options={INTERVALS.map((n) => ({ value: String(n), label: t(intervalLabels[n]) }))}
              onChange={(next) => save({ intervalDays: Number(next) })}
            />
            <SettingSelect
              title={t("Run after")}
              value={String(values?.runHour ?? 9)}
              placeholder={hourLabel(values?.runHour ?? 9)}
              disabled={prefs.busy}
              options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h) }))}
              onChange={(next) => save({ runHour: Number(next) })}
            />
          </>
        )}
        {!!lastLine && <SettingRow title={t("Cost")} detail={lastLine} />}
        <SettingRow
          title={t("Delete collected commands")}
          detail={
            confirm === "ask"
              ? t("Press again to delete the command log of every project. Suggestions are kept.")
              : confirm === "done"
                ? t("Deleted.")
                : confirm === "error"
                  ? t("Could not delete the command log.")
                  : overview.data?.collected
                    ? tn(overview.data.collected, "Commands are kept for 30 days, redacted, for {n} project.", "Commands are kept for 30 days, redacted, for {n} projects.")
                    : t("Nothing collected.")
          }
          disabled={!overview.data?.collected && confirm !== "ask"}
          onPress={() => {
            if (confirm !== "ask") return setConfirm("ask");
            void purge({})
              .then(() => {
                setConfirm("done");
                void overview.refetch();
              })
              .catch(() => setConfirm("error"));
          }}
        />
      </SettingsGroup>
      {on && provider !== AUTO && !storedModel && (
        <Notice tone="info">{t("Pick a model to use this provider. Until then the stored choice stays: {choice}.", { choice: stored ? stored : autoLabel })}</Notice>
      )}
      <Problem text={prefs.problem} />
    </>
  );
}
