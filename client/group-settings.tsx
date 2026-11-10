import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import * as rpc from "../shared/rpc";
import { groupLimits, type Group, type Project, type Status } from "../shared/model";
import { agentModelFromValues, type AgentModel } from "../shared/agent-defaults";
import { deliverySettings, deliverySettingsValues, modelSettings, modelSettingsValues } from "../shared/settings";
import { deliveryModeLabels, deliveryModes, isDeliveryMode, type DeliveryMode } from "../shared/delivery-mode";
import { dispatcherProviderSupported } from "../shared/dispatcher";
import { t } from "../shared/i18n";
import { Modal } from "./modal";
import { Actions, Button, Field, Notice, Theme, message, space, useTheme } from "./ui";
import { SettingRow, SettingSelect, SettingSwitch, SettingsGroup } from "./settings-ui";
import { Collapse, Disclosure } from "./disclosure";
import { ModelDefaultGroup } from "./model-default";
import { ProjectSettingsFields, useProjectSettings } from "./forms";
import { useStableCallback } from "./stable";
import { currentRevision, groupChoices, groupMembersOf, inheritLabel, inheritedDeliveryText, inheritedDispatcherText, inheritedModelText, needsDiscardConfirm, shownGroup, withDirty } from "./group-settings-logic";

type GroupDefaultsEdit = { agentModel?: AgentModel | null; deliveryMode?: DeliveryMode | null; dispatcherModel?: AgentModel | null };

/**
 * Group settings (BOARD-GROUPS-SPEC §5): the group's name, the Default flag, its defaults (new-card model, delivery
 * mode, dispatcher model), its member projects with a move to another group, one section per project, Add group and
 * Delete group…. `groupId` null opens on Add group; a created group opens here. Each project's section also offers
 * Restore (archived projects) and Remove…, which the project switcher had before group tabs (3/7).
 */
