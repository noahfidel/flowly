import { useState } from "react";
import { View } from "react-native";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import * as rpc from "../shared/rpc";
import type { Project, Status } from "../shared/model";
import { t } from "../shared/i18n";
import { quickTitleText } from "../shared/quick-task";
import type { ConnectorProvider, ExternalSummary } from "../shared/connectors";
import { Modal } from "./modal";
import { Theme, useTheme, Button, Field, Label, Notice, Actions, Row, font, message, space } from "./ui";
import { PickerGroup, PickerRow } from "./picker";
import { AgentPicker, useAgentChoice, type AgentDefaults } from "./agent-choice";
import { launchKanbanSession } from "./session";
import { ImageAttachments, useImageAttachments } from "./image-attach";
import { newMessageId, rememberSentImages } from "./sent-images";
import { useBoardView } from "./board-view";
import { quickCard, quickCreateInput, quickMode, quickMoreSeed, quickPrompt, startStatus, type QuickMode, type QuickTaskSeed } from "./quick-task";
import type { OtherOption } from "./idea-choice";
import { cardBlockLabel, ideaStepIcon, ideaStepLabel } from "./task-ideas";
import { ExternalChip } from "./connectors";
import type { TaskSeed } from "./forms";

/** What More options… hands to the full Create task form (QUICK-TASK-SPEC §1). */
export type QuickTaskMore = { projectId: string; status: Status; seed: TaskSeed };

/** A Quick task picks its own permission mode (plan when offered, QUICK-TASK-SPEC §1): the remembered one is not carried over. */
const quickDefaults = (defaults: AgentDefaults): AgentDefaults => (defaults ? { ...defaults, mode: "" } : defaults);

/**
 * Quick task (docs/QUICK-TASK-SPEC.md): one sentence, Enter, and a card with its agent starts. The card is created
 * through the same `tasks.create` call and the session through the same `launchKanbanSession` as the full form.
 */
