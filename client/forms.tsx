import { linearTeamValue } from "../shared/linear-ticket";
import { defaultSessionStartText, sessionStartMax, sessionStartValue } from "../shared/session-start";
import { enabledStatuses, laneName, projectLanes } from "../shared/lanes";
import { LaneEditor } from "./lane-editor";
import { useBoardView } from "./board-view";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useSettled } from "./motion";
import { perfLap } from "./perf";
import { Modal } from "./modal";
import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useResourcesQuery } from "./queries";
import { useProjectIndexQuery } from "./card-detail-query";
import * as rpc from "../shared/rpc";
import {
  priorities,
  taskTypes,
  taskTypeLabels,
  type TaskType,
  type Group,
  type Lane,
  type Project,
  type Task,
  type Status,
} from "../shared/model";
import { Theme, useTheme, Button, IconButton, Field, Choices, Notice, Label, Row, Actions, Toggle, message, basename, font, radius, space, relativeTime } from "./ui";
import { priorityLabels } from "./status";
import { isLegacyScope } from "../shared/scope";
import { AgentPicker, useAgentChoice, type AgentDefaults } from "./agent-choice";
import { ModelDefaultGroup } from "./model-default";
import { agentModelFromValues, type AgentModel } from "../shared/agent-defaults";
import { deliverySettings, deliverySettingsValues, modelSettings, modelSettingsValues } from "../shared/settings";
import { deliveryModeLabels, deliveryModeLocked, deliveryModes, isDeliveryMode, resolveDeliveryMode, type DeliveryMode } from "../shared/delivery-mode";
import { inheritLabel, inheritedDeliveryText, inheritedModelText } from "./group-settings-logic";
import { launchKanbanSession } from "./session";
import { ImageAttachments, useImageAttachments } from "./image-attach";
import { newMessageId, rememberSentImages } from "./sent-images";
import { DirectoryChooser } from "./directory-picker";
import { t, tn } from "../shared/i18n";
import { tagValues } from "../shared/tags";
import { autoReviewOf } from "../shared/auto-review";
import { AutoReviewSection, autoReviewPatch, type ReviewEdit } from "./review-settings";
import { TagEditor } from "./tag-input";
import { useStableCallback } from "./stable";
import { ExternalChip, ExternalPicker, connectionsByFamily, familyNames, pickKey, useConnections } from "./connectors";
import { BrandIcon } from "./brand-icons";
import { firstMessage } from "./first-message";
import { startStatus } from "./quick-task";
import type { Attachment } from "./web-images";
import { connectorFamilies, connectorLimits, familyOf, type ConnectorFamily, type ConnectorProvider, type ExternalSummary } from "../shared/connectors";

const newProjectReview: ReviewEdit = { on: true, rounds: "2" };
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * An existing project's settings being edited (BOARD-GROUPS-SPEC §5): the fields' state and one save, which sends
 * only what changed (`projects.update`, then the links). The project's revision is the one it opened with, so a
 * stale edit is refused.
 */
export function useProjectSettings(project: Project, withLanes = false) {
  const update = useRpc(rpc.updateProject),
    setLinks = useRpc(rpc.setProjectLinks);
  const stored = autoReviewOf(project);
  const storedDelivery = isDeliveryMode(project.deliveryMode) ? project.deliveryMode : null;
  const storedLinks = project.links?.map((l) => l.target) ?? [];
  // Whether What's new's Auto review preset was applied: kept here so collapsing and reopening a section doesn't redo it.
  const reviewPreset = useRef(false);
  const [title, setTitle] = useState(project.title),
    [description, setDescription] = useState(project.description || ""),
    [links, setLinkList] = useState<string[]>(storedLinks),
    [autoStatus, setAutoStatus] = useState(project.autoStatus !== false),
    [workpad, setWorkpad] = useState(project.workpad !== false),
    [workflowInsights, setWorkflowInsights] = useState(project.workflowInsights !== false),
    [memory, setMemory] = useState(project.memory !== false),
    [linearTicket, setLinearTicket] = useState(project.linearTicket === true),
    [linearTeam, setLinearTeam] = useState(project.linearTeam ?? ""),
    [review, setReview] = useState<ReviewEdit>({ on: stored.enabled, rounds: String(stored.maxRounds) }),
    [agentModel, setAgentModel] = useState<AgentModel | null>(project.agentModel ?? null),
    [deliveryMode, setDeliveryMode] = useState<DeliveryMode | null>(storedDelivery),
    [sessionStart, setSessionStart] = useState(project.sessionStartText ?? ""),
    [lanes, setLanes] = useState<Lane[]>(() => projectLanes(project)),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const patch = {
    ...(title !== project.title ? { title } : {}),
    ...(description !== (project.description || "") ? { description } : {}),
    ...(autoStatus !== (project.autoStatus !== false) ? { autoStatus } : {}),
    ...(workpad !== (project.workpad !== false) ? { workpad } : {}),
    ...(workflowInsights !== (project.workflowInsights !== false) ? { workflowInsights } : {}),
    ...(memory !== (project.memory !== false) ? { memory } : {}),
    ...(linearTicket !== (project.linearTicket === true) ? { linearTicket } : {}),
    ...(linearTeamValue(linearTeam) !== (project.linearTeam ?? "") ? { linearTeam: linearTeamValue(linearTeam) } : {}),
    ...(review.on !== stored.enabled || Number(review.rounds) !== stored.maxRounds ? { autoReview: autoReviewPatch(review) } : {}),
    // Only while groups are not ready (the project has no group): the per-project lanes path.
    ...(withLanes && JSON.stringify(lanes) !== JSON.stringify(projectLanes(project)) ? { lanes } : {}),
    ...(JSON.stringify(agentModel) !== JSON.stringify(project.agentModel ?? null) ? { agentModel } : {}),
    // An unknown stored mode shows as Inherit and is left as it is until another mode is chosen.
    ...(deliveryMode !== storedDelivery ? { deliveryMode } : {}),
    ...(sessionStartValue(sessionStart) !== (project.sessionStartText ?? "") ? { sessionStartText: sessionStartValue(sessionStart) } : {}),
  };
  const linksChanged = !!project.links && !sameList(links, storedLinks);
  const dirty = Object.keys(patch).length > 0 || linksChanged;
  const valid = !!title.trim() && (!project.links || links.length > 0);
  /** The saved project, or null when the save failed (the error is in `error`). */
  async function save(): Promise<Project | null> {
    setPending(true);
    setError("");
    try {
      let saved = await update({ id: project.id, revision: project.revision, title, description, ...patch });
      if (linksChanged) saved = await setLinks({ id: project.id, revision: saved.revision, links });
      return saved;
    } catch (e) {
      setError(message(e));
      return null;
    } finally {
      setPending(false);
    }
  }
  return {
    title, setTitle, description, setDescription, links, setLinkList, autoStatus, setAutoStatus, workpad, setWorkpad,
    workflowInsights, setWorkflowInsights, memory, setMemory, linearTicket, setLinearTicket, linearTeam, setLinearTeam,
    review, setReview, agentModel, setAgentModel, deliveryMode, setDeliveryMode, sessionStart, setSessionStart, lanes, setLanes,
    pending, error, dirty, valid, save, reviewPreset,
  };
}
export type ProjectSettingsState = ReturnType<typeof useProjectSettings>;

