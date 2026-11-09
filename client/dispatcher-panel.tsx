import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import type { PaseoAgent } from "@getpaseo/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { msg, t, tn } from "../shared/i18n";
import { userSendOptions, type ChatItem } from "../shared/dispatcher";
import { maxImages } from "../shared/composer";
import { pendingRequests, type PendingRequest, type PermissionReply } from "../shared/permission-question";
import { Button, IconButton, Label, Notice, font, message, noFocusRing, radius, space, touch, useTheme } from "./ui";
import { SessionTranscript, type TranscriptExtra, type TranscriptExtraRow, type TranscriptHandle, type TranscriptNotice } from "./session-transcript";
import { ComposerBox, useComposerDraft } from "./session-composer";
import { restoredDraft } from "./session-input";
import { sessionState } from "./session-state";
import { sessionTone } from "./status";
import { RunningDots } from "./running-motion";
import { newMessageId, rememberSentImages } from "./sent-images";
import { Collapse } from "./disclosure";
import { dispatcherStartMessage } from "./start-again";
import { PulseDot, useReducedMotion } from "./motion";
import { useKeyboardInset } from "./keyboard";
import { asksResolvedKey, dispatcherItemsKey, useDispatcherItemsQuery, useLiveAgents } from "./queries";
import { useStableCallback } from "./stable";
import { chatRows, sameItem, type ChatExtra } from "./dispatcher-panel-logic";
import { AnswerRow, AskRow } from "./dispatcher-asks";
import { markAsksAnswered } from "./answered-asks";

/**
 * The dispatcher chat next to the board (DISPATCHER-SPEC §9.3), on the card session view's own parts: the session
 * transcript (messages, streaming, tool calls, permissions) and the message box. Only the dispatcher's rows (notes,
 * asks with their ticks, answers, the board summary and the "changed since you looked" line) are its own.
 */

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
  compact?: boolean;
  /** A card's lane name in its own project. */
  laneOf(projectId: string, status: string): string;
  onOpenCard(taskId: string): void;
  /** Minimize (desktop) or close (phone) the chat. */
  onClose(): void;
  /** Desktop: the chat takes the whole board area; the toggle restores its docked width (§9.3). */
  expanded?: boolean;
  onToggleSize?(): void;
  /** The bell's jump to an ask (§9.4): scroll to its row and outline it; a new `key` jumps again. */
  focus?: { signal: string; key: number } | null;
};

