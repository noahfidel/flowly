import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, Pressable, View } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { msg, t, tn } from "../shared/i18n";
import { userSendOptions, type ChatItem } from "../shared/dispatcher";
import { Button, IconButton, Label, Notice, TextBox, font, message, noFocusRing, radius, space, touch, useTheme, verticalScroll } from "./ui";
import { ActivityBlock, TranscriptEntry } from "./session-transcript";
import { useSessionTimeline } from "./session-timeline";
import { coalescedRefresh } from "./session-follow";
import { Collapse } from "./disclosure";
import { useReducedMotion } from "./motion";
import { useKeyboardInset } from "./keyboard";
import { dispatcherItemsKey, useDispatcherItemsQuery } from "./queries";
import { useStableCallback } from "./stable";
import { displayRows, mergeTimeline, sameItem, type DisplayRow } from "./dispatcher-panel-logic";
import { AnswerRow, AskRow } from "./dispatcher-asks";
import { markAsksAnswered } from "./answered-asks";

/** The dispatcher chat next to the board (DISPATCHER-SPEC §9.3). */

const statusKey = ["flowly", "dispatcher", "status"] as const;
const noteKinds: Record<string, string> = {
  question: msg("Question"),
  blocker: msg("Blocker"),
  result: msg("Result"),
  turn_failed: msg("Turn failed"),
};

type Props = {
  /** Shown: only then are the status, items and transcript read and the stream followed. */
  visible: boolean;
  /** A card's lane name in its own project. */
  laneOf(projectId: string, status: string): string;
  onOpenCard(taskId: string): void;
  onClose(): void;
  /** The bell's jump to an ask (§9.4): scroll to its row and outline it; a new `key` jumps again. */
  focus?: { signal: string; key: number } | null;
};