/**
 * The fields of an existing project's settings: Edit project and each project section of Group settings
 * (BOARD-GROUPS-SPEC §5). Empty defaults show what they inherit from the project's group and the host.
 */
export function ProjectSettingsFields({
  project,
  state,
  group,
  reviewOn,
  laneCounts,
}: {
  project: Project;
  state: ProjectSettingsState;
  /** The project's group, for what an empty default inherits. */
  group: Group | null;
  /** Opened from What's new to turn Auto review on: the section first, its switch on (GUARDRAILS-SPEC §10). */
  reviewOn?: boolean;
  /** Live cards per lane: given only while groups are not ready, when the project's own lanes are edited here. */
  laneCounts?: Partial<Record<Status, number>>;
}) {
  const s = state;
  const modelPrefs = useSettings(modelSettings);
  const hostModel = agentModelFromValues(modelPrefs.status === "ready" ? modelSettingsValues(modelPrefs.values) : null);
  const deliveryPrefs = useSettings(deliverySettings);
  const hostDelivery = deliveryPrefs.status === "ready" ? deliverySettingsValues(deliveryPrefs.values).defaultMode : undefined;
  const readFolder = useRpc(rpc.projectFolderState);
  const folder = useQuery({
    queryKey: ["flowly", "folder-state", project.id],
    queryFn: () => readFolder({ id: project.id }),
    staleTime: 0,
  });
  const reviewSection = <AutoReviewSection project={project} value={s.review} onChange={s.setReview} switchOn={reviewOn} applied={s.reviewPreset} />;
  return (
    <>
      {reviewOn && reviewSection}
      <Field title={t("Name")} value={s.title} onChange={s.setTitle} placeholder={t("Project name")} />
      <Field title={t("Description")} value={s.description} onChange={s.setDescription} multiline />
      {!project.links && <Field title={t("Paseo project root")} value={project.primaryPath} onChange={noop} editable={false} />}
      {!!project.links && <LinkList links={s.links} root={project.primaryPath} disabled={s.pending} onChange={s.setLinkList} />}
      {laneCounts && <LaneEditor lanes={s.lanes} counts={laneCounts} disabled={s.pending} onChange={s.setLanes} />}
      <ModelDefaultGroup
        title={t("Default model")}
        value={s.agentModel}
        disabled={s.pending}
        noneLabel={inheritLabel(inheritedModelText(group, hostModel))}
        onChange={s.setAgentModel}
      />
      <Choices
        title={t("Delivery mode")}
        value={s.deliveryMode ?? ""}
        options={[
          { value: "" as const, label: inheritLabel(inheritedDeliveryText(group, hostDelivery)), disabled: s.pending },
          ...deliveryModes.map((m) => ({ value: m, label: t(deliveryModeLabels[m]), disabled: s.pending })),
        ]}
        onChange={(next) => s.setDeliveryMode(next || null)}
      />
      <Field
        title={t("New session starting text")}
        value={s.sessionStart}
        onChange={s.setSessionStart}
        placeholder={defaultSessionStartText}
        maxLength={sessionStartMax}
        multiline
        editable={!s.pending}
      />
      {folder.data && (
        <View style={{ gap: 4 }}>
          <Label size={font.sm}>{t("Saved in project folder")}</Label>
          {folder.data.error ? (
            <Notice tone="warning">{t("The board could not be saved in {path}: {message}", { path: folder.data.path, message: folder.data.error })}</Notice>
          ) : (
            <Label muted size={font.sm}>
              {folder.data.savedAt ? t("{path}, saved {time}. Git ignores it unless you change .flowly/.gitignore.", { path: folder.data.path, time: relativeTime(folder.data.savedAt) }) : folder.data.path}
            </Label>
          )}
        </View>
      )}
      <Toggle title={t("Auto-update status in this project")} value={s.autoStatus} onChange={s.setAutoStatus} />
      <Toggle
        title={t("Card workpad")}
        detail={t("Agents keep an acceptance list on each card. Off hides it; what agents wrote is kept.")}
        value={s.workpad}
        onChange={s.setWorkpad}
      />
      {!reviewOn && reviewSection}
      <Toggle
        title={t("Make sure there's a Linear ticket")}
        detail={t("When a card has no Linear issue linked, its agent searches Linear first, creates a ticket if none fits and links it to the card. It uses the agent's own Linear tools; Flowly never writes to Linear.")}
        value={s.linearTicket}
        onChange={s.setLinearTicket}
      />
      {s.linearTicket && <Field title={t("Linear team")} value={s.linearTeam} onChange={s.setLinearTeam} placeholder={t("Team name or key (optional)")} />}
      <Toggle title={t("Skills")} value={s.workflowInsights} onChange={s.setWorkflowInsights} />
      <Toggle
        title={t("Guardrails")}
        detail={t("Learn from what you send cards back for, and check the next cards for it.")}
        value={s.memory}
        onChange={s.setMemory}
      />
      {!!s.error && <Notice>{s.error}</Notice>}
    </>
  );
}

