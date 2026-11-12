import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { Dot, Label, font, noFocusRing, radius, space, touch, useTheme } from "./ui";
import { Enter, PulseDot } from "./motion";
import { overviewRow, type BoardOverview } from "./overview";
import { t, tn } from "../shared/i18n";

/**
 * Board header summary: how many cards, how many have agents working (only while some do), one "N need you" chip for
 * every open ask that waits on you and "N updated" for the cards with something new to read (changed since you looked,
 * or an unread turn); each starts a step-through in the card sidebar. No lane chips (Ruling, Noah 2026-11-09).
 */
export function OverviewBar({
  overview,
  needYou,
  onNeedYou,
  onRunning,
  updated,
  onUpdated,
  updatedShortcut,
  onInsights,
  insightsShortcut,
  openIdeas,
  onIdeas,
  ideasShortcut,
  guardrailCount,
  onGuardrails,
  guardrailsShortcut,
  memoryCount,
  onMemory,
  memoryShortcut,
}: {
  overview: BoardOverview;
  /** Open asks on the shown board's cards (its filtered project, else the group's live members), as the bell counts them (DISPATCHER-SPEC §9.4, BOARD-GROUPS-SPEC §3); a press starts the step-through. */
  needYou: number;
  onNeedYou(): void;
  /** Opens the list of running cards (DISPATCHER-SPEC §9.2a). */
  onRunning(): void;
  /** Cards the dispatcher saw change since you looked (§9.2); never part of needYou. */
  updated: number;
  onUpdated(): void;
  updatedShortcut: string;
  /** Open project Insights (PROJECT-INSIGHTS-SPEC §9). */
  /** Absent when Insights is off (ONBOARDING-SETUP-SPEC §6). */
  onInsights?(): void;
  insightsShortcut: string;
  /** Open ideas across the project's cards, finished and archived ones included (IDEAS-INBOX-SPEC §3.1); null when Ideas are off. */
  openIdeas: number | null;
  onIdeas(): void;
  ideasShortcut: string;
  /** Observing commands plus guidelines learned this week (GUARDRAILS-SPEC §7.4); null when guardrails are off for the project. */
  guardrailCount: number | null;
  onGuardrails(): void;
  guardrailsShortcut: string;
  /** Memory added this week (GUARDRAILS-SPEC §7.4); null when guardrails are off for the project. */
  memoryCount: number | null;
  onMemory(): void;
  memoryShortcut: string;
}) {
  const { colors } = useTheme();
  const o = overview;
  const row = overviewRow({ runningTasks: o.runningTasks, needYou, updated }, { ideas: openIdeas !== null, memory: memoryCount !== null || guardrailCount !== null, insights: !!onInsights });
  return (
    <View style={{ borderBottomWidth: 1, borderColor: colors.border }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          flexDirection: "row",
          alignItems: "center",
          gap: space[1],
          paddingHorizontal: space[3],
          height: touch ? 40 : 34,
        }}
      >
        <View accessibilityLabel={[tn(o.total, "{n} task", "{n} tasks"), o.done !== null ? t("{n} done", { n: o.done }) : ""].filter(Boolean).join(", ")} style={{ flexDirection: "row", alignItems: "baseline", gap: 4, paddingRight: space[1.5] }}>
          <Label bold size={font.md} selectable={false}>{String(o.total)}</Label>
          <Label muted size={font.sm} selectable={false}>{o.total === 1 ? t("task") : t("tasks")}</Label>
          {o.done !== null && o.total > 0 && (
            <Label muted size={font.sm} selectable={false}>{t("· {n} done", { n: o.done })}</Label>
          )}
        </View>
        {row.statusDivider && <Divider />}
        {row.running && (
          <Chip
            label={o.runningSessions > o.runningTasks ? t("{tasks} running ({sessions})", { tasks: tn(o.runningTasks, "{n} task", "{n} tasks"), sessions: tn(o.runningSessions, "{n} session", "{n} sessions") }) : t("{tasks} running", { tasks: tn(o.runningTasks, "{n} task", "{n} tasks") })}
            icon={<PulseDot color={colors.statusSuccess} size={7} />}
            onPress={onRunning}
          >
            {t("{n} running", { n: o.runningTasks })}
          </Chip>
        )}
        {row.needYou && (
          <Chip label={tn(needYou, "{n} ask waiting on you. Step through it", "{n} asks waiting on you. Step through them")} icon={<Dot size={7} color={colors.statusWarning} />} onPress={onNeedYou} strong>
            {tn(needYou, "{n} needs you", "{n} need you")}
          </Chip>
        )}
        {row.updated && (
          <Chip label={`${tn(updated, "{n} card has something new to read. Step through it", "{n} cards have something new to read. Step through them")}${updatedShortcut ? ` (${updatedShortcut})` : ""}`} icon={<Dot size={7} color={colors.accent} />} onPress={onUpdated}>
            {t("{n} updated", { n: updated })}
          </Chip>
        )}
        {row.toolsDivider && <Divider />}
        {openIdeas !== null && (
        <Chip
          label={`${t("Project ideas: {openIdeas} open", { openIdeas })}${ideasShortcut ? ` (${ideasShortcut})` : ""}`}
          icon={<Icon name="Lightbulb" size={13} color={openIdeas ? colors.statusWarning : colors.foregroundMuted} />}
          onPress={onIdeas}
        >
          {openIdeas ? t("Ideas {openIdeas}", { openIdeas }) : t("Ideas")}
        </Chip>
        )}
        {guardrailCount !== null && (
          <Chip
            label={`${guardrailCount ? t("Guardrails: {n} new or observing", { n: guardrailCount }) : t("Guardrails")}${guardrailsShortcut ? ` (${guardrailsShortcut})` : ""}`}
            icon={<Icon name="ShieldCheck" size={13} color={guardrailCount ? colors.accent : colors.foregroundMuted} />}
            onPress={onGuardrails}
          >
            {guardrailCount ? t("Guardrails {n}", { n: guardrailCount }) : t("Guardrails")}
          </Chip>
        )}
        {memoryCount !== null && (
          <Chip
            label={`${memoryCount ? t("Memory: {n} added this week", { n: memoryCount }) : t("Memory")}${memoryShortcut ? ` (${memoryShortcut})` : ""}`}
            icon={<Icon name="BookMarked" size={13} color={memoryCount ? colors.accent : colors.foregroundMuted} />}
            onPress={onMemory}
          >
            {memoryCount ? t("Memory {n}", { n: memoryCount }) : t("Memory")}
          </Chip>
        )}
        {onInsights && (
        <Chip label={`${t("Project insights")}${insightsShortcut ? ` (${insightsShortcut})` : ""}`} icon={<Icon name="Activity" size={13} color={colors.foregroundMuted} />} onPress={onInsights}>
          {t("Insights")}</Chip>
        )}
      </ScrollView>
    </View>
  );
}

function Divider() {
  const { colors } = useTheme();
  return <View style={{ width: 1, height: 14, marginHorizontal: space[1], backgroundColor: colors.border }} />;
}

function Chip({
  icon,
  label,
  onPress,
  strong,
  children,
}: {
  icon: ReactNode;
  label: string;
  onPress?(): void;
  strong?: boolean;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  const content = (
    <>
      {icon}
      <Label size={font.sm} medium={strong} selectable={false}>
        {children}
      </Label>
    </>
  );
  const base = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    height: touch ? 30 : 24,
    paddingHorizontal: space[1.5] + 2,
    borderRadius: radius.md,
  };
  return (
    <Enter distance={3}>
      {onPress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={onPress}
          style={(state) => {
            const { hovered, pressed, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
            return { ...noFocusRing, ...base, backgroundColor: hovered || pressed ? colors.surface2 : "transparent" };
          }}
        >
          {content}
        </Pressable>
      ) : (
        <View accessibilityLabel={label} style={base}>
          {content}
        </View>
      )}
    </Enter>
  );
}