export const DispatcherPanel = memo(function DispatcherPanel({ visible, laneOf, onOpenCard, onClose, focus }: Props) {
  const { colors } = useTheme();
  const paseo = usePaseo();
  const client = useQueryClient();
  const readStatus = useRpc(rpc.dispatcherStatus);
  const startRpc = useRpc(rpc.dispatcherStart);
  const status = useQuery({ queryKey: statusKey, queryFn: () => readStatus({}), enabled: visible, refetchInterval: visible ? 5_000 : false, placeholderData: (p) => p });
  const items = useDispatcherItemsQuery(visible);
  const state = status.data?.state;
  const agentId = status.data?.agentId ?? null;
  const up = state === "running" || state === "idle";
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);

  // The transcript: read while shown, refreshed by the agent's timeline stream while it is up.
  const [streamReady, setStreamReady] = useState(false);
  const timeline = useSessionTimeline({ taskId: "dispatcher", agentId: agentId ?? "-", enabled: visible && !!agentId, streamReady, dispatcher: true });
  const refetch = timeline.query.refetch;
  useEffect(() => {
    if (!visible || !agentId || !up) return;
    let alive = true;
    const updates = coalescedRefresh(() => void refetch({ cancelRefetch: false }), 400);
    const subscription = paseo.agents.ref(agentId).timeline.subscribe(() => {
      if (alive) updates.trigger();
    });
    void subscription.ready.then(
      () => alive && setStreamReady(true),
      () => undefined,
    );
    return () => {
      alive = false;
      setStreamReady(false);
      updates.dispose();
      subscription();
    };
  }, [paseo, agentId, visible, up]);

  const rows = useMemo(() => displayRows(mergeTimeline(timeline.query.data?.entries ?? [], items.data ?? [])), [timeline.query.data?.entries, items.data]);
  const lastKey = rows.at(-1)?.key;

  const start = useStableCallback(async () => {
    setError("");
    setStarting(true);
    try {
      await startRpc({});
      await client.invalidateQueries({ queryKey: statusKey });
    } catch (e) {
      // HOST_UNSUPPORTED and START_FAILED arrive with a readable message (DISPATCHER-SPEC §2, §8).
      setError(message(e));
    } finally {
      setStarting(false);
    }
  });
  const refreshItems = useStableCallback(() => {
    void client.invalidateQueries({ queryKey: dispatcherItemsKey });
    void client.invalidateQueries({ queryKey: ["flowly", "attention-count"] });
  });
  // An answer row is addressed to its card: the title comes from the ask it answers.
  const askTitles = useMemo(() => new Map((items.data ?? []).flatMap((item) => (item.kind === "ask" ? [[item.signal, item.title] as const] : []))), [items.data]);
  // Asks the chat lists as answered, ended or dismissed leave the bell too, until the live list drops them (§9.4).
  useEffect(() => {
    markAsksAnswered((items.data ?? []).flatMap((item) => (item.kind === "ask" && item.state !== "open" ? [item.signal] : [])));
  }, [items.data]);

  // Follow the newest output unless the user scrolled up.
  const scroll = useRef<{ scrollToEnd(options?: { animated?: boolean }): void; scrollTo(options: { y: number; animated?: boolean }): void } | null>(null);
  // Row offsets, for the bell's jump to an ask.
  const offsets = useRef(new Map<string, number>());
  const focusedKey = focus ? `item-ask-${focus.signal}` : "";
  useEffect(() => {
    if (!focusedKey) return;
    const y = offsets.current.get(focusedKey);
    if (y === undefined) return;
    following.current = false;
    scroll.current?.scrollTo({ y: Math.max(0, y - space[3]), animated: true });
  }, [focus?.key, focusedKey, rows]);
  const following = useRef(true);
  const onScroll = useStableCallback((e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    following.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 48;
  });
  const keyboard = useKeyboardInset(visible, useReducedMotion());

  const renderRow = useCallback(
    (row: DisplayRow) =>
      row.kind === "block" ? (
        row.block.kind === "activity" ? (
          <ActivityBlock block={row.block} live={state === "running" && row.key === lastKey} />
        ) : (
          <TranscriptEntry entry={row.block.entry} taskId="dispatcher" agentId={agentId ?? ""} />
        )
      ) : row.kind === "summary" ? (
        <SummaryRow />
      ) : row.item.kind === "ask" ? (
        <AskRow item={row.item} focused={row.key === focusedKey} onOpenCard={onOpenCard} onChanged={refreshItems} />
      ) : row.item.kind === "answer" ? (
        <AnswerRow item={row.item} title={askTitles.get(row.item.signal) ?? ""} onOpenCard={onOpenCard} />
      ) : (
        <ItemRow item={row.item} laneOf={laneOf} onOpenCard={onOpenCard} onChanged={refreshItems} />
      ),
    [state, lastKey, agentId, laneOf, onOpenCard, refreshItems, focusedKey, askTitles],
  );

  return (
    <View ref={keyboard.ref} onLayout={keyboard.onLayout} style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: colors.surface0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], paddingHorizontal: space[3], paddingVertical: space[2], borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Icon name="Bot" size={16} color={colors.foregroundMuted} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label bold size={font.base} lines={1} selectable={false}>{t("Dispatcher")}</Label>
        </View>
        {state === "running" && <ActivityIndicator size="small" color={colors.accent} />}
        <IconButton icon="X" label={t("Close")} onPress={onClose} />
      </View>
      <ScrollView
        {...verticalScroll}
        ref={scroll as never}
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ padding: space[3], paddingBottom: space[3] + keyboard.inset, gap: space[3] }}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={100}
        onScroll={onScroll}
        onContentSizeChange={() => following.current && scroll.current?.scrollToEnd({ animated: false })}
      >
        {timeline.canLoadEarlier && (
          <View style={{ alignItems: "center" }}>
            <Button quiet small icon="ArrowUp" disabled={timeline.loadingEarlier} onPress={() => void timeline.loadEarlier()}>
              {t("Load earlier")}
            </Button>
          </View>
        )}
        {rows.map((row) => (
          <View key={row.key} onLayout={row.kind === "item" && row.item.kind === "ask" ? (e) => void offsets.current.set(row.key, e.nativeEvent.layout.y) : undefined}>
            {renderRow(row)}
          </View>
        ))}
        {status.isPending && visible && <ActivityIndicator size="small" color={colors.foregroundMuted} />}
        {!!status.error && <Notice>{message(status.error)}</Notice>}
        {!!state && !up && (
          <View style={{ gap: space[2], alignItems: "flex-start" }}>
            <Label muted size={font.md}>
              {state === "ended"
                ? t("The dispatcher session ended.")
                : state === "context_full"
                  ? t("The dispatcher's context is full. A new one starts from the board.")
                  : t("Starts one agent session that works across all your projects.")}
            </Label>
            <Button primary icon="Play" disabled={starting} onPress={() => void start()}>
              {t("Start dispatcher")}
            </Button>
            {!!error && <Notice>{error}</Notice>}
          </View>
        )}
      </ScrollView>
      {up && agentId && (
        <Animated.View style={{ flexShrink: 0, backgroundColor: colors.surface0, transform: [{ translateY: keyboard.translate }], borderTopWidth: 1, borderTopColor: colors.border, padding: space[2] }}>
          <Composer
            agentId={agentId}
            onSent={() => {
              following.current = true;
              void refetch();
            }}
          />
        </Animated.View>
      )}
    </View>
  );
});

