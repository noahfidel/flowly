import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { Dot, Label, font, noFocusRing, radius, space, touch, useTheme } from "./ui";
import { Enter, PulseDot } from "./motion";
import type { BoardOverview } from "./overview";
import { t, tn } from "../shared/i18n";

/**
 * Board header summary: how many cards, how many have agents working, and
 * what is waiting on you. Attention items open the Attention list. No lane chips (Ruling, Noah 2026-11-09).
 */
export function OverviewBar({
  overview,
  onAttention,
  onInsights,
  insightsShortcut,
  openIdeas,
  onIdeas,
  ideasShortcut,
  memoryCandidates,
  onMemory,
  memoryShortcut,
}: {
  overview: BoardOverview;
  onAttention(): void;
  /** Open project Insights (PROJECT-INSIGHTS-SPEC §9). */
  /** Absent when Insights is off (ONBOARDING-SETUP-SPEC §6). */
  onInsights?(): void;
  insightsShortcut: string;
  /** Open ideas across the project's cards, finished and archived ones included (IDEAS-INBOX-SPEC §3.1); null when Ideas are off. */
  openIdeas: number | null;
  onIdeas(): void;
  ideasShortcut: string;
  /** Project memory candidates waiting for review (PROJECT-MEMORY-SPEC §8.1); null when memory is off for the project. */
  memoryCandidates: number | null;
  onMemory(): void;
  memoryShortcut: string;
}) {
  const { colors } = useTheme();
  const o = overview;
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
        <Divider />
        <Chip
          label={o.runningTasks ? (o.runningSessions > o.runningTasks ? t("{tasks} running ({sessions})", { tasks: tn(o.runningTasks, "{n} task", "{n} tasks"), sessions: tn(o.runningSessions, "{n} session", "{n} sessions") }) : t("{tasks} running", { tasks: tn(o.runningTasks, "{n} task", "{n} tasks") })) : t("Nothing running")}
          icon={o.runningTasks ? <PulseDot color={colors.statusSuccess} size={7} /> : <Dot size={7} color={colors.border} />}
          muted={!o.runningTasks}
        >
          {o.runningTasks ? t("{n} running", { n: o.runningTasks }) : t("Idle")}
        </Chip>
        {o.needsYou > 0 && (
          <Chip label={tn(o.needsYou, "{n} task waiting on you. Open Attention", "{n} tasks waiting on you. Open Attention")} icon={<Dot size={7} color={colors.statusWarning} />} onPress={onAttention} strong>
            {tn(o.needsYou, "{n} needs you", "{n} need you")}
          </Chip>
        )}
        {o.unread > 0 && (
          <Chip label={tn(o.unread, "{n} task with unread results. Open Attention", "{n} tasks with unread results. Open Attention")} icon={<Dot size={7} color={colors.accent} />} onPress={onAttention}>
            {t("{n} unread", { n: o.unread })}
          </Chip>
        )}
        {o.errors > 0 && (
          <Chip label={tn(o.errors, "{n} task with session errors. Open Attention", "{n} tasks with session errors. Open Attention")} icon={<Dot size={7} color={colors.statusDanger} />} onPress={onAttention}>
            {tn(o.errors, "{n} error", "{n} errors")}
          </Chip>
        )}
        <Divider />
        {openIdeas !== null && (
        <Chip
          label={`${t("Project ideas: {openIdeas} open", { openIdeas })}${ideasShortcut ? ` (${ideasShortcut})` : ""}`}
          icon={<Icon name="Lightbulb" size={13} color={openIdeas ? colors.statusWarning : colors.foregroundMuted} />}
          onPress={onIdeas}
        >
          {openIdeas ? t("Ideas {openIdeas}", { openIdeas }) : t("Ideas")}
        </Chip>
        )}
        {memoryCandidates !== null && (
          <Chip
            label={`${t("Project memory: {n} to review", { n: memoryCandidates })}${memoryShortcut ? ` (${memoryShortcut})` : ""}`}
            icon={<Icon name="BookMarked" size={13} color={memoryCandidates ? colors.accent : colors.foregroundMuted} />}
            onPress={onMemory}
          >
            {memoryCandidates ? t("Memory {n}", { n: memoryCandidates }) : t("Memory")}
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
  muted,
  strong,
  children,
}: {
  icon: ReactNode;
  label: string;
  onPress?(): void;
  muted?: boolean;
  strong?: boolean;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  const content = (
    <>
      {icon}
      <Label size={font.sm} medium={strong} muted={muted} selectable={false}>
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
