import { memo, useCallback } from "react";
import { Animated, Pressable, ScrollView, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PaseoAgent } from "@getpaseo/client";
import { Dot, Label, font, noFocusRing, radius, space, touch, useTheme } from "./ui";
import { stateColors } from "./state-colors";
import { PulseDot, lerp, useMotionPresence } from "./motion";
import { useLiveAgents } from "./queries";
import { sessionState } from "./session-state";
import { sessionTone } from "./status";
import { chipSegments, childAgents, subagentBucket, subagentCounts, type SubagentBucket } from "../shared/subagents";
import { t, tn } from "../shared/i18n";

const segmentText = (bucket: SubagentBucket, n: number) =>
  bucket === "running"
    ? t("{n} working", { n })
    : bucket === "needs_input"
      ? tn(n, "{n} needs input", "{n} need input")
      : bucket === "failed"
        ? t("{n} failed", { n })
        : t("{n} ready to review", { n });

/** "2 working, 1 needs input", else "3 subagents": the chip text, also used by the sidebar's subagent rows. */
export function subagentSummary(children: readonly Parameters<typeof subagentBucket>[0][]) {
  const segments = chipSegments(subagentCounts(children));
  // The total always leads, also while some run or wait: "3 subagents · 2 working, 1 ready to review".
  const total = tn(children.length, "{n} subagent", "{n} subagents");
  return segments.length ? `${total} · ${segments.map((s) => segmentText(s.bucket, s.count)).join(", ")}` : total;
}

/**
 * The session's Paseo-native child agents as a chip above the message box, with
 * an upward list; a row opens that agent in a Paseo agent pane (SUBAGENTS-SPEC).
 * Reads the shared live agent list: no polling of its own.
 */
export const SubagentsChip = memo(function SubagentsChip({
  sessionId,
  open,
  onToggle,
  onOpenAgent,
}: {
  sessionId: string;
  open: boolean;
  onToggle(): void;
  /** Missing when the host cannot open agent panes. */
  onOpenAgent?: (agentId: string) => void;
}) {
  const { colors } = useTheme();
  const children = useLiveAgents({
    poll: false,
    select: useCallback((agents: PaseoAgent[]) => childAgents(agents, sessionId), [sessionId]),
  }).data;
  const presence = useMotionPresence(open && children?.length ? true : undefined, open ? "subagents" : "");
  if (!children?.length) return null;
  const counts = subagentCounts(children);
  const segments = chipSegments(counts);
  const summary = subagentSummary(children);
  const segmentDot = (bucket: SubagentBucket) =>
    bucket === "running" ? (
      <PulseDot color={stateColors(colors).running} size={7} />
    ) : (
      <Dot size={6} color={bucket === "needs_input" ? stateColors(colors).needsYou : bucket === "failed" ? stateColors(colors).error : colors.statusSuccess} />
    );
  return (
    <View style={{ position: "relative", alignSelf: "flex-start", maxWidth: "100%" }}>
      {presence.item && (
        <Animated.View
          pointerEvents={presence.active ? "auto" : "none"}
          style={{
            position: "absolute",
            left: 0,
            bottom: "100%",
            marginBottom: 6,
            minWidth: 260,
            maxWidth: 360,
            zIndex: 30,
            padding: 4,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface0,
            shadowColor: "#000",
            shadowOpacity: 0.12,
            shadowRadius: 16,
            shadowOffset: { width: 0, height: 6 },
            opacity: presence.progress,
            transform: [{ translateY: lerp(presence.progress, [6, 0]) }],
          }}
        >
          <View style={{ paddingHorizontal: space[2] + 2, paddingTop: 4, paddingBottom: 2 }}>
            <Label muted size={font.xs} medium selectable={false}>{t("Subagents")}</Label>
          </View>
          <ScrollView style={{ maxHeight: 320 }} keyboardShouldPersistTaps="handled">
            {children.map((child) => (
              <SubagentRow key={child.id} agent={child} onOpen={onOpenAgent} />
            ))}
          </ScrollView>
          {!onOpenAgent && (
            <View style={{ paddingHorizontal: space[2] + 2, paddingVertical: space[1.5], borderTopWidth: 1, borderColor: colors.border, marginTop: 4 }}>
              <Label muted size={font.xs}>{t("Open subagents from the Paseo session pane.")}</Label>
            </View>
          )}
        </Animated.View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Subagents: {summary}", { summary })}
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={(state) => {
          const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
          return {
            ...noFocusRing,
            flexDirection: "row",
            alignItems: "center",
            gap: space[2],
            minHeight: 32,
            paddingHorizontal: space[3],
            paddingVertical: space[1],
            borderRadius: 16,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: open || hover || pressed ? colors.surface2 : colors.surface1,
          };
        }}
      >
        <Icon name="Bot" size={14} color={open ? colors.foreground : colors.foregroundMuted} />
        {segments.length > 0 && (
          <Label size={font.sm} color={open ? colors.foreground : colors.foregroundMuted} lines={1} selectable={false}>
            {tn(children.length, "{n} subagent", "{n} subagents")}
          </Label>
        )}
        {segments.length ? (
          segments.map((s) => (
            <View key={s.bucket} style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
              {segmentDot(s.bucket)}
              <Label size={font.sm} color={open ? colors.foreground : colors.foregroundMuted} lines={1} selectable={false}>
                {segmentText(s.bucket, s.count)}
              </Label>
            </View>
          ))
        ) : (
          <Label size={font.sm} color={open ? colors.foreground : colors.foregroundMuted} lines={1} selectable={false}>
            {summary}
          </Label>
        )}
        <Icon name={open ? "ChevronDown" : "ChevronUp"} size={13} color={colors.foregroundMuted} />
      </Pressable>
    </View>
  );
});

function SubagentRow({ agent, onOpen }: { agent: PaseoAgent; onOpen?: (agentId: string) => void }) {
  const { colors } = useTheme();
  const state = sessionState(agent);
  const done = subagentBucket(agent) === "attention";
  const tone = sessionTone(colors, state, done);
  const title = agent.title?.trim() || t("Untitled agent");
  const detail = [t(state.label), [agent.provider, agent.model].filter(Boolean).join(" · ")].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Open {title}", { title })}
      disabled={!onOpen}
      onPress={() => onOpen?.(agent.id)}
      style={(s) => {
        const { pressed, hovered: hover, focused } = s as typeof s & { hovered?: boolean; focused?: boolean };
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[2],
          minHeight: touch ? 44 : 36,
          paddingHorizontal: space[2] + 2,
          paddingVertical: 4,
          borderRadius: radius.md,
          backgroundColor: onOpen && (hover || pressed) ? colors.surface1 : "transparent",
        };
      }}
    >
      <View style={{ width: 10, alignItems: "center" }}>
        <PulseDot color={tone} size={8} active={state.active} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.md} lines={1} selectable={false}>{title}</Label>
        <Label muted size={font.xs} lines={1} selectable={false}>{detail}</Label>
      </View>
      {onOpen && <Icon name="ArrowUpRight" size={13} color={colors.foregroundMuted} />}
    </Pressable>
  );
}