export const DispatcherPanel = memo(function DispatcherPanel({ visible, compact = false, laneOf, onOpenCard, onClose, focus, expanded = false, onToggleSize }: Props) {
  const { colors } = useTheme();
  const paseo = usePaseo();
  const client = useQueryClient();
  const toast = useToast();
  const readStatus = useRpc(rpc.dispatcherStatus);
  const startRpc = useRpc(rpc.dispatcherStart);
  const status = useQuery({ queryKey: statusKey, queryFn: () => readStatus({}), enabled: visible, refetchInterval: visible ? 5_000 : false, placeholderData: (p) => p });
  const items = useDispatcherItemsQuery(visible);
  const state = status.data?.state;
  const agentId = status.data?.agentId ?? null;
  const up = state === "running" || state === "idle";
  const [startError, setStartError] = useState("");
  const [starting, setStarting] = useState(false);
  const mounted = useRef(visible);
  mounted.current = visible;

  // The session itself, read as a card's session view reads it: the streamed agent list, else a poll.
  const live = useLiveAgents({
    poll: false,
    select: useCallback((agents: PaseoAgent[]) => agents.find((a) => a.id === agentId) ?? null, [agentId]),
  });
  const current = useQuery({
    queryKey: ["flowly", "agent", agentId ?? "-"],
    queryFn: () => paseo.agents.ref(agentId!).refresh(),
    enabled: visible && !!agentId,
    refetchInterval: 10000,
  });
  const streamed = live.data ?? undefined;
  const polled = current.data?.agent;
  const agent = agentId ? (streamed && (!polled || streamed.updatedAt >= polled.updatedAt) ? streamed : polled) : undefined;
  const running = agent ? agent.status === "running" || agent.status === "initializing" : state === "running";
  const session = agent ? sessionState(agent) : null;
  const tone = session ? sessionTone(colors, session) : colors.foregroundMuted;

  const start = useStableCallback(async () => {
    setStartError("");
    setStarting(true);
    try {
      await startRpc({});
      await client.invalidateQueries({ queryKey: statusKey });
    } catch (e) {
      // Refusals arrive as `CODE: message`; the provider refusal is shown in the user's words (DISPATCHER-SPEC §3, §8).
      setStartError(dispatcherStartMessage(message(e)));
    } finally {
      setStarting(false);
    }
  });
  const refreshItems = useStableCallback(() => {
    void client.invalidateQueries({ queryKey: dispatcherItemsKey });
    void client.invalidateQueries({ queryKey: ["flowly", "attention-count"] });
    void client.invalidateQueries({ queryKey: asksResolvedKey });
  });
  // An answer row is addressed to its card: the title comes from the ask it answers.
  const askTitles = useMemo(() => new Map((items.data ?? []).flatMap((item) => (item.kind === "ask" ? [[item.signal, item.title] as const] : []))), [items.data]);
  // Asks the chat lists as answered, ended or dismissed leave the bell too, until the live list drops them (§9.4).
  useEffect(() => {
    markAsksAnswered((items.data ?? []).flatMap((item) => (item.kind === "ask" && item.state !== "open" ? [item.signal] : [])));
  }, [items.data]);

  // The dispatcher's rows on the shared transcript, in time order with its output (§9.3).
  const focusedKey = focus ? `item-ask-${focus.signal}` : "";
  const renderExtra = useCallback(
    (row: TranscriptExtraRow) => {
      const extra = row.item as ChatExtra;
      if (extra.kind === "summary") return <SummaryRow />;
      const item = extra.item;
      if (item.kind === "ask") return <AskRow item={item} focused={row.key === focusedKey} onOpenCard={onOpenCard} onChanged={refreshItems} />;
      if (item.kind === "answer") return <AnswerRow item={item} title={askTitles.get(item.signal) ?? ""} onOpenCard={onOpenCard} />;
      return <ItemRow item={item} laneOf={laneOf} onOpenCard={onOpenCard} onChanged={refreshItems} />;
    },
    [focusedKey, onOpenCard, refreshItems, askTitles, laneOf],
  );
  const chatItems = items.data;
  const extra = useMemo<TranscriptExtra>(
    () => ({
      rows: (entries) => chatRows(entries, chatItems ?? []),
      render: renderExtra,
      focus: focusedKey ? { key: focusedKey, seq: focus!.key } : null,
    }),
    [chatItems, renderExtra, focusedKey, focus?.key],
  );

  // Its permission requests, answered here as in a card's session view (never without the user's choice).
  const transcript = useRef<TranscriptHandle | null>(null);
  const [sending, setSending] = useState(false);
  // Held from the press until the call settles: a second press before the re-render cannot send again (as the card view).
  const lock = useRef(false);
  const [error, setError] = useState("");
  const requestsKey = JSON.stringify(agent?.pendingPermissions ?? []);
  const requests = useMemo(() => pendingRequests(agent), [requestsKey]);
  const respond = useStableCallback((request: PendingRequest, reply: PermissionReply) => {
    if (!agentId || lock.current) return;
    lock.current = true;
    setSending(true);
    setError("");
    void (async () => {
      const latest = (await paseo.agents.ref(agentId).refresh())?.agent;
      if (!pendingRequests(latest).some((r) => r.id === request.id)) throw new Error(t("This request was already answered or withdrawn."));
      await paseo.agents.ref(agentId).respondToPermission({ requestId: request.id, response: reply });
      toast.show(reply.behavior === "allow" && request.kind === "question" ? t("Answer sent") : t("Response sent"), { variant: "success" });
      if (mounted.current) transcript.current?.jumpToLatest();
      await current.refetch();
      transcript.current?.refresh();
    })()
      .catch((e) => setError(message(e)))
      .finally(() => {
        lock.current = false;
        setSending(false);
      });
  });

  // The message box: the card session view's, with the text kept here. Sends always steer (§9.3).
  const [draft, setDraft] = useState("");
  const draftChange = useStableCallback((_id: string, text: string, expected?: string) =>
    setDraft((now) => (expected !== undefined && now !== expected ? now : text)),
  );
  const box = useComposerDraft({ sessionId: "dispatcher", draft, onDraftChange: draftChange, isMounted: () => mounted.current });
  const canWrite = visible && up && !!agentId && !!agent && !agent.providerUnavailable && !sending;
  const submit = useStableCallback(async () => {
    box.flush();
    const text = box.read();
    const attached = box.attachmentsRef.current;
    const images = attached.map(({ data, mimeType }) => ({ data, mimeType }));
    if (!canWrite || lock.current || !agentId || (!text.trim() && !images.length)) return;
    lock.current = true;
    setSending(true);
    setError("");
    const messageId = newMessageId();
    rememberSentImages(messageId, attached.map((a) => a.uri));
    // Cleared at once, so text typed while the send is in flight stays; a failed send puts it back.
    box.clear(text);
    draftChange("dispatcher", "", text);
    box.setAttachments(box.attachmentsRef.current.filter((a) => !attached.includes(a)));
    transcript.current?.echo(messageId, text);
    transcript.current?.jumpToLatest();
    try {
      await paseo.agents.ref(agentId).send(text, { ...userSendOptions, ...(images.length ? { images } : {}), messageId });
      void current.refetch();
      transcript.current?.refresh();
    } catch (e) {
      transcript.current?.unecho(messageId);
      box.flush();
      setDraft(restoredDraft(text, box.read()));
      if (mounted.current) box.setAttachments([...attached, ...box.attachmentsRef.current].slice(0, maxImages));
      setError(message(e));
    } finally {
      lock.current = false;
      setSending(false);
    }
  });
  const keyboard = useKeyboardInset(visible, useReducedMotion());

  const notices: TranscriptNotice[] = [];
  if (status.error) notices.push({ key: "status", text: message(status.error) });
  if (current.error) notices.push({ key: "session", text: message(current.error) });
  if (agent?.lastError) notices.push({ key: "last-error", text: agent.lastError });
  // Saved tools are fixed when the session is created; a new dispatcher gets this build's (DISPATCHER-SPEC §3).
  if (status.data?.newTools) notices.push({ key: "new-tools", tone: "warning", text: t("This dispatcher started before some Flowly tools existed. Archive its session in Paseo, then start a new one to use them.") });
  if (agent?.providerUnavailable)
    notices.push({ key: "provider", tone: "warning", text: t("The dispatcher's provider is unavailable, so it can't take messages. Check that provider in Paseo's settings.") });

  return (
    <View ref={keyboard.ref} onLayout={keyboard.onLayout} style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: colors.surface0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[1], paddingHorizontal: space[2], paddingVertical: space[2], borderBottomWidth: 1, borderBottomColor: colors.border, flexShrink: 0, minWidth: 0 }}>
        {session?.active && <RunningDots color={tone} seed="dispatcher" />}
        <View style={{ flex: 1, minWidth: 0, paddingHorizontal: space[1] }}>
          <Label medium size={font.base} lines={1} selectable={false}>{t("Dispatcher")}</Label>
          {session && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5], minWidth: 0 }}>
              <PulseDot color={tone} size={7} active={session.active} />
              <View style={{ flexShrink: 1, minWidth: 0 }}>
                <Label muted size={font.sm} lines={1} selectable={false}>
                  <Label size={font.sm} medium color={session.active || "waiting" in session ? tone : colors.foregroundMuted} selectable={false}>
                    {t(session.label)}
                  </Label>
                  {agent?.provider ? ` · ${agent.provider}${agent.model ? `/${agent.model}` : ""}` : ""}
                </Label>
              </View>
            </View>
          )}
        </View>
        {!compact && onToggleSize ? (
          <IconButton icon={expanded ? "Minimize2" : "Maximize2"} label={expanded ? t("Restore size") : t("Expand")} onPress={onToggleSize} />
        ) : null}
        <IconButton icon={compact ? "X" : "PanelLeftClose"} label={compact ? t("Close") : t("Minimize")} onPress={onClose} />
      </View>
      <SessionTranscript
        handle={transcript}
        taskId="dispatcher"
        agentId={agentId ?? "-"}
        dispatcher
        enabled={visible && !!agentId && !current.isError}
        subscribe={visible && !!agentId && up}
        settled
        showOutput={!!agentId || !!chatItems?.length}
        live={running}
        starting={agent?.status === "initializing"}
        loadingSession={visible && status.isPending}
        notices={notices}
        requests={requests}
        requestsDisabled={!canWrite}
        onRespond={respond}
        lift={keyboard.translate}
        inset={keyboard.inset}
        onStreamError={setError}
        extra={extra}
      />
      <Animated.View
        style={{ flexShrink: 0, minWidth: 0, backgroundColor: colors.surface0, transform: [{ translateY: keyboard.translate }], zIndex: 25, paddingHorizontal: space[3], paddingTop: space[2], paddingBottom: space[3], gap: space[2] }}
      >
        {!!error && <Notice>{error}</Notice>}
        {up && agentId ? (
          <ComposerBox
            composer={box}
            canWrite={canWrite}
            busy={sending}
            running={running}
            preferred="steer"
            compact={compact}
            editable={!!agent}
            placeholder={t("Message the dispatcher")}
            keyboard={keyboard}
            onSubmit={() => void submit()}
          />
        ) : (
          !!state && (
            <View style={{ gap: space[2], alignItems: "flex-start" }}>
              <Label muted size={font.md}>
                {state === "ended" ? t("The dispatcher session ended.") : t("Starts one agent session that works across all your projects.")}
              </Label>
              <Button primary icon="Play" disabled={starting} onPress={() => void start()}>
                {t("Start dispatcher")}
              </Button>
              {!!startError && <Notice>{startError}</Notice>}
            </View>
          )
        )}
      </Animated.View>
    </View>
  );
});

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
