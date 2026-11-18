import { memo, useMemo, useRef } from "react";
import { View } from "react-native";
import { useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { Project, Task } from "../shared/model";
import type { PrState } from "../shared/pr-rows";
import { laneName } from "../shared/lanes";
import { msg, t } from "../shared/i18n";
import { Modal } from "./modal";
import { Button, IconButton, Label, Row, Theme, font, space, touch, useTheme } from "./ui";
import { stateColors } from "./state-colors";
import { openQuickLink } from "./quick-links-row";
import { usePrListQuery } from "./queries";
import { prRowDetail, prRowTitle, prSections, type PrListRow, type PrSectionId } from "./pr-list";

/** At most this many projects per read (PR-MENU-SPEC §3.2). */
const maxProjects = 20;
const noRows: PrListRow[] = [];
const sectionTitles: Record<PrSectionId, string> = { open: msg("Open"), reviewing: msg("Reviewing"), closed: msg("Merged or closed") };
const stateWords: Record<Exclude<PrState, "">, string> = { draft: msg("Draft"), open: msg("Open"), merged: msg("Merged"), closed: msg("Closed") };

type ShownRow = { key: string; taskId: string; url: string; state: PrState; title: string; detail: string; label: string };

/**
 * The board's pull requests menu (PR-MENU-SPEC §2): the PRs of the cards in the projects the board shows, in three
 * sections. A row opens its card; its trailing button opens the PR in the browser. Read when it opens (§3.2); the
 * rows keep the cards' titles and lanes from that moment, so nothing moves while it is open.
 */
export function PrMenu({
  open,
  projects,
  tasks,
  theme,
  onClose,
  onOpenCard,
}: {
  open: boolean;
  /** The projects the board shows now (its filtered project, else every live member of the group shown). */
  projects: readonly Project[];
  tasks: readonly Task[];
  theme: PluginTheme;
  onClose(): void;
  onOpenCard(taskId: string): void;
}) {
  const ids = useMemo(() => projects.slice(0, maxProjects).map((p) => p.id), [projects]);
  const query = usePrListQuery(ids, open);
  const rows = query.data?.rows ?? noRows;
  // Read when the list arrives or the menu opens, not on every overview poll.
  const board = useRef({ tasks, projects });
  board.current = { tasks, projects };
  const sections = useMemo(() => {
    const byTask = new Map(board.current.tasks.map((x) => [x.id, x]));
    const byProject = new Map(board.current.projects.map((p) => [p.id, p]));
    const several = board.current.projects.length > 1;
    return prSections(rows, (id) => byTask.get(id)?.status).map((section) => ({
      id: section.id,
      rows: section.rows.map((r): ShownRow => {
        const card = byTask.get(r.taskId);
        const project = byProject.get(r.projectId);
        const cardTitle = card?.title ?? "";
        const title = prRowTitle(r, cardTitle);
        const word = r.state ? t(stateWords[r.state]) : "";
        return {
          key: `${r.taskId}|${r.artifactId ?? r.kind}|${r.url}`,
          taskId: r.taskId,
          url: r.url,
          state: r.state,
          title,
          detail: prRowDetail(r, { card: cardTitle, lane: card ? laneName(project, card.status) : "", project: several ? project?.title : undefined }),
          label: word
            ? t("Open card {card}: pull request {number} · {state}", { card: cardTitle, number: r.number, state: word })
            : t("Open card {card}: pull request {number}", { card: cardTitle, number: r.number }),
        };
      }),
    }));
  }, [rows, open]);
  return (
    <Modal
      open={open}
      title={t("Pull requests")}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content contentContainerStyle={{ padding: space[3], gap: space[1] }}>
        <Theme.Provider value={theme}>
          {query.isError && !query.data ? (
            <View style={{ gap: space[2], alignItems: "flex-start" }}>
              <Label muted size={font.md} selectable={false}>{t("Could not load pull requests.")}</Label>
              <Button small onPress={() => void query.refetch()}>{t("Retry")}</Button>
            </View>
          ) : !query.data ? (
            <Label muted size={font.md} selectable={false}>{t("Loading…")}</Label>
          ) : sections.length === 0 ? (
            <Label muted size={font.md} selectable={false}>{t("No pull requests on this board")}</Label>
          ) : (
            sections.map((section) => (
              <View key={section.id} style={{ gap: space[1] }}>
                <Label muted size={font.sm} medium selectable={false}>{t(sectionTitles[section.id])}</Label>
                {section.rows.map((row) => (
                  <PrRow key={row.key} row={row} onClose={onClose} onOpenCard={onOpenCard} />
                ))}
              </View>
            ))
          )}
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

const PrRow = memo(function PrRow({ row, onClose, onOpenCard }: { row: ShownRow; onClose(): void; onOpenCard(taskId: string): void }) {
  const { colors } = useTheme();
  const toast = useToast();
  const tones = stateColors(colors);
  // As the Quick links chip colours a PR: open the running colour, merged the success colour, others muted.
  const tone = row.state === "open" ? tones.running : row.state === "merged" ? tones.unread : colors.foregroundMuted;
  return (
    <Row
      title={row.title}
      detail={row.detail}
      detailLines={touch ? 3 : 1}
      label={row.label}
      testID={`pr-row-${row.taskId}`}
      trailing={
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
          {!!row.state && (
            <Label size={font.sm} color={tone} selectable={false}>
              {t(stateWords[row.state])}
            </Label>
          )}
          <IconButton
            icon="ArrowUpRight"
            label={t("Open pull request")}
            size={touch ? 36 : undefined}
            onPress={() => {
              onClose();
              openQuickLink(row.url, toast);
            }}
          />
        </View>
      }
      onPress={() => {
        onClose();
        onOpenCard(row.taskId);
      }}
    />
  );
});
