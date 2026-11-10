import { memo, useEffect, useMemo, useState } from "react";
import { Image, Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { Artifact, ArtifactRole, Task } from "../shared/model";
import { artifactGroups, artifactsOf, baseName } from "../shared/artifacts";
import { Modal } from "./modal";
import { IdeaRow, useExitList } from "./task-ideas";
import { useTaskDetail, invalidateCardViews } from "./card-detail-query";
import { SessionMarkdown } from "./session-content";
import { PagedRows, Section, ShowMore, pageSize, type SectionState } from "./disclosure";
import { FocusTarget, Marked, limitFor, useFocusTarget, useMark } from "./drawer-focus";
import { AiMark, Actions, Button, Choices, Field, IconButton, Label, Notice, Theme, font, message, space, touch, useTheme, noFocusRing } from "./ui";
import { t, tn } from "../shared/i18n";
import { BrandIcon } from "./brand-icons";
import { ExternalPreview, LinkExternal, connectionsByFamily, pickKey, itemKindLabel, linkTitles, useConnections } from "./connectors";
import { connectorFamilies, familyOf, itemTypeOf, type ConnectorFamily } from "../shared/connectors";
import { eventPoint, useMenuOpener, type MenuEntry } from "./context-menu";
import { useSettingsOpener } from "./settings-opener";

/** Rows shown per group at first, and added by each Show more (CARD-ARTIFACTS-SPEC §5.2). */
const firstPage: Record<ArtifactRole, number> = { input: pageSize, output: pageSize };

/**
 * Drawer "Artifacts" (CARD-ARTIFACTS-SPEC §5.2): the card's inputs and outputs,
 * each marked as added by you or by an agent. Files open a read-only preview,
 * links open in the browser. Removing is optimistic and never touches the file.
 */
export function TaskArtifacts({ task, active, disabled, section }: { task: Task; active: boolean; disabled: boolean; section: SectionState }) {
  const { detail } = useTaskDetail();
  const toast = useToast();
  const queryClient = useQueryClient();
  const deleteArtifact = useRpc(rpc.deleteArtifact);
  const readStatus = useRpc(rpc.artifactStatus);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<Artifact | "new" | null>(null);
  const [previewing, setPreviewing] = useState<Artifact | null>(null);
  const [linking, setLinking] = useState<ConnectorFamily | null>(null);
  const connections = useConnections();
  const byFamily = useMemo(() => connectionsByFamily(connections.data?.connections || []), [connections.data]);
  const readExternals = useRpc(rpc.cardExternals);
  const openMenu = useMenuOpener();
  const openSettings = useSettingsOpener();
  // Per opening of the sidebar: Show more only adds rows, closing and reopening starts over.
  const [limit, setLimit] = useState(firstPage);
  useEffect(() => {
    if (active) setLimit(firstPage);
  }, [active]);
  const list = useMemo(
    () => (detail ? artifactsOf(detail.artifacts, task.id).filter((a) => !removing.has(a.id)) : []),
    [detail, task.id, removing],
  );
  // A search hit on an artifact past the first page shows the pages up to it (DRAWER-SPEC "Focus from search").
  const focusTarget = useFocusTarget();
  useEffect(() => {
    if (!focusTarget.startsWith("artifact:")) return;
    const target = list.find((a) => a.id === focusTarget.slice("artifact:".length));
    if (!target) return;
    const at = list.filter((a) => a.role === target.role).indexOf(target);
    setLimit((current) => ({ ...current, [target.role]: limitFor(at, current[target.role], pageSize) }));
  }, [focusTarget, list]);
  const fileKey = list.filter((a) => a.kind === "file").map((a) => `${a.id}:${a.target}`).join("|");
  // One batched check when the drawer shows the card or its files change (CARD-ARTIFACTS-SPEC §9).
  const status = useQuery({
    queryKey: ["flowly", "artifact-status", task.id, fileKey],
    queryFn: () => readStatus({ taskId: task.id }),
    enabled: !!fileKey,
    staleTime: 30_000,
    retry: false,
  });
  const missing = useMemo(() => new Set(status.data?.missing || []), [status.data]);
  // External statuses for the rows, cached by the daemon (EXTERNAL-TRACKER-SPEC §3.3).
  const externalKey = list.filter((a) => a.external).map((a) => a.id).join("|");
  const externalStatus = useQuery({
    queryKey: ["flowly", "card-externals", task.id, externalKey],
    queryFn: () => readExternals({ taskId: task.id }),
    enabled: !!externalKey,
    staleTime: 60_000,
    retry: false,
  });
  const statuses = useMemo(() => {
    const map = new Map((externalStatus.data?.items || []).map((x) => [x.artifactId, x.summary.status || x.summary.container]));
    // A removed connection reads as such instead of a status (EXTERNAL-TRACKER-SPEC §2).
    for (const id of externalStatus.data?.removed || []) map.set(id, t("Connection removed"));
    return map;
  }, [externalStatus.data]);
  const linkedKeys = useMemo(() => new Set(list.flatMap((a) => (a.external ? [pickKey(familyOf(a.external.provider), a.external.key)] : []))), [list]);
  // One + for every way to add an input (CONNECTORS-SPEC §8.1).
  const addEntries = (): MenuEntry[] => {
    const services: MenuEntry[] = connectorFamilies
      .filter((family) => byFamily.has(family))
      .map((family) => ({ id: family, label: `${t(linkTitles[family])}…`, leading: <BrandIcon family={family} size={16} />, onPress: () => setLinking(family) }));
    const missing = connectorFamilies.some((family) => !byFamily.has(family));
    return [
      { id: "file", label: t("File or link…"), icon: "Link", onPress: () => setEditing("new") },
      ...(services.length ? [{ kind: "separator" as const, id: "services" }, ...services] : []),
      ...(missing && openSettings
        ? [{ kind: "separator" as const, id: "more" }, { id: "connect", label: t("Connect another service…"), icon: "PlugZap", onPress: () => openSettings("connections") }]
        : []),
    ];
  };
  const rows = useExitList(list);
  const remove = async (artifact: Artifact) => {
    setRemoving((current) => new Set(current).add(artifact.id));
    try {
      await deleteArtifact({ id: artifact.id });
      await invalidateCardViews(queryClient);
      toast.show(t("Artifact removed. The file was not changed."), { variant: "success" });
    } catch (e) {
      toast.show(message(e), { variant: "error" });
    } finally {
      setRemoving((current) => {
        const next = new Set(current);
        next.delete(artifact.id);
        return next;
      });
    }
  };
  const openArtifact = (artifact: Artifact) => {
    if (artifact.external) return setPreviewing(artifact);
    if (artifact.kind === "url")
      return void openExternalUrl(artifact.target).catch(() => toast.show(t("Could not open the link."), { variant: "error" }));
    setPreviewing(artifact);
  };
  return (
    <>
    <Section
      id={task.id}
      focusId="artifacts"
      title={t("Artifacts")}
      count={list.length}
      empty={!rows.length}
      open={section.open}
      onToggle={section.onToggle}
      actions={
        <>
          <IconButton
            icon="Plus"
            label={t("Add an artifact: a file, link, or an item from a connected service")}
            disabled={disabled}
            onPress={(event) => {
              const entries = addEntries();
              // Nothing to choose between: straight to the file or link form.
              if (!openMenu || entries.length === 1) return setEditing("new");
              openMenu(eventPoint(event), t("Add artifact"), entries);
            }}
          />
        </>
      }
    >
      {artifactGroups.map((group) => {
        const own = rows.filter((r) => r.item.role === group.role);
        if (!own.length) return null;
        const rest = own.length - limit[group.role];
        return (
          <View key={group.role} style={{ gap: 2 }}>
            <Label muted size={font.xs} bold selectable={false}>{t(group.title)}</Label>
            <PagedRows items={own} limit={limit[group.role]} render={(row) => (
              <IdeaRow key={row.item.id} leaving={row.leaving} entering={row.entering} spacing={0}>
                <FocusTarget id={`artifact:${row.item.id}`}>
                <ArtifactRow
                  artifact={row.item}
                  missing={missing.has(row.item.id)}
                  externalStatus={statuses.get(row.item.id)}
                  disabled={disabled || row.leaving}
                  onOpen={openArtifact}
                  onEdit={setEditing}
                  onRemove={remove}
                />
                </FocusTarget>
              </IdeaRow>
            )} />
            {rest > 0 && (
              <ShowMore
                count={Math.min(pageSize, rest)}
                onPress={() => setLimit((current) => ({ ...current, [group.role]: current[group.role] + pageSize }))}
              />
            )}
          </View>
        );
      })}
    </Section>
      {editing && <ArtifactForm task={task} artifact={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {previewing &&
        (previewing.external ? (
          <ExternalPreview artifact={previewing} onClose={() => setPreviewing(null)} />
        ) : (
          <ArtifactPreview artifact={previewing} onClose={() => setPreviewing(null)} />
        ))}
      {linking && (
        <LinkExternal
          taskId={task.id}
          projectId={task.projectId}
          family={linking}
          linked={linkedKeys}
          connections={byFamily.get(linking) || []}
          onClose={() => setLinking(null)}
        />
      )}
    </>
  );
}

const ArtifactRow = memo(function ArtifactRow({
  artifact,
  missing,
  externalStatus,
  disabled,
  onOpen,
  onEdit,
  onRemove,
}: {
  artifact: Artifact;
  missing: boolean;
  /** The item's current status (reference only) or its space, for external inputs. */
  externalStatus?: string;
  disabled: boolean;
  onOpen(artifact: Artifact): void;
  onEdit(artifact: Artifact): void;
  onRemove(artifact: Artifact): void;
}) {
  const { colors } = useTheme();
  // A search hit on this row unclips it and adds the full link or path (DRAWER-SPEC "Focus from search" 7).
  const mark = useMark(`artifact:${artifact.id}`);
  const agent = artifact.createdBy === "agent";
  const source = agent ? t("Added by an agent") : t("Added by you");
  const role = artifact.role === "input" ? t("Input") : t("Output");
  const external = artifact.external;
  const detail = external
    ? [itemKindLabel(external.provider, itemTypeOf(external)), externalStatus, artifact.note].filter(Boolean).join(" · ")
    : artifact.note || (artifact.kind === "url" ? hostOf(artifact.target) : artifact.target);
  const icon = artifact.kind === "url" ? "Link" : /\/$|^\.\/$/.test(artifact.target) || !/\.[^/]+$/.test(baseName(artifact.target)) ? "Folder" : "FileText";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1], minHeight: touch ? 44 : 34 }}>
      <Pressable
        accessibilityRole={artifact.kind === "url" && !artifact.external ? "link" : "button"}
        accessibilityLabel={`${role}: ${artifact.title}, ${source}${missing ? `, ${t("missing")}` : ""}`}
        onPress={() => onOpen(artifact)}
        style={({ pressed }) => ({ ...noFocusRing, flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space[1.5], opacity: pressed ? 0.7 : 1 })}
      >
        {external ? <BrandIcon family={familyOf(external.provider)} size={14} /> : <Icon name={icon} size={14} color={missing ? colors.foregroundMuted : colors.foreground} />}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label size={font.md} muted={missing} lines={mark ? undefined : 1} selectable={false}><Marked text={artifact.title} terms={mark?.terms} /></Label>
          <Label size={font.sm} muted lines={mark ? undefined : 1} selectable={false}>
            {missing && `${t("Missing")} · `}
            <Marked text={detail} terms={mark?.terms} />
          </Label>
          {!!mark && detail !== artifact.target && (
            <Label size={font.sm} muted mono selectable={false}><Marked text={artifact.target} terms={mark.terms} /></Label>
          )}
        </View>
        {agent ? <AiMark size={12} /> : <Icon name="User" size={12} color={colors.foregroundMuted} />}
      </Pressable>
      <IconButton icon="Pencil" size={touch ? 36 : 24} label={t("Edit artifact: {title}", { title: artifact.title })} disabled={disabled} onPress={() => onEdit(artifact)} />
      <IconButton icon="X" size={touch ? 36 : 24} label={t("Remove artifact: {title}", { title: artifact.title })} disabled={disabled} onPress={() => onRemove(artifact)} />
    </View>
  );
});

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const roleChoices = (): { value: ArtifactRole; label: string }[] => [
  { value: "input", label: t("Input") },
  { value: "output", label: t("Output") },
];

