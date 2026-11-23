import { memo, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import type { PluginTheme } from "@getpaseo/plugin";
import type { Project, Task } from "../shared/model";
import type { PrState } from "../shared/pr-rows";
import { laneName } from "../shared/lanes";
import * as rpc from "../shared/rpc";
import { msg, t } from "../shared/i18n";
import { Modal } from "./modal";
import { Button, IconButton, Label, Row, Theme, Toggle, font, space, touch, useTheme } from "./ui";
import { stateColors } from "./state-colors";
import { openQuickLink } from "./quick-links-row";
import { usePrListQuery } from "./queries";
import { hiddenPrRows, mineNote, prRowDetail, prRowTitle, prSections, type PrListRow, type PrSectionId } from "./pr-list";
import { useStableCallback } from "./stable";
import { useBoardView } from "./board-view";

/** At most this many projects per read (PR-MENU-SPEC §3.2). */
const maxProjects = 20;
const noRows: PrListRow[] = [];
const sectionTitles: Record<PrSectionId, string> = { open: msg("Open"), reviewing: msg("Reviewing"), closed: msg("Merged or closed"), unknown: msg("Author not known") };
const stateWords: Record<Exclude<PrState, "">, string> = { draft: msg("Draft"), open: msg("Open"), merged: msg("Merged"), closed: msg("Closed") };

type ShownRow = { hidden: boolean; key: string; taskId: string; url: string; state: PrState; title: string; detail: string; label: string };

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
  onChanged,
}: {
  open: boolean;
  /** The projects the board shows now (its filtered project, else every live member of the group shown). */
  projects: readonly Project[];
  tasks: readonly Task[];
  theme: PluginTheme;
  onClose(): void;
  onOpenCard(taskId: string): void;
  /** After a PR was hidden or shown again: refresh the board overview, whose card facts carry the chip's count. */
  onChanged(): void;
}) {
  const ids = useMemo(() => projects.slice(0, maxProjects).map((p) => p.id), [projects]);
  const query = usePrListQuery(ids, open);
  const rows = query.data?.rows ?? noRows;
  // Read when the list arrives or the menu opens, not on every overview poll.
  const board = useRef({ tasks, projects });
  board.current = { tasks, projects };
  const view = useBoardView();
  const mine = view.values?.prMine ?? false;
  const { sections, hiddenList, note } = useMemo(() => {
    const byTask = new Map(board.current.tasks.map((x) => [x.id, x]));
    const byProject = new Map(board.current.projects.map((p) => [p.id, p]));
    const several = board.current.projects.length > 1;
    const shown = (r: PrListRow): ShownRow => {
      const card = byTask.get(r.taskId);
      const project = byProject.get(r.projectId);
      const cardTitle = card?.title ?? "";
      const title = prRowTitle(r, cardTitle);
      const word = r.state ? t(stateWords[r.state]) : "";
      return {
        hidden: r.hidden,
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
    };
    return {
      sections: prSections(rows, (id) => byTask.get(id)?.status, { mine }).map((section) => ({ id: section.id, rows: section.rows.map(shown) })),
      hiddenList: hiddenPrRows(rows).map(shown),
      note: mine ? mineNote(rows) : null,
    };
  }, [rows, open, mine]);
  // The Hidden view (D14); it falls back to the main list once nothing is hidden, and starts over on every open.
  const [page, setView] = useState<"main" | "hidden">("main");
  useEffect(() => {
    if (!open) setView("main");
  }, [open]);
  const showHidden = page === "hidden" && hiddenList.length > 0;
  // Once nothing is hidden the view starts over, so a later hide does not jump to the Hidden view.
  useEffect(() => {
    if (hiddenList.length === 0) setView((v) => (v === "main" ? v : "main"));
  }, [hiddenList.length]);
  const toast = useToast();
  const queryClient = useQueryClient();
  const hideRpc = useRpc(rpc.hidePr),
    restoreRpc = useRpc(rpc.restorePr);
  const busy = useRef(false);
  const [toggling, setToggling] = useState(false);
  const setHidden = useStableCallback(async (row: ShownRow, hide: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setToggling(true);
    try {
      await (hide ? hideRpc : restoreRpc)({ taskId: row.taskId, url: row.url });
      if (hide) toast.show(t("Hidden from the pull requests list"), { variant: "success" });
      onChanged();
      // The list refetches in the background; the buttons are free again once the RPC has answered.
      void queryClient.invalidateQueries({ queryKey: ["flowly", "prs"] });
    } catch {
      toast.show(hide ? t("Could not hide the pull request.") : t("Could not show the pull request again."), { variant: "error" });
    } finally {
      busy.current = false;
      setToggling(false);
    }
  });
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
          ) : showHidden ? (
            <View style={{ gap: space[1] }}>
              <Label muted size={font.sm} medium selectable={false}>{t("Hidden ({n})", { n: hiddenList.length })}</Label>
              {hiddenList.map((row) => (
                <PrRow key={row.key} row={row} onClose={onClose} onOpenCard={onOpenCard} onToggle={setHidden} disabled={toggling} />
              ))}
              <View style={{ alignItems: "flex-start", paddingTop: space[1] }}>
                <Button quiet small onPress={() => setView("main")}>{t("Back")}</Button>
              </View>
            </View>
          ) : (
            <>
              <Toggle title={t("My PRs")} value={mine} onChange={(next) => void view.update({ prMine: next })} />
              {note === "none" && (
                <Label muted size={font.md} selectable={false}>{t("None of these pull requests is known to be yours.")}</Label>
              )}
              {note === "noLogin" && (
                <Label muted size={font.md} selectable={false}>
                  {t("Flowly can't tell which pull requests are yours: connect GitHub in Settings → Connectors, or sign in to the gh CLI.")}
                </Label>
              )}
              {sections.length === 0 && !note && (
                <Label muted size={font.md} selectable={false}>
                  {hiddenList.length > 0 ? t("All pull requests on this board are hidden.") : t("No pull requests on this board")}
                </Label>
              )}
              {sections.map((section) => (
                <View key={section.id} style={{ gap: space[1] }}>
                  <Label muted size={font.sm} medium selectable={false}>{t(sectionTitles[section.id])}</Label>
                  {section.rows.map((row) => (
                    <PrRow key={row.key} row={row} onClose={onClose} onOpenCard={onOpenCard} onToggle={setHidden} disabled={toggling} />
                  ))}
                </View>
              ))}
              {hiddenList.length > 0 && (
                <View style={{ alignItems: "flex-start", paddingTop: space[1] }}>
                  <Button quiet small onPress={() => setView("hidden")}>{t("Hidden ({n})", { n: hiddenList.length })}</Button>
                </View>
              )}
            </>
          )}
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

const PrRow = memo(function PrRow({ row, onClose, onOpenCard, onToggle, disabled }: { disabled: boolean; row: ShownRow; onClose(): void; onOpenCard(taskId: string): void; onToggle(row: ShownRow, hide: boolean): void }) {
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
            icon={row.hidden ? "Eye" : "EyeOff"}
            label={row.hidden ? t("Show in list again") : t("Hide from this list")}
            size={touch ? 36 : undefined}
            disabled={disabled}
            onPress={() => onToggle(row, !row.hidden)}
          />
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