/**
 * Sends exactly the typed text to the dispatcher with the host's Paseo client (no second connection), always
 * steering (`userSendOptions`). The Send button sends; Enter adds a line (a multiline native input never submits).
 */
function Composer({ agentId, onSent }: { agentId: string; onSent(): void }) {
  const { colors } = useTheme();
  const paseo = usePaseo();
  const text = useRef("");
  const [empty, setEmpty] = useState(true);
  // A new key clears the box after a send (an outside change, as TextBox expects).
  const [box, setBox] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const send = useStableCallback(async () => {
    const value = text.current.trim();
    if (!value || sending) return;
    setSending(true);
    setError("");
    try {
      await paseo.agents.ref(agentId).send(value, userSendOptions);
      text.current = "";
      setEmpty(true);
      setBox((n) => n + 1);
      onSent();
    } catch (e) {
      setError(message(e));
    } finally {
      setSending(false);
    }
  });
  return (
    <View style={{ gap: space[1.5] }}>
      {!!error && <Notice>{error}</Notice>}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space[2] }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <TextBox
            key={box}
            value=""
            autoFocus={box > 0}
            multiline
            placeholder={t("Message the dispatcher")}
            placeholderTextColor={colors.foregroundMuted}
            onChangeText={(next) => {
              text.current = next;
              setEmpty((was) => (was === !next.trim() ? was : !next.trim()));
            }}
            style={{ minHeight: touch ? 40 : 32, maxHeight: 140, paddingHorizontal: space[2], paddingVertical: space[1.5], borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, color: colors.foreground, backgroundColor: colors.surface1, fontSize: font.base }}
          />
        </View>
        <IconButton icon="Send" label={t("Send")} disabled={empty || sending} onPress={() => void send()} />
      </View>
    </View>
  );
}

function SummaryRow() {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
      <Icon name="ClipboardList" size={12} color={colors.foregroundMuted} />
      <Label muted size={font.sm} selectable={false}>{t("Board summary")}</Label>
    </View>
  );
}

/** A note's detail with its lane ids (`in_progress → in_review`) shown as lane names. */
function noteDetail(item: Extract<ChatItem, { kind: "note" }>, laneOf: Props["laneOf"]) {
  const { note } = item;
  const lanes = note.kind === "status_changed" ? note.detail.replace(/^(\S*) → (\S+)/, (_, from: string, to: string) => `${from ? `${laneOf(note.projectId, from)} → ` : ""}${laneOf(note.projectId, to)}`) : note.detail;
  return [lanes, note.later ? note.later : ""].filter(Boolean).join("; ");
}