/** Add or edit an artifact (CARD-ARTIFACTS-SPEC §5.3). The target is fixed once added. */
function ArtifactForm({ task, artifact, onClose }: { task: Task; artifact: Artifact | null; onClose(): void }) {
  const theme = useTheme();
  const toast = useToast();
  const queryClient = useQueryClient();
  const create = useRpc(rpc.createArtifact);
  const update = useRpc(rpc.updateArtifact);
  const [role, setRole] = useState<ArtifactRole>(artifact?.role ?? "input");
  const [target, setTarget] = useState(artifact?.target ?? "");
  const [title, setTitle] = useState(artifact?.title ?? "");
  const [note, setNote] = useState(artifact?.note ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const ready = !pending && !!target.trim();
  const submit = async () => {
    if (!ready) return;
    setPending(true);
    setError("");
    try {
      if (artifact) await update({ id: artifact.id, updatedAt: artifact.updatedAt, role, title, note });
      else await create({ taskId: task.id, role, target, title, note });
      await invalidateCardViews(queryClient);
      toast.show(artifact ? t("Artifact saved") : t("Artifact added"), { variant: "success" });
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal open title={artifact ? t("Edit artifact") : t("Add artifact")} onOpenChange={(open) => !open && !pending && onClose()}>
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: space[3] }}>
            {!!error && <Notice tone="danger">{error}</Notice>}
            <Choices title={t("Role")} value={role} options={roleChoices()} onChange={setRole} />
            <Field
              title={t("Path or link")}
              value={target}
              onChange={setTarget}
              editable={!artifact}
              autoFocus={!artifact && !touch}
              placeholder={t("docs/spec.md or https://…")}              onSubmit={ready ? () => void submit() : undefined}
            />
            <Field title={t("Title")} value={title} onChange={setTitle} placeholder={t("Defaults to the file name or link")} />
            <Field title={t("Note")} value={note} onChange={setNote} multiline placeholder={t("What it is for")} />
            <Actions>
              <Button quiet onPress={onClose} disabled={pending}>{t("Cancel")}</Button>
              <Button primary onPress={() => void submit()} disabled={!ready}>{artifact ? t("Save") : t("Add")}</Button>
            </Actions>
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

/** Read-only view of a file artifact (CARD-ARTIFACTS-SPEC §6.2), loaded once per opening. */
function ArtifactPreview({ artifact, onClose }: { artifact: Artifact; onClose(): void }) {
  const theme = useTheme();
  const read = useRpc(rpc.previewArtifact);
  const preview = useQuery({
    queryKey: ["flowly", "artifact-preview", artifact.id, artifact.updatedAt],
    queryFn: () => read({ id: artifact.id }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const data = preview.data;
  return (
    <Modal open title={artifact.title} onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: space[2] }}>
            <Label muted size={font.xs} selectable lines={2}>{artifact.target}</Label>
            {!!artifact.note && <Label size={font.sm} selectable>{artifact.note}</Label>}
            {preview.isPending ? (
              <Label muted>{t("Loading…")}</Label>
            ) : preview.error ? (
              <Notice tone="warning">{message(preview.error)}</Notice>
            ) : data?.type === "image" ? (
              <Image source={{ uri: data.dataUri }} resizeMode="contain" accessibilityLabel={artifact.title} style={{ width: "100%", height: 480 }} />
            ) : data?.type === "text" ? (
              // The host modal body is the only scroll view: a nested one fights it for the pan on phones.
              data.markdown ? (
                <SessionMarkdown text={data.text} />
              ) : (
                <Label size={font.sm} selectable mono>{data.text}</Label>
              )
            ) : data?.type === "directory" ? (
              <View style={{ gap: 2 }}>
                {data.entries.map((e) => (
                  <View key={e.name} style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
                    <Icon name={e.directory ? "Folder" : "File"} size={13} color={theme.colors.foregroundMuted} />
                    <Label size={font.sm} lines={1}>{e.name}</Label>
                  </View>
                ))}
                {!data.entries.length && <Label muted size={font.sm}>{t("This folder is empty.")}</Label>}
                {data.more && <Label muted size={font.xs}>{t("Only the first 200 entries are shown.")}</Label>}
              </View>
            ) : (
              <Label muted size={font.sm}>
                {t("No preview for this file ({size}). Open it from the workspace.", { size: formatSize(data?.size ?? 0) })}
              </Label>
            )}
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