export function QuickTaskForm({
  projects,
  initialProjectId,
  defaultStatus = "todo",
  seed,
  agentDefaultsFor,
  onClose,
  onMore,
  onSaved,
  otherOptions,
  onOther,
}: {
  /** Live projects the task can go to. */
  projects: readonly Project[];
  initialProjectId: string;
  defaultStatus?: Status;
  /** Opened from an external item (Linear's Start card): attached, titled by it, and the text is optional. From an idea: prefilled and made from it (§10). */
  seed?: QuickTaskSeed;
  /** The agent the full form would start with in that project (MODEL-DEFAULTS-SPEC). */
  agentDefaultsFor: (project: Project) => AgentDefaults;
  onClose: () => void;
  onMore: (more: QuickTaskMore) => void;
  onSaved: (projectId: string, taskId: string, launch: { sessionId?: string; error?: string }) => void;
  /** From an idea: Other options…, the choices that skip Quick task (§10); the caller closes the dialog and runs one. */
  otherOptions?: readonly OtherOption[];
  onOther?: (option: OtherOption) => void;
}) {
  const theme = useTheme();
  const view = useBoardView();
  const create = useRpc(rpc.createTask),
    quickTitle = useRpc(rpc.quickTaskTitle),
    contextRead = useRpc(rpc.taskContext),
    prepare = useRpc(rpc.prepareSession),
    paseo = usePaseo();
  const [projectId, setProjectId] = useState(initialProjectId),
    [text, setText] = useState(seed?.text ?? ""),
    [externals, setExternals] = useState<{ item: ExternalSummary; provider: ConnectorProvider }[]>(() => seed?.externals || []),
    [modeChoice, setModeChoice] = useState<QuickMode | null>(null),
    [open, setOpen] = useState<"project" | "agent" | "other" | "send" | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  const mode = project ? quickMode(project, modeChoice ?? view.values?.quickTaskMode ?? "worktree") : "directory";
  const choice = useAgentChoice({ enabled: !!project, cwd: project?.primaryPath, defaults: project ? quickDefaults(agentDefaultsFor(project)) : null, planFirst: true });
  const attachments = useImageAttachments();
  const [firstMessageId] = useState(newMessageId);
  const [operationId] = useState(() => `card-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const chooseProject = (id: string) => {
    setOpen(null);
    if (id === projectId) return;
    const next = projects.find((p) => p.id === id);
    setProjectId(id);
    // The agent follows the new project's defaults (QUICK-TASK-SPEC §1).
    if (next) choice.reset(quickDefaults(agentDefaultsFor(next)));
  };
  const items = externals.map((x) => x.item);
  const firstText = quickPrompt(text, items);
  const modelName = (choice.models.data?.models || []).find((m) => m.id === choice.chosenModel)?.label || choice.chosenModel;
  const modeLabel = choice.chosenMode ? (choice.modes.data?.modes || []).find((m) => m.id === choice.chosenMode)?.label || choice.chosenMode : "";
  const agentText = [choice.provider, modelName, modeLabel].filter(Boolean).join(" · ");
  async function save() {
    if (!project) return;
    setPending(true);
    setError("");
    const { title, aiTitle } = quickCard(text, seed, externals.length);
    try {
      // From an idea it carries `ideaId`, so the daemon accepts the idea in the same write (§10).
      const created = await create(quickCreateInput({ projectId: project.id, operationId, text, seed, externals, status: startStatus(project, defaultStatus), mode }));
      if (view.values && view.values.lastQuickProjectId !== project.id) void view.update({ lastQuickProjectId: project.id });
      // Not awaited: the provisional title stays if this fails or the setting is off (§4). The run reads at most
      // QUICK_TEXT_MAX characters, so a longer paste is cut here rather than refused by the RPC's input limit.
      // An attached issue already names the card, so no AI title runs for it.
      if (aiTitle && (view.values?.quickTaskAiTitle ?? true)) void quickTitle({ taskId: created.id, text: quickTitleText(text), provisionalTitle: title }).catch(() => undefined);
      try {
        const session = await launchKanbanSession({ paseo, contextRead, prepare }, created, {
          provider: choice.provider,
          model: choice.chosenModel,
          mode: choice.chosenMode,
          thinking: choice.chosenThinking,
          ...(choice.featureValues ? { featureValues: choice.featureValues } : {}),
          prompt: firstText ?? "",
          ...(attachments.attachments.length ? { images: attachments.images(), clientMessageId: firstMessageId } : {}),
          operationId: `first-session-${operationId}`,
        });
        if (attachments.attachments.length) rememberSentImages(firstMessageId, attachments.uris());
        onSaved(project.id, created.id, { sessionId: session.id });
      } catch (e) {
        // The card exists; report and let the user start the agent from the card.
        onSaved(project.id, created.id, { error: message(e) });
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  }
  const canSave = !!project && !pending && firstText !== null && choice.ready;
  // Enter submits, Shift+Enter is a new line.
  const submit = canSave ? () => void save() : undefined;
  const more = () => {
    if (!project) return;
    onMore({
      projectId: project.id,
      status: defaultStatus,
      seed: {
        ...quickMoreSeed({ text, seed, externals, mode }),
        images: attachments.list(),
        agent: { provider: choice.provider, model: choice.chosenModel, mode: choice.chosenMode, thinking: choice.chosenThinking, speed: choice.chosenSpeed },
      },
    });
  };
  return (
    <Modal
      open
      title={t("Quick task")}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: space[4] }}>
            <ImageAttachments state={attachments} disabled={pending}>
              <Field
                title={t("What do you want done?")}
                value={text}
                onChange={setText}
                multiline
                autoFocus
                placeholder={externals.length ? t("Optional: the agent starts with the attached issue") : ""}
                onSubmit={submit}
              />
            </ImageAttachments>
            {externals.map((x) => (
              <ExternalChip
                key={`${x.item.connectionId}:${x.item.key}`}
                item={x.item}
                provider={x.provider}
                onRemove={() => !pending && setExternals((current) => current.filter((y) => y !== x))}
              />
            ))}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
              <Button small icon="Folder" label={`${t("Project")}: ${project?.title || ""}`} disabled={pending || projects.length < 2} onPress={() => setOpen(open === "project" ? null : "project")}>
                {project?.title || ""}
              </Button>
              <Button small icon="Bot" label={`${t("Agent")}: ${agentText}`} disabled={pending || !project} onPress={() => setOpen(open === "agent" ? null : "agent")}>
                {agentText}
              </Button>
              <Button
                small
                icon={mode === "worktree" ? "GitBranch" : "Folder"}
                label={`${t("Workspace")}: ${mode === "worktree" ? t("Worktree") : t("Directory")}`}
                disabled={pending || !project || !!project.links}
                onPress={() => setModeChoice(mode === "worktree" ? "directory" : "worktree")}
              >
                {mode === "worktree" ? t("Worktree") : t("Directory")}
              </Button>
              <Button small quiet disabled={pending || !project} onPress={more}>
                {t("More options…")}
              </Button>
              {!!otherOptions?.length && onOther && (
                <Button small quiet disabled={pending} onPress={() => setOpen(open === "other" || open === "send" ? null : "other")}>
                  {t("Other options…")}
                </Button>
              )}
            </View>
            {(open === "other" || open === "send") && otherOptions && onOther && (
              <OtherOptions options={otherOptions} sending={open === "send"} disabled={pending} onSend={() => setOpen("send")} onPick={onOther} />
            )}
            {open === "project" && (
              <PickerGroup>
                <PickerRow
                  first
                  open
                  title={t("Project")}
                  icon="Folder"
                  value={project?.id || ""}
                  placeholder={t("Project")}
                  options={projects.map((p) => ({ value: p.id, label: p.title }))}
                  onToggle={() => setOpen(null)}
                  onChange={chooseProject}
                />
              </PickerGroup>
            )}
            {open === "agent" && <AgentPicker choice={choice} disabled={pending} />}
            {error && <Notice>{error}</Notice>}
            <Actions>
              <Button quiet disabled={pending} onPress={onClose}>
                {t("Cancel")}
              </Button>
              <Button primary icon="Play" disabled={!canSave} onPress={() => void save()}>
                {pending ? t("Starting…") : t("Create and start")}
              </Button>
            </Actions>
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

/**
 * Other options… (§10): in place, like the Project picker, since the board's menus cannot show over a dialog.
 * Send to another session… turns the list into the live sessions.
 */
function OtherOptions({
  options,
  sending,
  disabled,
  onSend,
  onPick,
}: {
  options: readonly OtherOption[];
  sending: boolean;
  disabled: boolean;
  onSend(): void;
  onPick(option: OtherOption): void;
}) {
  const send = options.find((o) => o.kind === "send-other");
  if (sending && send?.kind === "send-other")
    return (
      <PickerGroup>
        {send.sessions.map((s) => (
          <Row
            key={s.id}
            title={s.title || t("this card's session")}
            icon={s.id === send.current?.id ? "Check" : "MessageSquare"}
            disabled={disabled}
            onPress={() => onPick({ kind: "continue", session: s, suggested: false })}
          />
        ))}
      </PickerGroup>
    );
  return (
    <PickerGroup>
      {options.map((option) =>
        option.kind === "note" ? (
          <View key="note" style={{ paddingHorizontal: space[3], paddingVertical: space[2] }}>
            <Label muted size={font.sm}>{cardBlockLabel(option.blocked)}</Label>
          </View>
        ) : option.kind === "form" ? (
          <Row key="form" title={t("Open the full form")} icon="SquarePlus" disabled={disabled} onPress={() => onPick(option)} />
        ) : (
          <Row
            key={option.kind}
            title={ideaStepLabel(option)}
            icon={ideaStepIcon(option)}
            disabled={disabled}
            onPress={() => (option.kind === "send-other" ? onSend() : onPick(option))}
          />
        ),
      )}
    </PickerGroup>
  );
}
