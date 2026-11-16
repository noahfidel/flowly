import { memo, useCallback, useMemo } from "react";
import { Animated, Pressable, ScrollView, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PaseoAgent } from "@getpaseo/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Dot, Label, font, noFocusRing, radius, space, touch, useTheme } from "./ui";
import { stateColors } from "./state-colors";
import { PulseDot, lerp, useMotionPresence } from "./motion";
import { useLiveAgents } from "./queries";
import { sessionState } from "./session-state";
import { sessionTone } from "./status";
import {
  chipSegments,
  childAgents,
  mergedCounts,
  providerListOrThrow,
  providerTitle,
  subagentBucket,
  subagentCounts,
  subagentRows,
  type ProviderSubagent,
  type ProviderSubagentStatus,
  type SubagentBucket,
  type SubagentCounts,
} from "../shared/subagents";
import { providerSubagents } from "../shared/rpc";
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
  return summaryText(subagentCounts(children), children.length);
}

function summaryText(counts: SubagentCounts, n: number) {
  const segments = chipSegments(counts);
  // The total always leads, also while some run or wait: "3 subagents · 2 working, 1 ready to review".
  const total = tn(n, "{n} subagent", "{n} subagents");
  return segments.length ? `${total} · ${segments.map((s) => segmentText(s.bucket, s.count)).join(", ")}` : total;
}

/** A provider subagent's state, as the list and its transcript header show it. */
export const providerStateLabel = (status: ProviderSubagentStatus) =>
  status === "running" ? t("Running") : status === "failed" ? t("Failed") : status === "canceled" ? t("Canceled") : t("Completed");

/** The muted line under a provider subagent's title: its state, then the provider's own subtitle. */
export const providerDetail = (subagent: ProviderSubagent) =>
  [providerStateLabel(subagent.status), subagent.subtitle?.trim()].filter(Boolean).join(" · ");

export const providerDisplayTitle = (subagent: ProviderSubagent) => providerTitle(subagent) || t("Untitled agent");

const noProviderSubagents: readonly ProviderSubagent[] = [];

/**
 * A card session's provider subagents (SUBAGENTS-SPEC §9.3): read while `enabled` (the session view
 * is shown, the session not archived), then every 5 s only while the session or one of them runs.
 * Unchanged reads keep the same array (the query's structural sharing); none is a shared empty one.
 * A read that reports `unavailable` throws, so the last good list stays (and keeps polling) until one succeeds.
 */
export function useProviderSubagents(taskId: string, agentId: string, enabled: boolean, sessionRunning: boolean): readonly ProviderSubagent[] {
  const read = useRpc(providerSubagents);
  const query = useQuery({
    queryKey: ["flowly", "provider-subagents", taskId, agentId],
    queryFn: async () => providerListOrThrow(await read({ taskId, agentId })),
    enabled,
    retry: false,
    refetchInterval: (q) => (sessionRunning || q.state.data?.subagents.some((s) => s.status === "running") ? 5000 : false),
  });
  return query.data?.subagents.length ? query.data.subagents : noProviderSubagents;
}

/**
 * The session's subagents as a chip above the message box, with an upward list
 * (SUBAGENTS-SPEC): its Paseo-native child agents from the shared live agent
 * list, then the provider subagents the caller reads (`useProviderSubagents`).
 * A native row opens that agent in the side bar or a Paseo agent pane; a
 * provider row opens its read-only transcript (§9.4).
 */
export const SubagentsChip = memo(function SubagentsChip({
  sessionId,
  provider,
  open,
  onToggle,
  onOpenAgent,
  onOpenProvider,
}: {
  sessionId: string;
  provider: readonly ProviderSubagent[];
  open: boolean;
  onToggle(): void;
  /** Missing when the host cannot open agent panes. */
  onOpenAgent?: (agentId: string) => void;
  onOpenProvider(subagentId: string): void;
}) {
  const { colors } = useTheme();
  const children = useLiveAgents({
    poll: false,
    select: useCallback((agents: PaseoAgent[]) => childAgents(agents, sessionId), [sessionId]),
  }).data;
  const native = children ?? noChildren;
  const total = native.length + provider.length;
  const rows = useMemo(() => subagentRows(native, provider), [native, provider]);
  const presence = useMotionPresence(open && total ? true : undefined, open ? "subagents" : "");
  if (!total) return null;
  const counts = mergedCounts(native, provider);
  const segments = chipSegments(counts);
  const summary = summaryText(counts, total);
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
            {rows.map((row) =>
              row.kind === "native" ? (
                <SubagentRow key={row.agent.id} agent={row.agent} onOpen={onOpenAgent} />
              ) : (
                <ProviderRow key={`provider:${row.subagent.id}`} subagent={row.subagent} depth={row.depth} onOpen={onOpenProvider} />
              ),
            )}
          </ScrollView>
          {!onOpenAgent && native.length > 0 && (
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
            {tn(total, "{n} subagent", "{n} subagents")}
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

const noChildren: PaseoAgent[] = [];

/** A provider subagent (§9.3): state dot, title, state · subtitle; nested ones one step in. Opens its transcript. */
function ProviderRow({ subagent, depth, onOpen }: { subagent: ProviderSubagent; depth: 0 | 1; onOpen(subagentId: string): void }) {
  const { colors } = useTheme();
  const running = subagent.status === "running";
  const tone = sessionTone(colors, { label: subagent.status === "failed" ? "Error" : "Idle", active: running });
  const title = providerDisplayTitle(subagent);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Open {title}", { title })}
      onPress={() => onOpen(subagent.id)}
      style={(s) => {
        const { pressed, hovered: hover } = s as typeof s & { hovered?: boolean };
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[2],
          minHeight: touch ? 44 : 36,
          paddingLeft: space[2] + 2 + (depth ? space[4] : 0),
          paddingRight: space[2] + 2,
          paddingVertical: 4,
          borderRadius: radius.md,
          backgroundColor: hover || pressed ? colors.surface1 : "transparent",
        };
      }}
    >
      <View style={{ width: 10, alignItems: "center" }}>
        <PulseDot color={tone} size={8} active={running} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.md} lines={1} selectable={false}>{title}</Label>
        <Label muted size={font.xs} lines={1} selectable={false}>{providerDetail(subagent)}</Label>
      </View>
      <Icon name="ChevronRight" size={13} color={colors.foregroundMuted} />
    </Pressable>
  );
}
