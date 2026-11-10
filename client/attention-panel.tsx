import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { t, tn } from "../shared/i18n";
import { Button, Label, Notice, SectionHeader, font, message, noFocusRing, radius, space, verticalContent, verticalScroll, useTheme } from "./ui";
import { AskRow } from "./dispatcher-asks";
import { markAsksAnswered, useAnsweredAsks } from "./answered-asks";
import { asksResolvedKey, dispatcherItemsKey, useDispatcherItemsQuery } from "./queries";
import { useStableCallback } from "./stable";
import { dispatcherStartMessage } from "./start-again";
import { dispatcherStatusKey } from "./dispatcher-panel";
import { attentionSections, type ChangeItem } from "./dock-logic";

/**
 * The dock's Attention tab (DISPATCHER-SPEC §9.4, ATTENTION-DISMISS-SPEC §3; Ruling, Noah 2026-11-09): every open
 * ask, answered in place through `asks.answer` / `asks.dismiss`; the dismissed cards with Restore; and the cards
 * that changed since you looked, which never count toward the bell.
 */

type Props = {
  /** Shown: only then are the items read. */
  visible: boolean;
  laneOf(projectId: string, status: string): string;
  onOpenCard(taskId: string): void;
  /** Ask dispatcher was sent: the dock shows the Dispatcher tab. */
  onAskedDispatcher(): void;
  /** Shown above the asks (read state unavailable). */
  notice?: ReactNode;
  /** The Dismissed · N group with Restore, rendered by the board (ATTENTION-DISMISS-SPEC §3.1). */
  dismissed?: ReactNode;
  /** Cards are dismissed: the empty state says nothing *new* needs you. */
  anyDismissed: boolean;
};

export const AttentionPanel = memo(function AttentionPanel({ visible, laneOf, onOpenCard, onAskedDispatcher, notice, dismissed, anyDismissed }: Props) {
  const { colors } = useTheme();
  const client = useQueryClient();
  const items = useDispatcherItemsQuery(visible);
  const answered = useAnsweredAsks();
  const sections = useMemo(() => attentionSections(items.data, answered), [items.data, answered]);
  // Asks listed as answered, ended or dismissed leave the bell too, until the live list drops them (§9.4).
  useEffect(() => {
    markAsksAnswered((items.data ?? []).flatMap((item) => (item.kind === "ask" && item.state !== "open" ? [item.signal] : [])));
  }, [items.data]);
  const refresh = useStableCallback(() => {
    void client.invalidateQueries({ queryKey: dispatcherItemsKey });
    void client.invalidateQueries({ queryKey: ["flowly", "attention-count"] });
    void client.invalidateQueries({ queryKey: asksResolvedKey });
  });
  return (
    <ScrollView {...verticalScroll} style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }} contentContainerStyle={{ ...verticalContent, padding: space[3], gap: space[3] }}>
      {notice}
      <View style={{ gap: space[2] }}>
        <SectionHeader title={t("Needs you")} count={sections.needs.length || undefined} />
        {items.error && !items.data ? (
          <Notice>{message(items.error)}</Notice>
        ) : !items.data ? (
          <View style={{ paddingVertical: space[4], alignItems: "center" }}>
            <ActivityIndicator size="small" color={colors.foregroundMuted} />
          </View>
        ) : sections.needs.length ? (
          sections.needs.map((ask) => <AskRow key={ask.signal} item={ask} focused={false} onOpenCard={onOpenCard} onChanged={refresh} />)
        ) : (
          <View style={{ paddingVertical: space[4], alignItems: "center", gap: space[2] }}>
            <Icon name="BellOff" size={20} color={colors.foregroundMuted} />
            <Label muted>{anyDismissed ? t("Nothing new needs your attention.") : t("Nothing needs your attention.")}</Label>
          </View>
        )}
      </View>
      {dismissed}
      {sections.updates && <Updates visible={visible} item={sections.updates} laneOf={laneOf} onOpenCard={onOpenCard} onChanged={refresh} onAsked={onAskedDispatcher} />}
    </ScrollView>
  );
});

/** "N cards changed since you looked" (§9.2): the cards, Mark seen, and Ask dispatcher. Never an ask. */
function Updates({ visible, item, laneOf, onOpenCard, onChanged, onAsked }: { visible: boolean; item: ChangeItem; laneOf: Props["laneOf"]; onOpenCard(taskId: string): void; onChanged(): void; onAsked(): void }) {
  const { colors } = useTheme();
  const markSeen = useRpc(rpc.dispatcherMarkSeen);
  const whatNext = useRpc(rpc.dispatcherWhatNext);
  const readStatus = useRpc(rpc.dispatcherStatus);
  // The dispatcher chat's own status read (shared key): an unguarded one takes no messages from the user (§3).
  const status = useQuery({ queryKey: dispatcherStatusKey, queryFn: () => readStatus({}), enabled: visible, refetchInterval: visible ? 5_000 : false, placeholderData: (p) => p });
  const up = status.data?.state === "running" || status.data?.state === "idle";
  const locked = up && !!status.data?.unguarded;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = (job: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError("");
    void job()
      .then(() => {
        onChanged();
        after?.();
      }, (e) => setError(dispatcherStartMessage(message(e))))
      .finally(() => setBusy(false));
  };
  return (
    <View style={{ gap: space[2], paddingTop: space[3], borderTopWidth: 1, borderTopColor: colors.border }}>
      <SectionHeader title={t("Updates")} />
      <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.surface1, padding: space[2], gap: space[1.5] }}>
        <Label medium size={font.sm} selectable={false}>
          {tn(item.cards.length, "{n} card changed since you looked", "{n} cards changed since you looked")}
        </Label>
        {item.cards.map((card) => (
          <Pressable key={card.taskId} accessibilityRole="button" accessibilityLabel={t("Open {title}", { title: card.title })} onPress={() => onOpenCard(card.taskId)} style={{ ...noFocusRing, flexDirection: "row", gap: space[2], minWidth: 0 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Label size={font.sm} lines={1} selectable={false}>{card.title}</Label>
            </View>
            <Label muted size={font.sm} selectable={false}>{laneOf(card.projectId, card.status)}</Label>
          </Pressable>
        ))}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2], paddingTop: space[1] }}>
          <Button small disabled={busy} onPress={() => run(() => markSeen({ revision: item.revision, ids: item.ids }))}>
            {t("Mark seen")}
          </Button>
          <Button small primary disabled={busy || locked} onPress={() => run(() => whatNext({}), onAsked)}>
            {t("Ask dispatcher")}
          </Button>
        </View>
        {!!error && <Notice>{error}</Notice>}
      </View>
    </View>
  );
}
