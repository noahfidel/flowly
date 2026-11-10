import { perfStart, perfEnd, usePerfRender } from "./perf";
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactElement, type Ref } from "react";
import { ActivityIndicator, Animated, Platform, Pressable, View, type ListRenderItemInfo } from "react-native";
import { FlatList, Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { usePaseo } from "@getpaseo/plugin/client";
import { Label, Notice, font, message, noFocusRing, radius, space, touch, useTheme, verticalContent, verticalScroll, type Tone } from "./ui";
import { activitySummary, groupTranscript, lastOutputRow, pendingEchoes, recentSessionOutput, type SentEcho, type TranscriptBlock } from "./session-state";
import { coalescedRefresh, createFocusJump, FOLLOW_SLACK, useSessionFollowTail } from "./session-follow";
import { useSessionTimeline } from "./session-timeline";
import { HISTORY_MAX, type TailEntry } from "../shared/session-tail";
import { extractImages } from "../shared/images";
import { SessionImage } from "./session-image";
import { sentImages } from "./sent-images";
import { SessionMarkdown } from "./session-content";
import { Collapse } from "./disclosure";
import { Enter, PulseDot, motionDuration, useMotionPresence, useMotionValue, lerp } from "./motion";
import { useStableCallback } from "./stable";
import { PendingRequests } from "./session-question";
import type { PendingRequest, PermissionReply } from "../shared/permission-question";
import { t } from "../shared/i18n";

export type TranscriptNotice = { key: string; text: string; tone?: Tone };
export type TranscriptHandle = {
  refresh(): void;
  jumpToLatest(): void;
  /** Shows a message just sent at once, until the timeline holds it (or `unecho` after a failed send). */
  echo(messageId: string, text: string): void;
  unecho(messageId: string): void;
};

/** A row of the caller's own between the transcript's blocks (the dispatcher chat's items, DISPATCHER-SPEC §9.3). */
export type TranscriptExtraRow = { kind: "extra"; key: string; item: unknown };
export type TranscriptRow = TranscriptBlock | TranscriptExtraRow;
/**
 * The dispatcher chat's rows on the shared transcript: `rows` builds the list from the loaded entries (sent
 * messages included) in place of the plain grouping, `render` draws a row of its own. Memoize it: the transcript
 * re-renders when it changes. A new `focus.seq` scrolls to that row (the bell's jump to an ask, §9.4).
 */
export type TranscriptExtra = {
  rows(entries: readonly TailEntry[]): readonly TranscriptRow[];
  render(row: TranscriptExtraRow): ReactElement | null;
  focus?: { key: string; seq: number } | null;
};

/** A sent message whose record never shows up stops being shown after this long. */
const echoTimeout = 60_000;

/**
 * Phones: an inverted, virtualized FlatList, like Paseo's own session view.
 * Only the blocks near the screen are mounted; its offset counts from the
 * newest output, so it stays at the end as output streams in and when the
 * keyboard or the composer shrinks it. Web (and a host without FlatList): a
 * plain scroll view, as Paseo's web session view does (SESSION-PANE-SPEC §3).
 */
// Not `typeof === "function"`: a host FlatList wrapped in memo/forwardRef is an object, and failing that test silently dropped phones onto the plain scroll view, which has no keyboard lift.
const virtualized = Platform.OS !== "web" && !!FlatList;

type TranscriptProps = {
  /** Imperative access for the composer: refresh after a send, jump to the newest output. */
  handle: Ref<TranscriptHandle>;
  taskId: string;
  agentId: string;
  /** Read the transcript (the view is shown, its open transition settled, the session readable). */
  enabled: boolean;
  /** Follow the session's timeline stream (it belongs to the card and is readable). */
  subscribe: boolean;
  settled: boolean;
  /** The session is known: show its output (otherwise only the notices). */
  showOutput: boolean;
  live: boolean;
  starting: boolean;
  loadingSession: boolean;
  notices: TranscriptNotice[];
  /** Open agent questions and approvals: they scroll with the output, below the newest of it. */
  requests: readonly PendingRequest[];
  requestsDisabled: boolean;
  onRespond(request: PendingRequest, reply: PermissionReply): void;
  /** The composer's keyboard lift (native driver, negative = up); the transcript moves with it. */
  lift: Animated.AnimatedInterpolation<number> | Animated.AnimatedMultiplication<number>;
  /** The settled lift, for reaching the oldest output while the keyboard is up. */
  inset: number;
  onStreamError(message: string): void;
  /** A group's dispatcher session, by the group's id: read with `dispatcher.tail`; `taskId` then only names the cache. */
  dispatcher?: string | false;
  extra?: TranscriptExtra;
};

const sameNotices = (a: TranscriptNotice[], b: TranscriptNotice[]) =>
  a.length === b.length && a.every((n, i) => n.key === b[i].key && n.text === b[i].text && n.tone === b[i].tone);

/**
 * The session transcript with its own data (SESSION-PANE-SPEC §3): output
 * refreshes re-render this component only, not the session header and
 * composer. Each block re-renders only when its own content changes.
 */
export const SessionTranscript = memo(SessionTranscriptView, (a, b) => {
  for (const key of Object.keys(a) as (keyof TranscriptProps)[])
    if (key === "notices" ? !sameNotices(a.notices, b.notices) : !Object.is(a[key], b[key])) return false;
  return true;
});

function SessionTranscriptView({
  handle,
  taskId,
  agentId,
  enabled,
  subscribe,
  settled,
  showOutput,
  live,
  starting,
  loadingSession,
  notices,
  requests,
  requestsDisabled,
  onRespond,
  lift,
  inset,
  onStreamError,
  dispatcher = false,
  extra,
}: TranscriptProps) {
  usePerfRender("switch.transcript.commit");
  const switchStart = perfStart();
  const { colors } = useTheme();
  const paseo = usePaseo();
  const agent = useMemo(() => paseo.agents.ref(agentId), [paseo, agentId]);
  const [streamReady, setStreamReady] = useState(false);
  const timeline = useSessionTimeline({ taskId, agentId, enabled, streamReady, dispatcher });
  const refetch = timeline.query.refetch;
  const reading = useRef(enabled);
  reading.current = enabled;
  const streamError = useStableCallback(onStreamError);
  useEffect(() => {
    if (!subscribe) return;
    let alive = true;
    // Status comes from the agent stream; stream events only refresh the transcript.
    // A read still in flight is reused, not cancelled, so a slow relay cannot starve updates.
    const updates = coalescedRefresh(() => {
      if (reading.current) void refetch({ cancelRefetch: false });
    }, 400);
    const subscription = agent.timeline.subscribe(() => {
      if (alive) updates.trigger();
    });
    void subscription.ready.then(
      () => alive && setStreamReady(true),
      (e) => {
        if (alive) streamError(message(e));
      },
    );
    return () => {
      alive = false;
      setStreamReady(false);
      updates.dispose();
      subscription();
    };
  }, [agent, subscribe]);
  const loaded = timeline.query.data;
  // Messages sent from here appear at once; each is replaced (same row key) when the timeline brings its record.
  const [echoes, setEchoes] = useState<readonly SentEcho[]>([]);
  const echoTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const unecho = useStableCallback((messageId: string) => {
    clearTimeout(echoTimers.current.get(messageId));
    echoTimers.current.delete(messageId);
    setEchoes((current) => (current.some((e) => e.messageId === messageId) ? current.filter((e) => e.messageId !== messageId) : current));
  });
  const echo = useStableCallback((messageId: string, text: string) => {
    setEchoes((current) => [...current, { messageId, text }]);
    echoTimers.current.set(messageId, setTimeout(() => unecho(messageId), echoTimeout));
  });
  useEffect(() => () => echoTimers.current.forEach(clearTimeout), []);
  const waiting = useMemo(() => pendingEchoes(loaded?.entries || [], echoes), [loaded?.entries, echoes]);
  useEffect(() => {
    // Recorded now: drop them so a later window that no longer holds the message cannot bring the echo back.
    for (const e of echoes) if (!waiting.includes(e)) unecho(e.messageId);
  }, [waiting]);
  const entries = useMemo(
    (): readonly TailEntry[] =>
      waiting.length
        ? [...(loaded?.entries || []), ...waiting.map((e) => ({ item: { type: "user_message", text: e.text, messageId: e.messageId } }))]
        : loaded?.entries || [],
    [loaded?.entries, waiting],
  );
  const output = useMemo(() => recentSessionOutput(entries), [entries]);
  const blocks = useMemo((): readonly TranscriptRow[] => (extra ? extra.rows(entries) : groupTranscript(output)), [extra, entries, output]);
  const data = useMemo(() => (virtualized ? [...blocks].reverse() : blocks), [blocks]);
  const tail = useSessionFollowTail(virtualized);
  // Web: adding older output above keeps what the user is reading in place.
  const contentHeight = useRef(0);
  const keepPosition = useRef<{ height: number; offset: number } | null>(null);
  // Going to the latest (a send, the Latest button) wins over an older-output load still landing.
  const jumpToLatest = useStableCallback(() => {
    keepPosition.current = null;
    tail.jumpToLatest();
  });
  useImperativeHandle(handle, () => ({ refresh: () => void refetch(), jumpToLatest, echo, unecho }), [refetch, jumpToLatest, echo, unecho]);
  const latest = useMotionPresence(!tail.following ? true : undefined, !tail.following ? "latest" : "");
  // The bell's jump to a row of the caller's (web: its measured offset; phones: its index in the inverted list), once
  // per request: retried as rows arrive or lay out until it is reachable, then never again for that request.
  const offsets = useRef(new Map<string, number>());
  const [focusJump] = useState(createFocusJump);
  const focus = extra?.focus ?? null;
  const tryFocus = useStableCallback(() => {
    if (!focus || !focusJump.pending(focus.seq)) return;
    if (virtualized) {
      const index = data.findIndex((row) => row.key === focus.key);
      if (index < 0) return;
      focusJump.done(focus.seq);
      tail.stopFollowing();
      // A row not laid out yet is reached through onScrollToIndexFailed.
      (tail.scrollRef.current as { scrollToIndex?(o: object): void } | null)?.scrollToIndex?.({ index, viewPosition: 0.5, animated: true });
      return;
    }
    const y = offsets.current.get(focus.key);
    if (y === undefined) return;
    focusJump.done(focus.seq);
    tail.stopFollowing();
    tail.scrollToY(Math.max(0, y - space[3]));
  });
  useEffect(tryFocus, [focus?.seq, focus?.key, data]);
  const measureExtra = useStableCallback((key: string, y: number) => {
    offsets.current.set(key, y);
    if (key === focus?.key) tryFocus();
  });

  const loadEarlier = useStableCallback(() => {
    // Armed only when older output is about to land, so other size changes never use it.
    void timeline.loadEarlier(
      virtualized ? undefined : () => (keepPosition.current = { height: contentHeight.current, offset: tail.offset.current }),
    );
  });
  const onContentSizeChange = useStableCallback((_width: number, height: number) => {
    contentHeight.current = height;
    const keep = keepPosition.current;
    if (keep && height !== keep.height) {
      keepPosition.current = null;
      tail.scrollToY(keep.offset + height - keep.height);
      return;
    }
    tail.scrollToTail();
  });

  const lastOutput = lastOutputRow(blocks);
  const lastKey = lastOutput?.key;
  const renderBlock = useCallback(
    (block: TranscriptRow) =>
      block.kind === "extra" ? (
        (extra?.render(block) ?? null)
      ) : block.kind === "activity" ? (
        <ActivityBlock block={block} live={live && block.key === lastKey} />
      ) : (
        <TranscriptEntry entry={block.entry} taskId={taskId} agentId={agentId} />
      ),
    [live, lastKey, taskId, agentId, extra],
  );
  const renderItem = useCallback(({ item }: ListRenderItemInfo<TranscriptRow>) => renderBlock(item), [renderBlock]);

  // The dispatcher chat shows its items before any session exists: a timeline it does not read is not loading.
  const pending = showOutput && settled && timeline.query.isPending && (enabled || !dispatcher);
  const empty = showOutput && settled && (!timeline.query.isPending || (dispatcher && !enabled)) && !blocks.length && !timeline.query.error;
  const capped = !!loaded?.hasOlder && (loaded?.entries.length ?? 0) >= HISTORY_MAX;
  // Older output, notices and states: above the transcript.
  const top = (
    <View style={{ gap: space[4], paddingBottom: blocks.length ? space[4] : 0 }}>
      {/* The keyboard lifts the whole list, so its top end gets the same room to stay reachable. */}
      {virtualized && inset > 0 && <View style={{ height: inset }} />}
      {loadingSession && <Label muted>{t("Loading session…")}</Label>}
      {notices.map((notice) => (
        <Notice key={notice.key} tone={notice.tone}>
          {notice.text}
        </Notice>
      ))}
      {showOutput && timeline.canLoadEarlier && (
        <LoadEarlier loading={timeline.loadingEarlier} onPress={loadEarlier} />
      )}
      {showOutput && capped && (
        <View style={{ alignItems: "center" }}>
          <Label muted size={font.xs} selectable={false}>
            {t("Open in Paseo for the full conversation")}
          </Label>
        </View>
      )}
      {showOutput && !!timeline.earlierError && <Notice>{message(timeline.earlierError)}</Notice>}
      {showOutput && !!timeline.query.error && (
        <Notice>
          {message(timeline.query.error)}
          {output.length ? ` ${t("Showing the last known output.")}` : ""}
        </Notice>
      )}
      {pending && <Label muted>{t("Loading output…")}</Label>}
      {empty && (
        <View style={{ alignItems: "center", paddingVertical: space[6] }}>
          <Label muted>{t("No output yet.")}</Label>
        </View>
      )}
    </View>
  );
  // The running state: below the newest output.
  const running =
    showOutput && live && lastOutput?.kind !== "activity" ? (
      <View testID="session-running-tail" style={{ flexDirection: "row", gap: space[2], alignItems: "center", minHeight: 24, paddingTop: blocks.length ? space[4] : 0 }}>
        <ActivityIndicator size="small" color={colors.accent} />
        <Label muted size={font.md}>
          {starting ? t("Starting session…") : t("Agent is working…")}
        </Label>
      </View>
    ) : null;
  const asking =
    showOutput && requests.length ? (
      <View style={{ paddingTop: blocks.length ? space[4] : 0 }}>
        <PendingRequests requests={requests} disabled={requestsDisabled} onRespond={onRespond} />
      </View>
    ) : null;
  const bottom =
    running || asking ? (
      <>
        {asking}
        {running}
      </>
    ) : null;
  const shown = showOutput && settled ? data : [];
  const scrollProps = {
    ...verticalScroll,
    testID: "session-output",
    style: { flex: 1, minHeight: 0, minWidth: 0 },
    nestedScrollEnabled: true,
    keyboardShouldPersistTaps: "handled" as const,
    // Web: react-native-web's "on-drag" blurs the focused input on every
    // scroll event, including the follow-tail scroll when output arrives,
    // which kicked the user out of the composer while a session ran.
    // Android: "on-drag" closed the IME on the first scroll, so the last lines could not be read while typing; the keyboard now closes only on Back or send.
    keyboardDismissMode: Platform.OS === "ios" ? ("interactive" as const) : ("none" as const),
    // The follower only needs to know where the tail is; a frame-rate callback crosses into JS 60 times a second while scrolling.
    scrollEventThrottle: 100,
    onScroll: tail.onScroll,
    onScrollBeginDrag: tail.onScrollBeginDrag,
    onScrollEndDrag: tail.onScrollEndDrag,
    onMomentumScrollEnd: tail.onMomentumScrollEnd,
    onContentSizeChange,
  };
  const list = virtualized ? (
    <FlatList
      {...scrollProps}
      ref={tail.scrollRef as never}
      inverted
      data={shown}
      keyExtractor={blockKey}
      renderItem={renderItem}
      ItemSeparatorComponent={Separator}
      // Inverted: the header sits at the bottom (newest end), the footer at the top.
      ListHeaderComponent={bottom}
      ListFooterComponent={top}
      // Inverted, so top padding is the visual bottom.
      contentContainerStyle={{ ...verticalContent, paddingHorizontal: space[4], paddingTop: space[5], paddingBottom: space[4] }}
      // Keeps what the user reads in place as output arrives; near the newest end it follows.
      maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: FOLLOW_SLACK }}
      // A jump to a row not laid out yet: go near it, then once more when it is.
      onScrollToIndexFailed={(info: { index: number; averageItemLength: number }) => {
        tail.scrollToY(info.averageItemLength * info.index);
        setTimeout(() => (tail.scrollRef.current as { scrollToIndex?(o: object): void } | null)?.scrollToIndex?.({ index: info.index, viewPosition: 0.5, animated: true }), 100);
      }}
      initialNumToRender={6}
      maxToRenderPerBatch={6}
      windowSize={9}
    />
  ) : (
    <ScrollView
      {...scrollProps}
      ref={tail.scrollRef as never}
      onLayout={tail.scrollToTail}
      contentContainerStyle={{ ...verticalContent, padding: space[4], paddingBottom: space[5] + inset, gap: space[4] }}
    >
      {top}
      {shown.map((block) => (
        <View key={block.key} onLayout={block.kind === "extra" ? (e) => measureExtra(block.key, e.nativeEvent.layout.y) : undefined}>
          {renderBlock(block)}
        </View>
      ))}
      {bottom}
    </ScrollView>
  );
  perfEnd("switch.transcript.own", switchStart);
  return (
    // Clips what the keyboard lift moves under the session header.
    <View style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>
      <Animated.View style={{ flex: 1, minHeight: 0, minWidth: 0, transform: virtualized ? [{ translateY: lift }] : [] }}>
        {settled ? <Enter distance={0} style={{ flex: 1, minHeight: 0, minWidth: 0 }}>{list}</Enter> : list}
        {latest.item && (
          <Animated.View
            pointerEvents={latest.active ? "box-none" : "none"}
            style={{
              position: "absolute",
              bottom: space[2],
              right: space[3],
              zIndex: 2,
              opacity: latest.progress,
              transform: [{ translateY: lerp(latest.progress, [6, 0]) }],
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Jump to latest")}
              onPress={jumpToLatest}
              style={{
                ...noFocusRing,
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                height: 30,
                paddingHorizontal: space[2] + 2,
                borderRadius: 15,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface0,
                shadowColor: "#000",
                shadowOpacity: 0.08,
                shadowRadius: 6,
                shadowOffset: { width: 0, height: 2 },
              }}
            >
              <Icon name="ArrowDown" size={13} color={colors.foreground} />
              <Label size={font.sm} medium selectable={false}>{t("Latest")}</Label>
            </Pressable>
          </Animated.View>
        )}
      </Animated.View>
    </View>
  );
}

const blockKey = (block: TranscriptRow) => block.key;
const Separator = () => <View style={{ height: space[4] }} />;

function LoadEarlier({ loading, onPress }: { loading: boolean; onPress(): void }) {
  const { colors } = useTheme();
  return (
    <View style={{ alignItems: "center" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Load earlier")}
        accessibilityState={{ busy: loading, disabled: loading }}
        disabled={loading}
        onPress={onPress}
        style={(state) => {
          const { hovered, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
          return {
            ...noFocusRing,
            flexDirection: "row",
            alignItems: "center",
            gap: space[1.5],
            minHeight: touch ? 32 : 26,
            paddingHorizontal: space[3],
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: hovered || state.pressed ? colors.surface2 : colors.surface1,
          };
        }}
      >
        {loading ? <ActivityIndicator size="small" color={colors.foregroundMuted} /> : <Icon name="ArrowUp" size={12} color={colors.foregroundMuted} />}
        <Label muted size={font.sm} medium selectable={false}>
          {loading ? t("Loading earlier output…") : t("Load earlier")}
        </Label>
      </Pressable>
    </View>
  );
}

type OutputEntry = ReturnType<typeof recentSessionOutput>[number];
const sameEntry = (a: OutputEntry, b: OutputEntry) =>
  a === b || (a.key === b.key && a.text === b.text && a.author === b.author && a.messageId === b.messageId);

/** One transcript entry: your message as a bubble, the agent's reply as markdown. Also the welcome tour's sample session. */
export const TranscriptEntry = memo(function TranscriptEntry({
  entry,
  taskId,
  agentId,
}: {
  entry: OutputEntry;
  taskId: string;
  agentId: string;
}) {
  const { colors } = useTheme();
  const { text, images } = useMemo(
    () => (entry.author === "You" || entry.author === "Agent" ? extractImages(entry.text) : { text: entry.text, images: [] }),
    [entry.author, entry.text],
  );
  const sent = entry.author === "You" ? sentImages(entry.messageId) : [];
  const pictures = [...images, ...sent.map((src, i) => ({ src, alt: t("Image {n}", { n: i + 1 }) }))].map((image) => (
    // Your own images stay compact beside your message.
    <SessionImage key={image.src} taskId={taskId} agentId={agentId} image={image} maxWidth={entry.author === "You" ? 200 : 360} />
  ));
  if (entry.author === "You" && !text && !pictures.length) return null;
  if (entry.author === "You")
    return (
      <View style={{ alignItems: "flex-end", paddingLeft: space[6] + space[2], gap: space[1.5] }}>
        {!!text && (
          <View
            accessibilityLabel={t("You")}
            style={{
              maxWidth: "100%",
              paddingHorizontal: space[3],
              paddingVertical: space[2],
              borderRadius: radius.xl,
              backgroundColor: colors.surface2,
            }}
          >
            <Label size={font.base}>{text}</Label>
          </View>
        )}
        {pictures.length > 0 && <View style={{ width: "100%", alignItems: "flex-end", gap: space[1.5] }}>{pictures}</View>}
      </View>
    );
  if (entry.author === "Agent")
    return (
      <View accessibilityLabel={t("Agent")} style={{ minWidth: 0, gap: space[2] }}>
        {!!text && <SessionMarkdown text={text} />}
        {pictures}
      </View>
    );
  return (
    <View style={{ gap: 2, minWidth: 0 }}>
      <Label muted size={font.xs}>{t(entry.author)}</Label>
      <Label muted size={font.md}>{entry.text}</Label>
    </View>
  );
}, (a, b) => a.taskId === b.taskId && a.agentId === b.agentId && sameEntry(a.entry, b.entry));

/**
 * Consecutive thinking and tool calls, collapsed by default to one summary
 * line. Expanded, each step shows a short preview (thinking is clipped; the
 * full transcript lives in Paseo).
 */
export const ActivityBlock = memo(function ActivityBlock({ block, live }: { block: Extract<TranscriptBlock, { kind: "activity" }>; live: boolean }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const turn = useMotionValue(open ? 1 : 0, motionDuration.feedback);
  const latest = block.items.at(-1);
  return (
    <View accessibilityLabel={t("Agent activity")} style={{ minWidth: 0, marginVertical: -space[1] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${activitySummary(block)}. ${open ? t("Collapse") : t("Expand")}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={(state) => {
          const { hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
          return {
            ...noFocusRing,
            flexDirection: "row",
            alignItems: "center",
            gap: space[1.5],
            alignSelf: "flex-start",
            maxWidth: "100%",
            minHeight: touch ? 32 : 24,
            paddingHorizontal: space[1.5],
            marginHorizontal: -space[1.5],
            borderRadius: radius.md,
            backgroundColor: hover ? colors.surface2 : "transparent",
          };
        }}
      >
        {live ? (
          <PulseDot color={colors.accent} size={7} />
        ) : (
          <Icon name={block.tools ? "Wrench" : "Brain"} size={12} color={colors.foregroundMuted} />
        )}
        <Label muted size={font.sm} medium selectable={false}>
          {live ? t("Working") : activitySummary(block)}
        </Label>
        {live && latest && (
          <View style={{ flexShrink: 1, minWidth: 0 }}>
            <Label muted size={font.sm} lines={1} mono={latest.author === "Tool"} selectable={false}>
              {latest.author === "Tool" ? latest.text : t("Thinking…")}
            </Label>
          </View>
        )}
        <Animated.View style={{ transform: [{ rotate: lerp(turn, ["0deg", "90deg"]) }] }}>
          <Icon name="ChevronRight" size={12} color={colors.foregroundMuted} />
        </Animated.View>
      </Pressable>
      <Collapse open={open} id="activity">
        <View style={{ marginTop: space[1], marginLeft: 5, paddingLeft: space[3], borderLeftWidth: 1, borderColor: colors.border, gap: space[1.5] }}>
          {block.items.map((item) =>
            item.author === "Tool" ? (
              <View key={item.key} accessibilityLabel={t("Tool")} style={{ flexDirection: "row", alignItems: "center", gap: space[2], minWidth: 0 }}>
                <Icon name="Wrench" size={12} color={colors.foregroundMuted} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Label muted mono size={font.sm} lines={1}>{item.text}</Label>
                </View>
              </View>
            ) : (
              <View key={item.key} accessibilityLabel={t("Thinking")} style={{ flexDirection: "row", gap: space[2], minWidth: 0 }}>
                <View style={{ paddingTop: 2 }}>
                  <Icon name="Brain" size={12} color={colors.foregroundMuted} />
                </View>
                <View style={{ flex: 1, minWidth: 0, opacity: 0.8 }}>
                  <Label muted italic size={font.sm} lines={2}>{item.text}</Label>
                </View>
              </View>
            ),
          )}
        </View>
      </Collapse>
    </View>
  );
}, (a, b) =>
  a.live === b.live &&
  a.block.key === b.block.key &&
  a.block.items.length === b.block.items.length &&
  a.block.items.every((item, i) => sameEntry(item, b.block.items[i])));