export function GroupSettings({
  groupId: initialId,
  groups,
  projects,
  laneCounts,
  focusProjectId,
  reviewOn,
  onClose,
  onChanged,
  onRemoveProject,
}: {
  groupId: string | null;
  /** The board's groups and projects (archived ones too), from the overview. */
  groups: readonly Group[];
  projects: readonly Project[];
  /** Live cards per lane of a project, so lanes in use can't be turned off. */
  laneCounts(projectId: string): Partial<Record<Status, number>>;
  /** A project whose section opens expanded (from its tab menu, the toolbar or What's new). */
  focusProjectId?: string;
  /** Opened from What's new to turn Auto review on in `focusProjectId` (GUARDRAILS-SPEC §10). */
  reviewOn?: boolean;
  onClose(): void;
  /** After a write: the board rereads its overview. */
  onChanged(): void;
  /** Remove…: the board closes this page and opens its Remove project dialog. */
  onRemoveProject(project: Project): void;
}) {
  const theme = useTheme();
  const toast = useToast();
  const update = useRpc(rpc.updateGroup),
    remove = useRpc(rpc.deleteGroup),
    setProjectGroup = useRpc(rpc.setProjectGroup),
    updateProject = useRpc(rpc.updateProject);
  const modelPrefs = useSettings(modelSettings);
  const models = modelPrefs.status === "ready" ? modelSettingsValues(modelPrefs.values) : null;
  const hostModel = agentModelFromValues(models);
  const deliveryPrefs = useSettings(deliverySettings);
  const hostDelivery = deliveryPrefs.status === "ready" ? deliverySettingsValues(deliveryPrefs.values).defaultMode : undefined;
  const [groupId, setGroupId] = useState(initialId);
  // Groups this page wrote (or created) last: newer than the overview until it catches up.
  const [written, setWritten] = useState<Record<string, Group>>({});
  const listed = groupId ? groups.find((g) => g.id === groupId) : undefined;
  // Once the overview has listed the open group, its absence means it is gone, not that the overview is behind.
  const seen = useRef(new Set<string>());
  if (listed) seen.current.add(listed.id);
  const group = shownGroup(listed, groupId ? written[groupId] : undefined, !!groupId && seen.current.has(groupId));
  const current = useRef(group);
  current.current = group;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [adding, setAdding] = useState(initialId === null),
    [deleting, setDeleting] = useState(false);
  // Projects with unsaved edits, and the leave (close, move, delete) waiting for the user's answer.
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const reportDirty = useStableCallback((projectId: string, isDirty: boolean) => setDirty((all) => withDirty(all, projectId, isDirty)));
  const guard = (action: () => void) => (needsDiscardConfirm(dirty) ? setLeave(() => action) : action());
  // The newest project and the revisions section saves returned, so a move never sends a stale revision.
  const latestProjects = useRef(projects);
  latestProjects.current = projects;
  const savedRevisions = useRef<Record<string, number>>({});
  const projectSaved = (saved: Project) => {
    savedRevisions.current[saved.id] = Math.max(savedRevisions.current[saved.id] ?? 0, saved.revision);
    onChanged();
  };
  const moveProject = (p: Project, to: string) =>
    write(async () => {
      const live = latestProjects.current.find((x) => x.id === p.id) ?? p;
      await setProjectGroup({ projectId: p.id, revision: currentRevision(live, savedRevisions.current[p.id]), groupId: to });
    });
  // Restore, as the project switcher does: archiving was folded into Remove; older archived projects can still come back.
  const restoreProject = (p: Project) =>
    write(async () => {
      const live = latestProjects.current.find((x) => x.id === p.id) ?? p;
      const saved = await updateProject({ id: p.id, revision: currentRevision(live, savedRevisions.current[p.id]), archived: false });
      savedRevisions.current[saved.id] = Math.max(savedRevisions.current[saved.id] ?? 0, saved.revision);
    });
  const removeProject = (p: Project) => guard(() => onRemoveProject(latestProjects.current.find((x) => x.id === p.id) ?? p));
  // Gone (deleted elsewhere): nothing left to show.
  useEffect(() => {
    if (groupId && !group) onClose();
  }, [groupId, !group]);
  // One write at a time, each with the revision the last one returned.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const write = (op: (group: Group) => Promise<Group | void>) => {
    queue.current = queue.current.then(async () => {
      const target = current.current;
      if (!target) return;
      setBusy(true);
      setError("");
      try {
        const next = await op(target);
        if (next) {
          current.current = next;
          setWritten((all) => ({ ...all, [next.id]: next }));
        }
        onChanged();
      } catch (e) {
        setError(message(e));
        // A refused write (e.g. a revision conflict): read again so the stored revision refreshes.
        onChanged();
      } finally {
        setBusy(false);
      }
    });
  };
  const setDefaults = (defaults: GroupDefaultsEdit) => write((g) => update({ id: g.id, revision: g.revision, defaults }));
  const open = (next: Group) => {
    setWritten((all) => ({ ...all, [next.id]: next }));
    setGroupId(next.id);
    setAdding(false);
    setDeleting(false);
    setError("");
    onChanged();
  };
  const fallback = groups.find((g) => g.isDefault);
  const members = group ? groupMembersOf(projects, group.id) : [];
  const choices = groupChoices(groups.some((g) => g.id === group?.id) || !group ? groups : [...groups, group]);
  return (
    <Modal
      open
      title={group ? t("Group settings") : t("Add group")}
      onOpenChange={(next) => {
        if (!next && !busy) guard(onClose);
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: space[5] }}>
            {group && (
              <>
                <SettingsGroup>
                  <View style={{ padding: space[3] }}>
                    <GroupName
                      key={group.id}
                      name={group.name}
                      onRename={(name) => write((g) => (name === g.name ? Promise.resolve() : update({ id: g.id, revision: g.revision, name })))}
                    />
                  </View>
                  <SettingSwitch
                    title={t("Default group")}
                    detail={t("New projects join it.")}
                    value={!!group.isDefault}
                    disabled={busy || !!group.isDefault}
                    onChange={(on) => on && write((g) => update({ id: g.id, revision: g.revision, isDefault: true }))}
                  />
                </SettingsGroup>
                <ModelDefaultGroup
                  title={t("Default model")}
                  value={group.defaults?.agentModel ?? null}
                  disabled={busy}
                  noneLabel={inheritLabel(inheritedModelText(null, hostModel))}
                  onChange={(agentModel) => setDefaults({ agentModel })}
                />
                <SettingsGroup>
                  <SettingSelect
                    title={t("Delivery mode")}
                    value={isDeliveryMode(group.defaults?.deliveryMode) ? group.defaults.deliveryMode : ""}
                    placeholder={inheritLabel(inheritedDeliveryText(null, hostDelivery))}
                    disabled={busy}
                    options={[
                      { value: "", label: inheritLabel(inheritedDeliveryText(null, hostDelivery)) },
                      ...deliveryModes.map((m) => ({ value: m as string, label: t(deliveryModeLabels[m]) })),
                    ]}
                    onChange={(next) => setDefaults({ deliveryMode: isDeliveryMode(next) ? next : null })}
                  />
                </SettingsGroup>
                <ModelDefaultGroup
                  title={t("Dispatcher model")}
                  value={group.defaults?.dispatcherModel ?? null}
                  disabled={busy}
                  noneLabel={inheritLabel(inheritedDispatcherText(models?.dispatcherModel))}
                  onChange={(dispatcherModel) => setDefaults({ dispatcherModel })}
                  allowProvider={dispatcherProviderSupported}
                  invalidText={t("The dispatcher runs only on Claude: on other providers Flowly can't keep it from answering cards' questions and permission requests. Choose a Claude model for the dispatcher in Settings → Models.")}
                />
                {members.length > 0 && (
                  <SettingsGroup title={t("Projects")}>
                    {members.map((p) => (
                      <SettingSelect
                        key={p.id}
                        title={p.title}
                        detail={p.archivedAt ? t("Archived") : undefined}
                        value={group.id}
                        placeholder={group.name}
                        disabled={busy}
                        options={choices}
                        onChange={(to) => to !== group.id && guard(() => moveProject(p, to))}
                      />
                    ))}
                  </SettingsGroup>
                )}
                {members.map((p) => (
                  <ProjectSection
                    key={p.id}
                    project={p}
                    group={group}
                    laneCounts={laneCounts(p.id)}
                    initiallyOpen={p.id === focusProjectId}
                    reviewOn={reviewOn && p.id === focusProjectId}
                    busy={busy}
                    onSaved={projectSaved}
                    onDirty={reportDirty}
                    onRestore={() => restoreProject(p)}
                    onRemove={() => removeProject(p)}
                  />
                ))}
              </>
            )}
            {!!error && <Notice>{error}</Notice>}
            {leave && (
              <View style={{ gap: space[3] }}>
                <Notice tone="warning">{t("Discard unsaved changes?")}</Notice>
                <Actions>
                  <Button quiet onPress={() => setLeave(null)}>
                    {t("Keep editing")}
                  </Button>
                  <Button
                    danger
                    onPress={() => {
                      const action = leave;
                      setLeave(null);
                      action();
                    }}
                  >
                    {t("Discard")}
                  </Button>
                </Actions>
              </View>
            )}
            <SettingsGroup>
              {group && (
                <SettingRow
                  title={t("Add group")}
                  disabled={busy || groups.length >= groupLimits.groups}
                  state={{ expanded: adding }}
                  onPress={() => setAdding(!adding)}
                  trailing={<Icon name={adding ? "ChevronUp" : "Plus"} size={16} />}
                />
              )}
              <Collapse open={adding} id="group-add">
                <AddGroup onCreated={open} onCancel={group ? () => setAdding(false) : onClose} />
              </Collapse>
              {group && !group.isDefault && (
                <SettingRow
                  title={t("Delete group…")}
                  disabled={busy}
                  state={{ expanded: deleting }}
                  onPress={() => setDeleting(!deleting)}
                  trailing={<Icon name="Trash2" size={16} />}
                />
              )}
              {group && !group.isDefault && (
                <Collapse open={deleting} id="group-delete">
                  <View style={{ padding: space[3], gap: space[3] }}>
                    <Notice tone="warning">
                      {t("Delete {name}? Its projects move to {group}. Its dispatcher, if it has one, is archived.", { name: group.name, group: fallback?.name ?? t("the default group") })}
                    </Notice>
                    <Actions>
                      <Button quiet disabled={busy} onPress={() => setDeleting(false)}>
                        {t("Cancel")}
                      </Button>
                      <Button
                        danger
                        disabled={busy}
                        onPress={() =>
                          guard(() =>
                            write(async (g) => {
                              await remove({ id: g.id, revision: g.revision });
                              toast.show(t("Group {name} deleted", { name: g.name }), { variant: "success" });
                              onClose();
                            }),
                          )
                        }
                      >
                        {t("Delete group")}
                      </Button>
                    </Actions>
                  </View>
                </Collapse>
              )}
            </SettingsGroup>
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

/** The group's name, saved a moment after typing stops; an empty name is not saved. */
function GroupName({ name, onRename }: { name: string; onRename(name: string): void }) {
  // The field owns its text; the stored name only seeds it.
  const [seed] = useState(name);
  return (
    <Field
      title={t("Name")}
      value={seed}
      placeholder={t("Group name")}
      commitDelay={600}
      maxLength={groupLimits.name}
      onChange={(next) => {
        const trimmed = next.trim();
        if (trimmed) onRename(trimmed);
      }}
    />
  );
}

/** A new group's name and Add group; the created group opens. */
function AddGroup({ onCreated, onCancel }: { onCreated(group: Group): void; onCancel(): void }) {
  const create = useRpc(rpc.createGroup);
  const [name, setName] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError("");
    try {
      onCreated(await create({ name: trimmed }));
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <View style={{ padding: space[3], gap: space[3] }}>
      <Field title={t("Group name")} value={name} onChange={setName} maxLength={groupLimits.name} onSubmit={name.trim() ? () => void submit() : undefined} />
      {!!error && <Notice>{error}</Notice>}
      <Actions>
        <Button quiet disabled={pending} onPress={onCancel}>
          {t("Cancel")}
        </Button>
        <Button primary disabled={pending || !name.trim()} onPress={() => void submit()}>
          {pending ? t("Saving…") : t("Add group")}
        </Button>
      </Actions>
    </View>
  );
}

/**
 * One member project's settings, collapsed under its name, with its own Save and Cancel. The edit state lives outside
 * the collapsible body, so collapsing keeps unsaved edits.
 */
function ProjectSection({
  project,
  group,
  laneCounts,
  initiallyOpen,
  reviewOn,
  busy,
  onSaved,
  onDirty,
  onRestore,
  onRemove,
}: {
  project: Project;
  group: Group;
  laneCounts: Partial<Record<Status, number>>;
  initiallyOpen: boolean;
  reviewOn?: boolean;
  /** A page write (move, restore) is running. */
  busy: boolean;
  onSaved(project: Project): void;
  onDirty(projectId: string, dirty: boolean): void;
  onRestore(): void;
  onRemove(): void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  // The project the fields were seeded from; a save or Cancel seeds them again.
  const [base, setBase] = useState(project);
  const [epoch, setEpoch] = useState(0);
  const latest = project.revision > base.revision ? project : base;
  const reseed = (next: Project) => {
    setBase(next);
    setEpoch((n) => n + 1);
  };
  return (
    <ProjectEditor
      key={`${base.id}:${epoch}`}
      project={base}
      title={latest.title}
      archived={!!latest.archivedAt}
      latestRevision={latest.revision}
      group={group}
      laneCounts={laneCounts}
      reviewOn={reviewOn && epoch === 0}
      open={open}
      onOpen={setOpen}
      onSaved={(saved) => {
        reseed(saved);
        onSaved(saved);
      }}
      onDirty={onDirty}
      onReseed={() => reseed(latest)}
      busy={busy}
      onRestore={onRestore}
      onRemove={onRemove}
    />
  );
}

function ProjectEditor({
  project,
  title,
  archived,
  latestRevision,
  group,
  laneCounts,
  reviewOn,
  open,
  onOpen,
  onSaved,
  onReseed,
  onDirty,
  busy,
  onRestore,
  onRemove,
}: {
  project: Project;
  title: string;
  archived: boolean;
  latestRevision: number;
  group: Group;
  laneCounts: Partial<Record<Status, number>>;
  reviewOn?: boolean;
  open: boolean;
  onOpen(open: boolean): void;
  onSaved(project: Project): void;
  onReseed(): void;
  onDirty(projectId: string, dirty: boolean): void;
  busy: boolean;
  onRestore(): void;
  onRemove(): void;
}) {
  const state = useProjectSettings(project);
  // Report unsaved edits to the page; an unmounted editor (moved, reseeded) has none.
  useEffect(() => {
    onDirty(project.id, state.dirty);
  }, [state.dirty]);
  useEffect(() => () => onDirty(project.id, false), []);
  // Changed elsewhere while untouched here: show the newer project.
  useEffect(() => {
    if (!state.dirty && !state.pending && latestRevision > project.revision) onReseed();
  }, [latestRevision, state.dirty, state.pending]);
  return (
    <Disclosure title={title} summary={archived ? t("Archived") : undefined} open={open} onChange={onOpen}>
      <View style={{ gap: 16 }}>
        <ProjectSettingsFields project={project} state={state} group={group} laneCounts={laneCounts} reviewOn={reviewOn} />
        <Actions>
          <Button quiet disabled={state.pending || !state.dirty} onPress={onReseed}>
            {t("Cancel")}
          </Button>
          <Button
            primary
            disabled={state.pending || !state.dirty || !state.valid}
            onPress={() =>
              void state.save().then((saved) => {
                if (saved) onSaved(saved);
              })
            }
          >
            {state.pending ? t("Saving…") : t("Save project")}
          </Button>
        </Actions>
        <SettingsGroup>
          {archived && (
            <SettingRow
              title={t("Restore {title}", { title })}
              // Save or cancel first: a restore changes the revision these fields would save with.
              disabled={busy || state.pending || state.dirty}
              onPress={onRestore}
              trailing={<Icon name="ArchiveRestore" size={16} />}
            />
          )}
          <SettingRow
            title={t("Remove “{title}”…", { title })}
            disabled={busy || state.pending}
            onPress={onRemove}
            trailing={<Icon name="Trash2" size={16} />}
          />
        </SettingsGroup>
      </View>
    </Disclosure>
  );
}
