import { memo, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { Project, Task } from "../shared/model";
import { enabledStatuses, laneName } from "../shared/lanes";
import { linkFor, linksOf, type LinkView, type Relation } from "../shared/links";
import { groupOf, groups, linkCandidates } from "./link-rows";
import { eventPoint, useMenuOpener } from "./context-menu";
import { Modal } from "./modal";
import { IdeaRow, useExitList } from "./task-ideas";
import { Section, type SectionState } from "./disclosure";
import { useTaskDetail, invalidateCardViews } from "./card-detail-query";
import type { CardReference } from "../shared/card-detail";
import { TypeIcon } from "./status";
import { Choices, IconButton, Label, Notice, TextBox, Theme, font, message, radius, space, touch, useTheme, noFocusRing } from "./ui";
import { t, tn } from "../shared/i18n";
import { shortRef } from "../shared/worktree-base";

/**
 * Drawer "Links": cards linked to this one (CARD-LINKS-SPEC §5.2). The header
 * `+` links another card or starts a follow-up card. Removing a link is
 * optimistic: the row collapses at once and comes back with an error toast.
 */
export function TaskLinks({
  task,
  project,
  disabled,
  onOpenTask,
  onLink,
  onFollowUp,
  section,
}: {
  task: Task;
  project: Project;
  disabled: boolean;
  onOpenTask(id: string): void;
  onLink(task: Task): void;
  onFollowUp(task: Task): void;
  section: SectionState;
}) {
  const { detail } = useTaskDetail();
  const toast = useToast();
  const queryClient = useQueryClient();
  const openMenu = useMenuOpener();
  const deleteLink = useRpc(rpc.deleteLink);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());
  const views = useMemo(
    () => (detail ? linksOf({ links: detail.links, tasks: detail.relatedTasks }, task.id).filter((v) => v.other && !removing.has(v.link.id)) : []),
    [detail, task.id, removing],
  );
  const rows = useExitList(useMemo(() => views.map((v) => ({ ...v, id: v.link.id })), [views]));
  const remove = async (view: LinkView<CardReference>) => {
    setRemoving((current) => new Set(current).add(view.link.id));
    try {
      await deleteLink({ id: view.link.id });
      await invalidateCardViews(queryClient);
    } catch (e) {
      toast.show(message(e), { variant: "error" });
    } finally {
      setRemoving((current) => {
        const next = new Set(current);
        next.delete(view.link.id);
        return next;
      });
    }
  };
  return (
    <Section
      id={task.id}
      title={t("Links")}
      count={views.length}
      empty={!rows.length}
      open={section.open}
      onToggle={section.onToggle}
      actions={
        <IconButton
          icon="Plus"
          label={t("Add a link: link to a card or start a follow-up task")}
          disabled={disabled}
          onPress={(event) => {
            if (!openMenu) return onLink(task);
            openMenu(eventPoint(event), "Links", [
              { id: "link", label: t("Link to a card…"), icon: "Link", onPress: () => onLink(task) },
              { id: "follow-up", label: t("New follow-up task"), icon: "CornerDownRight", onPress: () => onFollowUp(task) },
            ]);
          }}
        />
      }
    >
      {groups.map((group) => {
        const list = rows.filter((r) => groupOf(r.item) === group.id);
        if (!list.length) return null;
        return (
          <View key={group.id} style={{ gap: 2 }}>
            <Label muted size={font.xs} bold selectable={false}>{t(group.title)}</Label>
            {list.map((row) => (
              <IdeaRow key={row.item.id} leaving={row.leaving} entering={row.entering} spacing={0}>
                <LinkRow
                  view={row.item}
                  lane={laneName(project, row.item.other!.status)}
                  disabled={disabled || row.leaving}
                  onOpenTask={onOpenTask}
                  onRemove={remove}
                />
              </IdeaRow>
            ))}
          </View>
        );
      })}
    </Section>
  );
}

