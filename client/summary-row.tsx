import { memo, useState } from "react";
import { View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { SummaryRowData } from "../shared/native-session";
import { CardFootnote, ContentCard, Toggle } from "./content-card";
import { SummaryBody } from "./task-progress";
import { AiMark, Button, Label, Theme, font, relativeTime, space } from "./ui";
import { NativeCardHeading } from "./native-card";
import { openCardFromRow, useProgressRowsCollapsed } from "./native-chips";
import { progressRowView, recapLine } from "./summary-line";
import { SharedMotionProvider } from "./motion";
import { t } from "../shared/i18n";

/**
 * A summary version as a timeline row (NATIVE-SESSION-SPEC §5.3), in Paseo's own timeline only (Flowly's session view
 * leaves it out; the sidebar has Progress). With *Start progress rows collapsed* on (the default) it starts as one
 * line: the "Progress" heading, the recap's first sentence and the time; Show more opens the drawer's Progress card
 * in full and Show less goes back to the line. The choice lives with the mounted row only, so a remount starts
 * collapsed again. Off: the full card, open (2026-10-29 user feedback: a clipped card cut nearly every row off), and
 * its own Show less clamps it.
 */
export const SummaryRow = memo(function SummaryRow({
  data,
  onOpenCard,
  startCollapsed,
}: {
  data: SummaryRowData;
  onOpenCard?: () => void;
  startCollapsed: boolean;
}) {
  // null: follow the setting (it may arrive after the row mounted); a press decides for this row from then on.
  const [choice, setChoice] = useState<boolean | null>(null);
  const view = progressRowView(startCollapsed, choice);
  if (view === "open-card") return <FullRow data={data} onOpenCard={onOpenCard} />;
  if (view === "line") return <CollapsedRow data={data} onExpand={() => setChoice(true)} />;
  return <FullRow data={data} onOpenCard={onOpenCard} onCollapse={() => setChoice(false)} />;
});

/** The one-line Progress row: heading, first recap sentence (else the state's), time, Show more. */
function CollapsedRow({ data, onExpand }: { data: SummaryRowData; onExpand(): void }) {
  const line = recapLine(data.recap) || recapLine(data.state);
  return (
    <View testID="session-summary-row" style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
      <AiMark />
      <View style={{ flexShrink: 0 }}>
        <Label muted medium size={font.sm} selectable={false}>
          {t("Progress")}
        </Label>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {!!line && (
          <Label size={font.sm} lines={1} selectable={false}>
            {line}
          </Label>
        )}
      </View>
      <View style={{ flexShrink: 0 }}>
        <CardFootnote>{t("Updated {time}", { time: relativeTime(data.at) })}</CardFootnote>
      </View>
      <View style={{ flexShrink: 0, marginLeft: space[1.5], marginVertical: -space[1] }}>
        <Toggle open={false} onPress={onExpand} />
      </View>
    </View>
  );
}

/**
 * The full Progress card under its heading. With `onCollapse` (the collapsed-first row) it never clamps and its
 * footer starts with Show less; without it, the card's own Show more / Show less clamps long content.
 */
function FullRow({ data, onOpenCard, onCollapse }: { data: SummaryRowData; onOpenCard?: () => void; onCollapse?: () => void }) {
  return (
    <View testID="session-summary-row" style={{ gap: space[1.5] }}>
      <NativeCardHeading title={t("Progress")} />
      <ContentCard
        defaultOpen
        clampHeight={onCollapse ? NEVER_CLAMP : undefined}
        footer={
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], alignSelf: onCollapse ? "stretch" : undefined }}>
            {onCollapse && (
              <>
                <Toggle open onPress={onCollapse} />
                <View style={{ flex: 1 }} />
              </>
            )}
            <CardFootnote>{t("Updated {time}", { time: relativeTime(data.at) })}</CardFootnote>
            {onOpenCard && (
              <Button quiet small icon="PanelsTopLeft" onPress={onOpenCard}>
                {t("Open card")}
              </Button>
            )}
          </View>
        }
      >
        <SummaryBody entry={data} />
      </ContentCard>
    </View>
  );
}

/** Taller than any summary, so the opened collapsed-first row shows in full with only its own Show less. */
const NEVER_CLAMP = 100_000;

/** The renderer Paseo calls for `flowly-summary` rows in its own timeline. */
export function NativeSummaryItem(props: PluginTimelineItemProps<SummaryRowData>) {
  const data = props.item.data;
  const startCollapsed = useProgressRowsCollapsed();
  // A session Flowly does not manage has no card to open (NATIVE-SESSION-SPEC §12.4).
  const cardLink = data.taskId && data.workspaceId ? { taskId: data.taskId, workspaceId: data.workspaceId } : null;
  return (
    <Theme.Provider value={props.theme}>
      {/* Paseo renders this outside Flowly's tree: without it Show more / Show less would never animate. */}
      <SharedMotionProvider>
        <View style={{ paddingVertical: space[1] }}>
          <SummaryRow data={data} startCollapsed={startCollapsed} onOpenCard={cardLink ? () => openCardFromRow(cardLink, props.agentId) : undefined} />
        </View>
      </SharedMotionProvider>
    </Theme.Provider>
  );
}
