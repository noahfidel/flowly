import { useState } from "react";
import { View } from "react-native";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import * as rpc from "../shared/rpc";
import type { Project, Status } from "../shared/model";
import { t } from "../shared/i18n";
import { provisionalTitle, quickTitleText } from "../shared/quick-task";
import { Modal } from "./modal";
import { Theme, useTheme, Button, Field, Notice, Actions, message, space } from "./ui";
import { PickerGroup, PickerRow } from "./picker";
import { AgentPicker, useAgentChoice, type AgentDefaults } from "./agent-choice";
import { launchKanbanSession } from "./session";
import { ImageAttachments, useImageAttachments } from "./image-attach";
import { newMessageId, rememberSentImages } from "./sent-images";
import { useBoardView } from "./board-view";
import { quickMode, startStatus, type QuickMode } from "./quick-task";
import type { TaskSeed } from "./forms";

/** What More options… hands to the full Create task form (QUICK-TASK-SPEC §1). */
export type QuickTaskMore = { projectId: string; status: Status; seed: TaskSeed };

/**
 * Quick task (docs/QUICK-TASK-SPEC.md): one sentence, Enter, and a card with its agent starts. The card is created
 * through the same `tasks.create` call and the session through the same `launchKanbanSession` as the full form.
 */
export function QuickTaskForm({
  projects,
  initialProjectId,
  defaultStatus = "todo",
  agentDefaultsFor,
  onClose,
  onMore,
  onSaved,
}: {
  /** Live projects the task can go to. */
  projects: readonly Project[];
  initialProjectId: string;
  defaultStatus?: Status;
  /** The agent the full form would start with in that project (MODEL-DEFAULTS-SPEC). */
  agentDefaultsFor: (project: Project) => AgentDefaults;
  onClose: () => void;
  onMore: (more: QuickTaskMore) => void;
  onSaved: (projectId: string, taskId: string, launch: { sessionId?: string; error?: string }) => void;
}) {
  const theme = useTheme();
  const view = useBoardView();
  const create = useRpc(rpc.createTask),
    quickTitle = useRpc(rpc.quickTaskTitle),
    contextRead = useRpc(rpc.taskContext),
    prepare = useRpc(rpc.prepareSession),
    paseo = usePaseo();
  const [projectId, setProjectId] = useState(initialProjectId),
    [text, setText] = useState(""),
    [modeChoice, setModeChoice] = useState<QuickMode | null>(null),
    [open, setOpen] = useState<"project" | "agent" | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  const mode = project ? quickMode(project, modeChoice ?? view.values?.quickTaskMode ?? "worktree") : "directory";
  const choice = useAgentChoice({ enabled: !!project, cwd: project?.primaryPath, defaults: project ? agentDefaultsFor(project) : null });
  const attachments = useImageAttachments();
  const [firstMessageId] = useState(newMessageId);
  const [operationId] = useState(() => `card-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const chooseProject = (id: string) => {
    setOpen(null);
    if (id === projectId) return;
    const next = projects.find((p) => p.id === id);
    setProjectId(id);
    // The agent follows the new project's defaults (QUICK-TASK-SPEC §1).
    if (next) choice.reset(agentDefaultsFor(next));
  };
  const modelName = (choice.models.data?.models || []).find((m) => m.id === choice.chosenModel)?.label || choice.chosenModel;
  async function save() {
    if (!project) return;
    setPending(true);
    setError("");
    const title = provisionalTitle(text);
    try {
      const created = await create({
        projectId: project.id,
        operationId,
        title,
        description: "",
        status: startStatus(project, defaultStatus),
        priority: "normal",
        mode,
        baseRef: "",
        branchName: "",
      });
      if (view.values && view.values.lastQuickProjectId !== project.id) void view.update({ lastQuickProjectId: project.id });
      // Not awaited: the provisional title stays if this fails or the setting is off (§4). The run reads at most
      // QUICK_TEXT_MAX characters, so a longer paste is cut here rather than refused by the RPC's input limit.
      if (view.values?.quickTaskAiTitle ?? true) void quickTitle({ taskId: created.id, text: quickTitleText(text), provisionalTitle: title }).catch(() => undefined);
      try {
        const session = await launchKanbanSession({ paseo, contextRead, prepare }, created, {
          provider: choice.provider,
          model: choice.chosenModel,
          mode: choice.chosenMode,
          thinking: choice.chosenThinking,
          ...(choice.featureValues ? { featureValues: choice.featureValues } : {}),
          prompt: text,
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
  const canSave = !!project && !pending && !!text.trim() && choice.ready;
  // Enter submits, Shift+Enter is a new line.
  const submit = canSave ? () => void save() : undefined;
  const more = () =>
    project &&
    onMore({
      projectId: project.id,
      status: defaultStatus,
      seed: {
        title: provisionalTitle(text),
        description: "",
        prompt: text,
        startAgent: true,
        mode,
        images: attachments.list(),
        agent: { provider: choice.provider, model: choice.chosenModel, mode: choice.chosenMode, thinking: choice.chosenThinking, speed: choice.chosenSpeed },
      },
    });
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
              <Field title={t("What do you want done?")} value={text} onChange={setText} multiline autoFocus onSubmit={submit} />
            </ImageAttachments>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
              <Button small icon="Folder" label={`${t("Project")}: ${project?.title || ""}`} disabled={pending || projects.length < 2} onPress={() => setOpen(open === "project" ? null : "project")}>
                {project?.title || ""}
              </Button>
              <Button small icon="Bot" label={`${t("Agent")}: ${choice.provider}${modelName ? ` · ${modelName}` : ""}`} disabled={pending || !project} onPress={() => setOpen(open === "agent" ? null : "agent")}>
                {modelName ? `${choice.provider} · ${modelName}` : choice.provider}
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
            </View>
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