const ItemRow = memo(function ItemRow({ item, laneOf, onOpenCard, onChanged }: { item: ChatItem; laneOf: Props["laneOf"]; onOpenCard(taskId: string): void; onChanged(): void }) {
  const { colors } = useTheme();
  if (item.kind === "change") return <ChangeRow item={item} laneOf={laneOf} onOpenCard={onOpenCard} onChanged={onChanged} />;
  if (item.kind === "note") {
    const kind = noteKinds[item.note.kind];
    const detail = noteDetail(item, laneOf);
    const line = [item.note.title, kind ? t(kind) : "", detail].filter(Boolean).join(" · ") + (item.note.earlier ? ` (+${item.note.earlier})` : "");
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={line} onPress={() => onOpenCard(item.note.taskId)} style={{ ...noFocusRing, flexDirection: "row", alignItems: "center", gap: space[1.5], minWidth: 0 }}>
        <Icon name="CornerDownRight" size={12} color={colors.foregroundMuted} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label muted size={font.sm} lines={1} selectable={false}>{line}</Label>
        </View>
      </Pressable>
    );
  }
  // Asks and answers render as AskRow / AnswerRow (dispatcher-asks.tsx); this one line is only a fallback.
  return (
    <Pressable accessibilityRole="button" onPress={() => onOpenCard(item.taskId)} style={{ ...noFocusRing, flexDirection: "row", alignItems: "center", gap: space[1.5], minWidth: 0 }}>
      <Icon name={item.kind === "ask" ? "MessageCircleQuestion" : "Reply"} size={12} color={colors.foregroundMuted} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.sm} lines={1} selectable={false}>{item.kind === "ask" ? item.title : item.text}</Label>
      </View>
    </Pressable>
  );
}, (a, b) => a.laneOf === b.laneOf && a.onOpenCard === b.onOpenCard && a.onChanged === b.onChanged && sameItem(a.item, b.item));

/** "Changed since you looked" (§9.2): collapsed to its count; open, the cards plus Mark seen and What should I do?. */
function ChangeRow({ item, laneOf, onOpenCard, onChanged }: { item: Extract<ChatItem, { kind: "change" }>; laneOf: Props["laneOf"]; onOpenCard(taskId: string): void; onChanged(): void }) {
  const { colors } = useTheme();
  const markSeen = useRpc(rpc.dispatcherMarkSeen);
  const whatNext = useRpc(rpc.dispatcherWhatNext);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = (job: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    void job()
      .then(onChanged, (e) => setError(message(e)))
      .finally(() => setBusy(false));
  };
  const count = tn(item.cards.length, "{n} card changed since you looked", "{n} cards changed since you looked");
  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.surface1 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={count}
        onPress={() => setOpen(!open)}
        style={{ ...noFocusRing, flexDirection: "row", alignItems: "center", gap: space[1.5], paddingHorizontal: space[2], minHeight: touch ? 36 : 30 }}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={12} color={colors.foregroundMuted} />
        <Label medium size={font.sm} selectable={false}>{count}</Label>
      </Pressable>
      <Collapse open={open} id="dispatcher-change">
        <View style={{ paddingHorizontal: space[2], paddingBottom: space[2], gap: space[1.5] }}>
          {item.cards.map((card) => (
            <Pressable key={card.taskId} accessibilityRole="button" onPress={() => onOpenCard(card.taskId)} style={{ ...noFocusRing, flexDirection: "row", gap: space[2], minWidth: 0 }}>
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
            <Button small primary disabled={busy} onPress={() => run(() => whatNext({}))}>
              {t("What should I do?")}
            </Button>
          </View>
          {!!error && <Notice>{error}</Notice>}
        </View>
      </Collapse>
    </View>
  );
}