const noop = () => {};

export function ProjectForm(props: {
  project?: Project;
  /** The group a new project is created in (BOARD-GROUPS-SPEC §2); the default group when absent. */
  groupId?: string;
  /** The project's group, for what its empty defaults inherit. */
  group?: Group | null;
  /** Opened from What's new to turn Auto review on: the section first, its switch on (GUARDRAILS-SPEC §10). */
  reviewOn?: boolean;
  /** Given only while board groups are not ready (their migration failed): Edit project then keeps the project's own lane editor. */
  laneCounts?: Partial<Record<Status, number>>;
  /** The board's Show archived view setting; edited here, stored with Save. */
  showArchived?: boolean;
  onShowArchived?: (next: boolean) => void;
  onClose: () => void;
  /** `restored`: the project came back from its folder's saved board. */
  onSaved: (id: string, restored?: { restored: number; title: string }) => void;
}) {
  // The project it opened with, kept while it is open.
  const [project] = useState(props.project);
  return project ? <EditProjectForm {...props} project={project} /> : <NewProjectForm groupId={props.groupId} onClose={props.onClose} onSaved={props.onSaved} />;
}

/** Edit project: the project settings fields in a dialog with one Save. */
function EditProjectForm({
  project,
  group = null,
  laneCounts,
  showArchived,
  onShowArchived,
  onClose,
  onSaved,
  reviewOn,
}: {
  project: Project;
  group?: Group | null;
  reviewOn?: boolean;
  laneCounts?: Partial<Record<Status, number>>;
  showArchived?: boolean;
  onShowArchived?: (next: boolean) => void;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const theme = useTheme();
  const state = useProjectSettings(project, !!laneCounts);
  const [archivedShown, setArchivedShown] = useState(!!showArchived);
  async function save() {
    const saved = await state.save();
    if (!saved) return;
    if (onShowArchived && archivedShown !== !!showArchived) onShowArchived(archivedShown);
    onSaved(saved.id);
  }
  return (
    <Modal
      open
      title={t("Edit project")}
      onOpenChange={(open) => {
        if (!open && !state.pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
        <View style={{ gap: 16 }}>
          <ProjectSettingsFields project={project} state={state} group={group} reviewOn={reviewOn} laneCounts={laneCounts} />
          {onShowArchived && <Toggle title={t("Show archived")} value={archivedShown} onChange={setArchivedShown} />}
          <Actions>
            <Button quiet disabled={state.pending} onPress={onClose}>
              {t("Cancel")}</Button>
            <Button primary disabled={state.pending || !state.valid} onPress={() => void save()}>
              {state.pending ? t("Saving…") : t("Save project")}
            </Button>
          </Actions>
        </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

/** New project: a directory, several repositories or an existing Paseo project; or a board restored from its folder. */
function NewProjectForm({
  groupId,
  onClose,
  onSaved,
}: {
  groupId?: string;
  onClose: () => void;
  onSaved: (id: string, restored?: { restored: number; title: string }) => void;
}) {
  const theme = useTheme();
  const toast = useToast();
  const create = useRpc(rpc.createProject),
    createLinked = useRpc(rpc.createLinkedProject),
    update = useRpc(rpc.updateProject),
    checkRestore = useRpc(rpc.restoreProjectCheck),
    restore = useRpc(rpc.restoreProject);
  const resources = useResourcesQuery();
  const [title, setTitle] = useState(""),
    [description, setDescription] = useState(""),
    [primaryPath, setPrimary] = useState(""),
    [nativeId, setNative] = useState(""),
    [source, setSource] = useState<"directory" | "linked" | "native">("directory"),
    [links, setLinkList] = useState<string[]>([]),
    // A new project starts with Auto review on (GUARDRAILS-SPEC §8, D1).
    [review, setReview] = useState<ReviewEdit>(newProjectReview),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [startEmpty, setStartEmpty] = useState(false);
  // A board saved in the chosen folder's .flowly can be restored (PROJECT-FOLDER-SPEC §3).
  const restorePath = useDebounced(source !== "linked" ? primaryPath.trim() : "", 400);
  const saved = useQuery({
    queryKey: ["flowly", "restore-check", restorePath],
    queryFn: () => checkRestore({ path: restorePath }),
    enabled: !!restorePath,
    staleTime: 0,
  });
  const found = restorePath && saved.data?.found ? saved.data : null;
  const restoring = !!found && !found.conflict && !startEmpty;
  async function save() {
    setPending(true);
    setError("");
    try {
      if (restoring) {
        const restored = await restore({ path: primaryPath });
        onSaved(restored.project.id, { restored: restored.cards, title: restored.project.title });
        return;
      }
      const result =
        source === "linked"
          ? await createLinked({ title, description, links })
          : await create({
              title,
              description,
              primaryPath,
              ...(groupId ? { groupId } : {}),
              ...(source === "native" && nativeId ? { paseoProjectId: nativeId } : {}),
            });
      // projects.create turns Auto review on with 2 rounds; anything else is saved right after.
      // The project exists now: a failed follow-up write must not leave the form open for a second Create.
      if (review.on !== newProjectReview.on || review.rounds !== newProjectReview.rounds)
        await update({ id: result.id, revision: result.revision, autoReview: autoReviewPatch(review) }).catch((e) =>
          toast.error(t("Project created, but Auto review was not saved: {error}", { error: message(e) })),
        );
      onSaved(result.id);
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <Modal
      open
      title={t("Create project")}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
        <View style={{ gap: 16 }}>
          {!restoring && <Field title={t("Name")} value={title} onChange={setTitle} placeholder={t("Project name")} />}
          {!restoring && (
            <Field
              title={t("Description")}
              value={description}
              onChange={setDescription}
              multiline
            />
          )}
          <Choices
            title={t("Project root")}
            value={source}
            options={[
              { value: "directory", label: t("Directory") },
              { value: "linked", label: t("Multiple repositories") },
              { value: "native", label: t("Existing Paseo project") },
            ]}
            onChange={(next) => {
              setSource(next);
              if (next !== "native") setNative("");
            }}
          />
          {source === "native" && (
            <Choices
              title={t("Paseo project")}
              hideTitle
              value={nativeId}
              options={(resources.data?.projects || []).map((p) => ({
                value: p.id,
                label: p.name,
              }))}
              onChange={(id) => {
                setNative(id);
                const p = resources.data?.projects.find((p) => p.id === id);
                if (p) setPrimary(p.path);
              }}
            />
          )}
          {source !== "linked" && (
            <Field
              title={t("Paseo project root")}
              value={primaryPath}
              onChange={setPrimary}
              editable={source === "directory"}
              placeholder={t("/absolute/path/to/directory")}
            />
          )}
          {source === "directory" && (
            <DirectoryChooser disabled={pending} onPick={(paths) => paths[0] && setPrimary(paths[0])} />
          )}
          {found && (
            <View style={{ gap: 8 }}>
              <Notice tone={found.conflict ? "warning" : "info"}>
                {found.conflict === "invalid"
                  ? t("The project file in this folder is invalid; it was left unchanged. A new, empty project can still be created here.")
                  : tn(found.cards, "This folder has a saved Flowly project: {title}, {n} card, saved {time}.", "This folder has a saved Flowly project: {title}, {n} cards, saved {time}.", { title: found.title, time: relativeTime(found.savedAt) })}
                {found.conflict === "on-board" ? ` ${t("It is already on the board.")}` : ""}
                {restoring && found.unbound
                  ? ` ${tn(found.unbound, "{n} card uses a workspace already on the board; it is restored without one.", "{n} cards use workspaces already on the board; they are restored without one.")}`
                  : ""}
              </Notice>
              {!found.conflict && (
                <Choices
                  title={t("Saved project")}
                  hideTitle
                  value={startEmpty ? "empty" : "restore"}
                  options={[
                    { value: "restore", label: t("Restore it") },
                    { value: "empty", label: t("Start empty") },
                  ]}
                  onChange={(next) => setStartEmpty(next === "empty")}
                />
              )}
            </View>
          )}
          {source === "linked" && <LinkList links={links} disabled={pending} onChange={setLinkList} />}
          {!restoring && <AutoReviewSection value={review} onChange={setReview} />}
          {source !== "linked" && (
            <Label muted size={font.sm}>
              {t("To work across several repositories, choose Multiple repositories, or use a common parent directory as the project root.")}</Label>
          )}
          {resources.error && <Notice>{message(resources.error)}</Notice>}
          {error && <Notice>{error}</Notice>}
          <Actions>
            <Button quiet disabled={pending} onPress={onClose}>
              {t("Cancel")}</Button>
            <Button
              primary
              disabled={
                pending ||
                (!restoring && !title.trim()) ||
                (!!restorePath && restorePath !== primaryPath.trim()) ||
                (source === "linked" ? !links.length : !primaryPath.trim()) ||
                (source === "native" && !nativeId)
              }
              onPress={() => void save()}
            >
              {pending ? t("Saving…") : restoring ? t("Restore project") : t("Create project")}
            </Button>
          </Actions>
        </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

/** Repositories of a linked multi-repo project (PROJECT-PICKER-SPEC §2). */
function LinkList({
  links,
  root,
  disabled,
  onChange,
}: {
  links: string[];
  root?: string;
  disabled: boolean;
  onChange(links: string[]): void;
}) {
  const [typed, setTyped] = useState("");
  const add = (paths: string[]) => {
    const next = [...links];
    for (const p of paths.map((p) => p.trim()).filter(Boolean)) if (!next.includes(p)) next.push(p);
    onChange(next);
  };
  return (
    <View style={{ gap: space[2] }}>
      <Label medium size={font.sm} muted>
        {t("Repositories")}</Label>
      {links.length === 0 && (
        <Label muted size={font.sm}>
          {t("Add the repositories or folders this project works across.")}</Label>
      )}
      {links.map((path) => (
        <View key={path} style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Label lines={1}>{basename(path)}</Label>
            <Label muted mono lines={1} size={font.sm}>
              {path}
            </Label>
          </View>
          <IconButton
            icon="X"
            label={t("Remove {basename}", { basename: basename(path) })}
            disabled={disabled || links.length <= (root ? 1 : 0)}
            onPress={() => onChange(links.filter((l) => l !== path))}
          />
        </View>
      ))}
      <DirectoryChooser multiple disabled={disabled} onPick={add} />
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space[2] }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Field title={t("Or type a path")} value={typed} onChange={setTyped} placeholder={t("/absolute/path/to/repo")} />
        </View>
        <Button
          disabled={disabled || !typed.trim()}
          onPress={() => {
            add([typed]);
            setTyped("");
          }}
        >
          {t("Add")}</Button>
      </View>
      <Label muted size={font.sm}>
        {root
          ? t("Links live in {root}. Removing one deletes only the link, never the repository.", { root })
          : t("Kanban creates a new folder with a link to each of these and registers it as the Paseo project. Cards use directory workspaces.")}
      </Label>
    </View>
  );
}

/** A new task prefilled from an idea (IDEAS-SPEC §6) or following up a card (CARD-LINKS-SPEC §5.5). */
export type TaskSeed = {
  ideaId?: string;
  /** From a workflow-insights suggestion (WORKFLOW-INSIGHTS-SPEC §5.2). */
  insightFindingId?: string;
  followUpOf?: string;
  followUpTitle?: string;
  title: string;
  description: string;
  type?: TaskType;
  priority?: Task["priority"];
  tags?: string[];
  /** Items attached from a service, e.g. Start card on the Linear board (LINEAR-BOARD-SPEC §5). */
  externals?: { item: ExternalSummary; provider: ConnectorProvider }[];
  /** Start an agent now for this form only; the remembered on/off setting stays as it is. */
  startAgent?: boolean;
  /** From Quick task's More options (QUICK-TASK-SPEC §1): the typed text as the Instruction, its workspace mode and images. */
  prompt?: string;
  mode?: "directory" | "worktree";
  images?: readonly Attachment[];
  /** The agent chosen in Quick task, in place of the board's defaults. */
  agent?: AgentDefaults;
};

export function TaskForm({
  hostId,
  boardTasks,
  project,
  task: initialTask,
  seed,
  defaultStatus = "todo",
  onClose,
  onSaved,
  agentDefaults,
  group = null,
}: {
  hostId: string;
  /** Every card the board knows (its overview), for workspaces already bound in other projects. */
  boardTasks: readonly Task[];
  project: Project;
  task?: Task;
  seed?: TaskSeed;
  defaultStatus?: Status;
  onClose: () => void;
  /** `launch` reports the optional first agent started with a new task. */
  onSaved: (id: string, launch?: { sessionId?: string; error?: string }, status?: Status) => void;
  agentDefaults?: AgentDefaults;
  /** The project's group: its delivery mode default applies when neither the card nor the project has one. */
  group?: Group | null;
}) {
  const theme = useTheme();
  const [task] = useState(initialTask);
  const create = useRpc(rpc.createTask),
    update = useRpc(rpc.updateTask);
  const settled = useSettled("task-form");
  const ready = settled;
  useEffect(() => perfLap("task-form.open", "task-form.open.mount"), []);
  useEffect(() => {
    if (ready) perfLap("task-form.open", "task-form.open.settled", true);
  }, [ready]);
  // This project's cards, tags and external items; never the whole board (LOADING-R2-SPEC §2B).
  const index = useProjectIndexQuery(hostId, project.id, ready);
  const [title, setTitle] = useState(task?.title || seed?.title || ""),
    [description, setDescription] = useState(task?.description || seed?.description || ""),
    [status, setStatus] = useState<Status>(task?.status || startStatus(project, defaultStatus)),
    [priority, setPriority] = useState(task?.priority || seed?.priority || "normal"),
    [type, setType] = useState<TaskType | "">(task?.type || seed?.type || ""),
    // What the form opened with: a save applies only the difference (CARD-TAGS-SPEC §2.5).
    [tagsBase] = useState(() => (task ? tagValues(task) : [])),
    [tags, setTags] = useState<string[]>(() => (task ? tagValues(task) : seed?.tags || [])),
    [mode, setMode] = useState<"directory" | "worktree" | "existing">(
      () => (seed?.mode === "worktree" && !project.links ? "worktree" : "directory"),
    ),
    [workspaceId, setWorkspace] = useState(""),
    [branchName, setBranch] = useState(""),
    [baseRef, setBase] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  // The card's delivery mode, seeded from its stored mode, else its project's, its group's, then the Settings default
  // (BOARD-GROUPS-SPEC §5), until chosen here. Editable until the card has delivered (been in review, committed or
  // integrated), then shown read-only for good (DELIVERY-MODE-SPEC §2).
  const deliveryPrefs = useSettings(deliverySettings);
  const [deliveryChoice, setDeliveryChoice] = useState<DeliveryMode | null>(null);
  const deliveryDefault = deliveryPrefs.status === "ready" ? deliverySettingsValues(deliveryPrefs.values).defaultMode : "branch";
  const deliverySeed = resolveDeliveryMode({ card: task?.deliveryMode, project: project.deliveryMode, group: group?.defaults?.deliveryMode, host: deliveryDefault }).mode;
  const delivery = deliveryChoice ?? deliverySeed;
  const deliveryLocked = !!task && deliveryModeLocked(task);
  // Opt out of the project's Linear ticket ask (LINEAR-TICKET-SPEC §5); the switch shows only while the project asks.
  const [linearOff, setLinearOff] = useState(task?.linearTicket === false);
  // From… (EXTERNAL-TRACKER-SPEC §5, CONNECTORS-SPEC §8.2): items added as inputs with the new card.
  const resources = useResourcesQuery({ enabled: ready && !task && mode === "existing" });
  const connections = useConnections(ready && !task);
  const byFamily = useMemo(() => connectionsByFamily(connections.data?.connections || []), [connections.data]);
  const [externals, setExternals] = useState<{ item: ExternalSummary; provider: ConnectorProvider }[]>(() => (task ? [] : seed?.externals || [])),
    [picking, setPicking] = useState<ConnectorFamily | null>(null);
  // The title the last pick filled in: a later pick may replace it only while it is unchanged.
  const prefilled = useRef(!task && seed?.externals?.length ? seed.title : "");
  const pickExternal = useStableCallback((item: ExternalSummary, provider: ConnectorProvider) => {
    const id = pickKey(familyOf(provider), item.key);
    setExternals((current) => (current.some((x) => pickKey(familyOf(x.provider), x.item.key) === id) ? current : [...current, { item, provider }]));
    setPicking(null);
    if (!title.trim() || title === prefilled.current) {
      setTitle(item.summary);
      prefilled.current = item.summary;
    }
  });
  const externalKeys = useMemo(() => new Set(externals.map((x) => pickKey(familyOf(x.provider), x.item.key))), [externals]);
  // Items other cards of this project already reference (shown, still choosable).
  const externalUse = useMemo(() => {
    const used = new Map<string, string>();
    const titles = new Map((index.data?.cards || []).filter((x) => !x.archivedAt).map((x) => [x.id, x.title]));
    for (const x of index.data?.externals || [])
      if (titles.has(x.taskId)) used.set(pickKey(familyOf(x.provider), x.key), titles.get(x.taskId)!);
    return used;
  }, [index.data]);
  const [operationId] = useState(
    () => `card-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  // Optional first agent for a new task (remembered on/off choice).
  const view = useBoardView();
  const [startAgent, setStartAgentState] = useState<boolean | null>(seed?.startAgent ?? null);
  const startChosen = !task && (startAgent ?? view.values?.startAgentOnCreate ?? true);
  const setStartAgent = (next: boolean) => {
    setStartAgentState(next);
    if (view.values && view.values.startAgentOnCreate !== next) void view.update({ startAgentOnCreate: next });
  };
  const choice = useAgentChoice({ enabled: ready && startChosen, cwd: project.primaryPath, defaults: seed?.agent ?? agentDefaults });
  // The project's lanes. New tasks start in an active lane (finished ones only
  // when added from that lane); an edited card keeps showing its current lane.
  const lanes = enabledStatuses(project);
  const statusChoices = task
    ? lanes.includes(task.status) ? lanes : [...lanes, task.status]
    : lanes.filter((s) => (s !== "done" && s !== "cancelled") || s === defaultStatus);
  // The agent's first message; never prefilled from the title or description (they already reach it as context), only
  // with the text typed in Quick task when its More options opened this form. Required
  // unless items from a service are attached: then an empty box sends a default that points at them (UI-REFRESH-SPEC §7s).
  const [prompt, setPrompt] = useState(seed?.prompt ?? "");
  const firstText = firstMessage(prompt, externals.map((x) => x.item));
  // Images with the agent's first message (web: paste, drop or Add images).
  const attachments = useImageAttachments(seed?.images);
  const [firstMessageId] = useState(newMessageId);
  const contextRead = useRpc(rpc.taskContext),
    prepare = useRpc(rpc.prepareSession),
    paseo = usePaseo();
  const eligible = (resources.data?.workspaces || []).filter((w) =>
    !w.background && w.repoPaths.includes(project.primaryPath),
  );
  const suggestions = useMemo(() => (index.data?.tags || []).map((s) => s.tag), [index.data]);
  const agentTags = useMemo(
    () => new Set((task?.tags || []).filter((x) => x.by === "agent").map((x) => x.tag)),
    [task],
  );
  const addTags = useStableCallback((values: string[]) => setTags((current) => [...current, ...values.filter((v) => !current.includes(v))]));
  const removeTag = useStableCallback((tag: string) => setTags((current) => current.filter((x) => x !== tag)));
  async function save() {
    setPending(true);
    setError("");
    try {
      const result = task
        ? await update({
            id: task.id,
            revision: task.revision,
            // Only a changed title: an untouched one must not undo a quick task's AI title (QUICK-TASK-SPEC §4).
            ...(title !== task.title ? { title } : {}),
            description,
            status,
            priority,
            type: type || null,
            ...(sameList(tags, tagsBase) ? {} : { tags, tagsBase }),
            // Only a mode the user changed here: an untouched one keeps following the defaults chain.
            ...(deliveryChoice !== null && !deliveryLocked && deliveryChoice !== deliverySeed ? { deliveryMode: deliveryChoice } : {}),
            ...(linearOff !== (task.linearTicket === false) ? { linearTicket: !linearOff } : {}),
          })
        : await create({
            projectId: project.id,
            operationId,
            title,
            description,
            status,
            priority,
            type: type || undefined,
            ...(tags.length ? { tags } : {}),
            // The shown mode is stored as the card's own (DELIVERY-MODE-SPEC §2).
            deliveryMode: delivery,
            ...(linearOff ? { linearTicket: false } : {}),
            mode,
            workspaceId: mode === "existing" ? workspaceId : undefined,
            baseRef,
            branchName,
            ...(seed?.ideaId ? { ideaId: seed.ideaId } : {}),
            ...(seed?.insightFindingId ? { insightFindingId: seed.insightFindingId } : {}),
            ...(seed?.followUpOf ? { followUpOf: seed.followUpOf } : {}),
            ...(externals.length
              ? { externals: externals.map((x) => ({ connectionId: x.item.connectionId, key: x.item.key, itemType: x.item.itemType })) }
              : {}),
          });
      if (task) return onSaved(result.id, undefined, result.status);
      if (!startChosen) return onSaved(result.id);
      try {
        const session = await launchKanbanSession({ paseo, contextRead, prepare }, result, {
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
        onSaved(result.id, { sessionId: session.id });
      } catch (e) {
        // The card exists; report and let the user start the agent from the drawer.
        onSaved(result.id, { error: message(e) });
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  }
  const canSave =
    ready &&
    !pending &&
    !!title.trim() &&
    !(!task && mode === "existing" && !workspaceId) &&
    !(startChosen && (!choice.ready || firstText === null));
  // Enter submits, Shift+Enter is a new line.
  const submit = canSave ? () => void save() : undefined;
  return (
    <Modal
      open
      title={task ? t("Edit task") : seed?.ideaId ? t("Create task from idea") : seed?.followUpOf ? t("Create follow-up task") : t("Create task")}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
        <View style={{ gap: 16 }}>
          {!!seed?.followUpTitle && (
            <Label muted size={font.sm} lines={1}>{t("Follow-up of {title}", { title: seed.followUpTitle })}</Label>
          )}
          <Field title={t("Title")} value={title} onChange={setTitle} placeholder={t("What needs doing?")} onSubmit={submit} />
          <Field
            title={t("Description")}
            value={description}
            onChange={setDescription}
            multiline
            onSubmit={submit}
          />
          {ready ? <>
          {!task && byFamily.size > 0 && (
            <View style={{ gap: space[2] }}>
              {externals.map((x) => (
                <ExternalChip
                  key={`${x.item.connectionId}:${x.item.key}`}
                  item={x.item}
                  provider={x.provider}
                  onRemove={() => setExternals((current) => current.filter((y) => !(y.item.connectionId === x.item.connectionId && y.item.key === x.item.key)))}
                />
              ))}
              {picking ? (
                <ExternalPicker
                  family={picking}
                  connections={byFamily.get(picking) || []}
                  projectId={project.id}
                  picked={externalKeys}
                  usedBy={externalUse}
                  onPick={pickExternal}
                  onClose={() => setPicking(null)}
                />
              ) : (
                externals.length < connectorLimits.perCreate && (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
                    {connectorFamilies
                      .filter((family) => byFamily.has(family))
                      .map((family) => (
                        <Button key={family} leading={<BrandIcon family={family} size={14} />} small onPress={() => setPicking(family)}>
                          {t("From {service}", { service: familyNames[family] })}
                        </Button>
                      ))}
                  </View>
                )
              )}
            </View>
          )}
          <Choices
            title={t("Status")}
            value={status}
            // New tasks start in an active column (finished ones only when added from that column).
            options={statusChoices.map((s) => ({ value: s, label: laneName(project, s) }))}
            onChange={setStatus}
          />
          <Choices
            title={t("Priority")}
            value={priority}
            options={priorities.map((p) => ({ value: p, label: priorityLabels[p] }))}
            onChange={setPriority}
          />
          <Choices
            title={t("Delivery")}
            value={delivery}
            options={deliveryModes.map((m) => ({ value: m, label: t(deliveryModeLabels[m]), disabled: deliveryLocked }))}
            onChange={setDeliveryChoice}
          />
          {project.linearTicket === true && (
            <Toggle title={t("Make sure there's a Linear ticket")} value={!linearOff} onChange={(on) => setLinearOff(!on)} />
          )}
          <Choices
            title={t("Type")}
            value={type}
            options={[
              { value: "" as const, label: t("None") },
              ...taskTypes.map((t) => ({ value: t, label: taskTypeLabels[t] })),
            ]}
            onChange={setType}
          />
          <View style={{ gap: space[1.5] }}>
            <Label medium size={font.sm} muted>
              {t("Tags")}
            </Label>
            <TagEditor
              tags={tags}
              agentTags={agentTags}
              suggestions={suggestions}
              onAdd={addTags}
              onRemove={removeTag}
            />
          </View>
          <Label muted size={font.sm}>
            {t("Project root · {path}", { path: project.primaryPath })}
            {project.links ? ` · ${t("links {names}", { names: project.links.map((l) => l.name).join(", ") })}` : ""}
          </Label>
          {task && isLegacyScope(task, project) && (
            <Notice tone="info">
              {t("Legacy card scope is preserved: {paths}. Its directories and workspace stay linked.", { paths: (task.repoPaths.length ? task.repoPaths : project.repos).join(", ") })}
            </Notice>
          )}
          {!task && (
            <>
              <Choices
                title={t("Workspace")}
                value={mode}
                options={[
                  { value: "directory", label: t("New in directory") },
                  { value: "worktree", label: t("New isolated worktree"), disabled: !!project.links },
                  { value: "existing", label: t("Link existing") },
                ]}
                onChange={setMode}
              />
              {mode === "worktree" && (
                <Label muted size={font.sm}>
                  {t("The project root itself must be a Git repository. For two child repositories under a common directory, choose a directory workspace.")}</Label>
              )}
              {mode === "existing" && (
                <>
                  <View style={{ gap: 6 }}>
                    <Label medium size={font.sm} muted>
                      {t("Existing workspace")}</Label>
                    {eligible.length > 0 && (
                      <View
                        style={{
                          padding: 4,
                          gap: 2,
                          borderRadius: radius.lg,
                          borderWidth: 1,
                          borderColor: theme.colors.border,
                        }}
                      >
                        {eligible.map((w) => {
                          const bound = boardTasks.some((t) => t.workspaceId === w.id) || !!index.data?.cards.some((t) => t.workspaceId === w.id);
                          return (
                            <Row
                              key={w.id}
                              title={w.name}
                              detail={`${basename(project.primaryPath)} · ${w.owner}${bound ? ` · ${t("already bound")}` : ""}`}
                              label={t("Existing workspace: {name}", { name: w.name })}
                              icon="FolderGit2"
                              selected={workspaceId === w.id}
                              disabled={bound}
                              onPress={() => setWorkspace(w.id)}
                            />
                          );
                        })}
                      </View>
                    )}
                  </View>
                  {!!workspaceId && (
                    <Label muted size={font.sm}>
                      {`${eligible.find((w) => w.id === workspaceId)?.path} · ${t("native owner is preserved")}`}
                    </Label>
                  )}
                  {eligible.length === 0 && (
                    <Notice tone="info">
                      {t("No available workspace under this Paseo project root. Create one or register a matching directory/worktree in Paseo.")}</Notice>
                  )}
                </>
              )}
              {mode === "worktree" && (
                <>
                  <Field
                    title={t("Base ref (optional)")}
                    value={baseRef}
                    onChange={setBase}
                    placeholder={t("Current branch of the project root")}
                  />
                  <Field
                    title={t("New branch (optional)")}
                    value={branchName}
                    onChange={setBranch}
                    placeholder={t("Leave empty to generate kanban/<title>-xxxxxx")}
                  />
                </>
              )}
            </>
          )}
          {!task && (
            <View style={{ gap: 12 }}>
              <Toggle
                title={t("Start an agent now")}                value={startChosen}
                onChange={setStartAgent}
              />
              {startChosen && (
                <>
                  <AgentPicker choice={choice} disabled={pending} />
                  <ImageAttachments state={attachments} disabled={pending}>
                    <Field
                      title={t("Instruction")}
                      value={prompt}
                      onChange={setPrompt}
                      multiline
                      placeholder={externals.length ? t("Optional: the agent starts with the attached items") : t("What should the agent do first?")}
                      onSubmit={submit}                    />
                  </ImageAttachments>
                </>
              )}
            </View>
          )}
          </> : <Label muted>{t("Loading…")}</Label>}
          {resources.error && <Notice>{message(resources.error)}</Notice>}
          {error && <Notice>{error}</Notice>}
          <Actions>
            <Button quiet disabled={pending} onPress={onClose}>
              {t("Cancel")}</Button>
            <Button
              primary
              icon={startChosen ? "Play" : undefined}
              disabled={!canSave}
              onPress={() => void save()}
            >
              {pending ? (startChosen ? t("Starting…") : t("Saving…")) : task ? t("Save task") : startChosen ? t("Create and start") : t("Create task")}
            </Button>
          </Actions>
        </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

/** The value after it has been stable for `delay` ms. */
function useDebounced<T>(value: T, delay: number) {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return current;
}