const LinkRow = memo(function LinkRow({
  view,
  lane,
  disabled,
  onOpenTask,
  onRemove,
}: {
  view: LinkView<CardReference>;
  lane: string;
  disabled: boolean;
  onOpenTask(id: string): void;
  onRemove(view: LinkView<CardReference>): void;
}) {
  const { colors } = useTheme();
  const other = view.other!;
  const archived = !!other.archivedAt;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1], minHeight: touch ? 40 : 30 }}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${t("Open task {title}", { title: other.title })}, ${lane}${archived ? `, ${t("archived")}` : ""}`}
        onPress={() => onOpenTask(other.id)}
        style={({ pressed }) => ({ ...noFocusRing, flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space[1.5], opacity: pressed ? 0.7 : 1 })}
      >
        <TypeIcon type={other.type} size={13} always />
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          <Label size={font.md} muted={archived} lines={1} selectable={false}>{other.title}</Label>
        </View>
        <Label muted size={font.sm} selectable={false}>{archived ? t("Archived") : lane}</Label>
        {!!view.link.ideaId && <Icon name="Lightbulb" size={11} color={colors.foregroundMuted} />}
      </Pressable>
      <IconButton
        icon="X"
        size={touch ? 36 : 24}
        label={t("Remove link: {group} {title}", { group: groupTitle(view), title: other.title })}
        disabled={disabled}
        onPress={() => onRemove(view)}
      />
    </View>
  );
});

const groupTitle = (view: LinkView<CardReference>) => t(groups.find((g) => g.id === groupOf(view))!.title);

/**
 * Above the description: "From idea on <card>" or "Follow-up of <card>"
 * (CARD-LINKS-SPEC §5.3), from the card's follow_up_of links.
 */
export function LinkOrigin({ taskId, onOpenTask }: { taskId: string; onOpenTask(id: string): void }) {
  const { detail } = useTaskDetail();
  const { colors } = useTheme();
  const sources = useMemo(
    () => (detail ? linksOf({ links: detail.links, tasks: detail.relatedTasks }, taskId).filter((v) => v.relation === "follow_up_of" && v.other) : []),
    [detail, taskId],
  );
  const [first] = sources;
  if (!first) return null;
  const lead = `${first.link.ideaId ? t("From idea on") : t("Follow-up of")} `;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
      <Icon name={first.link.ideaId ? "Lightbulb" : "CornerDownRight"} size={13} color={colors.foregroundMuted} />
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={t("Open source task {title}", { title: first.other!.title })}
        onPress={() => onOpenTask(first.other!.id)}
        style={({ pressed }) => ({ ...noFocusRing, flexShrink: 1, opacity: pressed ? 0.7 : 1 })}
      >
        <Label size={font.sm} muted lines={1} selectable={false}>
          {lead}
          <Label size={font.sm} color={colors.accent} selectable={false}>{first.other!.title}</Label>
          {sources.length > 1 ? ` +${sources.length - 1}` : ""}
        </Label>
      </Pressable>
    </View>
  );
}

/**
 * "Branched from <branch> (<parent title>), N commits not in <base>" while the card's worktree branched from its
 * parent card's branch (START-CARD-SPEC §11.4); pressing it opens the parent.
 */
export function BranchedFrom({ task, onOpenTask }: { task: Task; onOpenTask(id: string): void }) {
  const { detail } = useTaskDetail();
  const { colors } = useTheme();
  const from = task.branchedFrom;
  if (!from) return null;
  const parent = detail?.relatedTasks.find((x) => x.id === from.taskId);
  const text = tn(from.ahead, "Branched from {branch} ({title}), {n} commit not in {base}", "Branched from {branch} ({title}), {n} commits not in {base}", {
    branch: from.branch,
    title: parent?.title ?? from.taskId,
    base: shortRef(task.baseRef ?? ""),
  });
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
      <Icon name="GitBranch" size={13} color={colors.foregroundMuted} />
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={text}
        onPress={() => onOpenTask(from.taskId)}
        style={({ pressed }) => ({ ...noFocusRing, flexShrink: 1, opacity: pressed ? 0.7 : 1 })}
      >
        <Label size={font.sm} muted lines={2} selectable={false}>
          {text}
        </Label>
      </Pressable>
    </View>
  );
}

const pickRelations = (): { value: Relation; label: string }[] => [
  { value: "related", label: t("Related") },
  { value: "blocks", label: t("Blocks") },
  { value: "blocked_by", label: t("Blocked by") },
  { value: "follow_up_of", label: t("Follow-up of") },
];

/** "Link to a card…" (CARD-LINKS-SPEC §5.4): pick a relation, then a card of the project. */
export function LinkPicker({ task, project, onClose }: { task: Task; project: Project; onClose(): void }) {
  const theme = useTheme();
  const { detail, index, indexError, error: detailError, pending: detailPending, retry, retryIndex } = useTaskDetail();
  const toast = useToast();
  const queryClient = useQueryClient();
  const createLink = useRpc(rpc.createLink);
  const [relation, setRelation] = useState<Relation>("related"),
    [query, setQuery] = useState(""),
    [pending, setPending] = useState(""),
    [error, setError] = useState("");
  const candidates = useMemo(() => {
    if (!detail || !index) return [];
    const lanes = enabledStatuses(project);
    return linkCandidates(index.cards, detail.links, task, relation, query).sort(
      (a, b) => lanes.indexOf(a.task.status) - lanes.indexOf(b.task.status) || a.task.position - b.task.position,
    );
  }, [detail, index, task, relation, query, project]);
  const pick = async (other: CardReference) => {
    setPending(other.id);
    setError("");
    try {
      await createLink(linkFor(relation, task.id, other.id));
      await invalidateCardViews(queryClient);
      toast.show(t("Linked"), { variant: "success" });
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending("");
    }
  };
  return (
    <Modal
      open
      title={t("Link “{title}”", { title: task.title })}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: space[3] }}>
            <Choices title={t("This card")} value={relation} options={pickRelations()} onChange={setRelation} />
            <TextBox
              value={query}
              onChangeText={setQuery}
              commitDelay={150}
              placeholder={t("Search cards")}
              accessibilityLabel={t("Search cards")}
              autoFocus={!touch}
              style={{
                height: touch ? 40 : 32,
                paddingHorizontal: space[3],
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: theme.colors.border,
                color: theme.colors.foreground,
                fontSize: font.base,
              }}
            />
            {!!error && <Notice tone="danger">{error}</Notice>}
            <View style={{ gap: 2 }}>
              {indexError || detailError ? (
                <Pressable style={noFocusRing} onPress={() => { retry(); retryIndex(); }}><Notice>{message(indexError || detailError)}</Notice><Label>{t("Retry")}</Label></Pressable>
              ) : !index || detailPending ? (
                <Label muted>{t("Loading cards…")}</Label>
              ) : !candidates.length ? (
                <Label muted size={font.sm}>{query.trim() ? t("No matching cards.") : t("No other cards in this project.")}</Label>
              ) : (
                candidates.map(({ task: other, linked }) => (
                  <Pressable
                    key={other.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${pickRelations().find((r) => r.value === relation)!.label} ${other.title}${linked ? `, ${t("already linked")}` : ""}`}
                    accessibilityState={{ disabled: linked || !!pending }}
                    disabled={linked || !!pending}
                    onPress={() => void pick(other)}
                    style={(state) => {
                      const hovered = (state as typeof state & { hovered?: boolean }).hovered;
                      return {
                        ...noFocusRing,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: space[2],
                        minHeight: touch ? 44 : 32,
                        paddingHorizontal: space[2],
                        borderRadius: radius.md,
                        backgroundColor: hovered || state.pressed || pending === other.id ? theme.colors.surface2 : "transparent",
                        opacity: linked ? 0.45 : 1,
                      };
                    }}
                  >
                    <TypeIcon type={other.type} size={13} always />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Label size={font.base} lines={1} selectable={false}>{other.title}</Label>
                    </View>
                    <Label muted size={font.xs} selectable={false}>{linked ? t("Linked") : laneName(project, other.status)}</Label>
                  </Pressable>
                ))
              )}
            </View>
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}
