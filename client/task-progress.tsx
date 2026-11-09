import { useTaskDetail } from "./card-detail-query";
import { perfStart, perfEnd, usePerfRender } from "./perf";
import { useState } from "react";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { modelLabel, targetText, type SummaryEntry, type SummaryOverview } from "../shared/summary";
import { CardBody, CardField, CardFootnote, CardHeadline, ContentCard, PROGRESS_CLAMP_HEIGHT } from "./content-card";
import { Marked, useMark } from "./drawer-focus";
import { Section, type SectionState } from "./disclosure";
import { summariesKey, useSummariesQuery } from "./queries";
import { workpadEnabled, workpadOf } from "../shared/workpad";
import { Button, Label, font, message, relativeTime } from "./ui";
import { t } from "../shared/i18n";

export { summariesKey };

/** Latest summary per card, runs in flight and errors (TASK-SUMMARY-SPEC §6). Shared by board and drawer. */
export const useSummaries = useSummariesQuery;

export function cardProgress(overview: SummaryOverview | undefined, taskId: string) {
  return overview?.latest.find((e) => e.taskId === taskId) || null;
}

/** Drawer "Progress": state, recap and next step, with refresh. */
export function TaskProgress({
  taskId,
  active,
  section,
  chatsKey,
}: {
  taskId: string;
  active: boolean;
  section: SectionState;
  /** The workspace's live session ids: a change re-reads the card's chats (TASK-SUMMARY-SPEC §2.1). */
  chatsKey: string;
}) {
  usePerfRender("switch.progress.commit");
  const switchStart = perfStart();
  const toast = useToast();
  const queryClient = useQueryClient();
  const overview = useSummaries(active);
  // The workpad's acceptance criteria replace the summary's Target (WORKPAD-SPEC §6.2).
  const { detail } = useTaskDetail();
  const hideTarget =
    workpadEnabled(detail?.project) && !!detail?.workpad?.acceptance.length;
  const refreshRpc = useRpc(rpc.refreshSummary);
  const [requesting, setRequesting] = useState(false);
  const chatsRpc = useRpc(rpc.cardChats);
  const chats = useQuery({
    queryKey: ["flowly", "card-chats", taskId, chatsKey],
    queryFn: () => chatsRpc({ taskId }),
    enabled: active,
    refetchInterval: 30000,
    placeholderData: (previous) => previous,
  });
  const latest = cardProgress(overview.data, taskId);
  const mark = useMark("section:progress");
  const running = !!overview.data?.running.includes(taskId);
  const error = overview.data?.errors.find((e) => e.taskId === taskId);
  // Refresh needs a chat to read; until the count is known the button stays.
  const noChats = !running && chats.data?.count === 0;
  const refresh = async () => {
    setRequesting(true);
    try {
      await refreshRpc({ taskId });
      await queryClient.invalidateQueries({ queryKey: summariesKey });
    } catch (e) {
      toast.show(message(e), { variant: "error" });
    } finally {
      setRequesting(false);
    }
  };
  perfEnd("switch.progress.own", switchStart);
  return (
    <Section
      focusId="progress"
      id={taskId}
      title={t("Progress")}
      ai
      open={section.open}
      onToggle={section.onToggle}
      summary={running ? t("Updating…") : latest?.state}
      actions={
        noChats ? (
          <Label muted size={font.sm}>
            {t("No chats on this card yet.")}
          </Label>
        ) : (
          <Button quiet icon="RefreshCw" disabled={!active || running || requesting} onPress={() => void refresh()}>
            {running ? t("Updating…") : t("Refresh")}
          </Button>
        )
      }
    >
      {latest ? (
        <ContentCard
          openWhen={mark}
          clampHeight={PROGRESS_CLAMP_HEIGHT}
          footer={<CardFootnote>{t("Updated {time}", { time: relativeTime(latest.at) })} · {modelLabel(latest.model)}</CardFootnote>}
        >
          {/* A search hit in Target shows it even where the workpad replaces it (DRAWER-SPEC "Focus from search" 7). */}
          <SummaryBody entry={hideTarget && mark?.field !== "target" ? { ...latest, target: "" } : latest} terms={mark?.terms} />
        </ContentCard>
      ) : (
        <Label muted size={font.sm}>
          {running
            ? t("Writing the first summary…")
            : overview.data && !overview.data.enabled
              ? t("Auto summary is off. Turn it on with the settings button at the bottom left of the board, or press Refresh.")
              : t("Updates after each agent turn.")}
        </Label>
      )}
      {!!error && (
        <Label muted size={font.sm}>
          {t("Last update failed {time}: {error}", { time: relativeTime(error.at), error: error.message })}
        </Label>
      )}
    </Section>
  );
}

/** Each field in full: brevity comes from the prompt, never from cutting text (TASK-SUMMARY-SPEC §3, §7). */
export function SummaryBody({
  entry,
  terms,
}: {
  entry: Pick<SummaryEntry, "state" | "target" | "recap" | "next">;
  /** Search words to mark. */
  terms?: readonly string[] | null;
}) {
  return (
    <CardBody>
      {!!entry.state && (
        <CardHeadline>
          <Marked text={entry.state} terms={terms} />
        </CardHeadline>
      )}
      {!!entry.target && <CardField title={t("Target")} text={targetText(entry.target)} terms={terms} />}
      {!!entry.recap && <CardField title={t("Recap")} text={entry.recap} terms={terms} />}
      {!!entry.next && <CardField title={t("Next")} text={entry.next} terms={terms} />}
    </CardBody>
  );
}
