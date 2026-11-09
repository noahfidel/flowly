import { perfStart, perfEnd, usePerfRender } from "./perf";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { Animated, Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { Modal } from "./modal";
import {
  usePaseo,
  useRpc,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { Task, BoardEvent } from "../shared/model";
import * as rpc from "../shared/rpc";
import {
  Button,
  Label,
  Notice,
  IconButton,
  Dot,
  font,
  radius,
  relativeTime,
  space,
  useTheme,
  Theme,
  Actions,
  Row,
  message,
  noFocusRing } from "./ui";
import { sessionTone } from "./status";
import { resolveSend, type SendBehavior } from "./send-queue";
import { queuedRowKey, useComposer } from "./composer";
import { useLiveAgents } from "./queries";
import { maxImages } from "../shared/composer";
import { newMessageId, rememberSentImages } from "./sent-images";
import { eventPoint, menuHandlers, useMenuOpener, type MenuEntry } from "./context-menu";
import { useBoardView } from "./board-view";
import { ComposerChips, useSessionConfig, type ChipMenuId } from "./session-settings";
import { SubagentsChip } from "./subagents";
import { RenameSession } from "./session-rename";
import {
  openNativeSession,
  samePreviewTask,
  sessionState,
  turnEventKey,
} from "./session-state";
import { sendCardInstruction, workspaceSession } from "./session";
import { useStableCallback } from "./stable";
import { cardWorkspaceIds } from "../shared/workspace-switch";
import { PendingRequests } from "./session-question";
import { NextMoves } from "./next-moves";
import { nextMoveDraft, openNextMoves, shownMoves } from "../shared/next-moves";
import type { NextMove } from "../shared/model";
import { pendingRequests, type PendingRequest, type PermissionReply } from "../shared/permission-question";
import { SessionTranscript, type TranscriptHandle, type TranscriptNotice } from "./session-transcript";
import { useSessionReads } from "./session-reads";
import { sessionAttention } from "../shared/session-attention";
import { Enter, MotionReveal, PulseDot, motionDuration, useMotionValue, useReducedMotion, useSettled, lerp } from "./motion";
import { RunningDots } from "./running-motion";
import { useKeyboardInset } from "./keyboard";
import { restoredDraft } from "./session-input";
import { ComposerBox, useComposerDraft } from "./session-composer";
import { t, tn } from "../shared/i18n";

type SessionPreviewProps = Parameters<typeof SessionPreviewView>[0];

/**
 * Memoized: the drawer re-renders on every board change, and a card moving
 * lane (an agent's stage update, a status rule after a send) used to re-render
 * the whole session view, transcript and composer while the user typed, a long
 * JS frame on a phone. Only what this view reads is compared: the card's
 * identity fields and this session's turn events.
 */
export const SessionPreview = memo(SessionPreviewView, sameSessionPreviewProps);

export function sameSessionPreviewProps(a: SessionPreviewProps, b: SessionPreviewProps) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof SessionPreviewProps>;
  for (const key of keys) {
    if (key === "task") {
      if (!samePreviewTask(a.task, b.task)) return false;
    } else if (key === "events") {
      if (turnEventKey(a.events, a.sessionId) !== turnEventKey(b.events, b.sessionId)) return false;
    } else if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

function SessionPreviewView({
  task,
  sessionId,
  compact = false,
  hostId,
  events,
  unavailable,
  unavailableReason,
  navigation,
  draft,
  pending,
  beginOperation,
  endOperation,
  onDraftChange,
  onComposerFocus,
  onBack,
  onOpenSession,
  onClose,
  refresh,
  visible = true,
  cardFinished = false,
  onMoveToDone,
}: {
  task: Task;
  sessionId: string;
  compact?: boolean;
  hostId: string;
  events: BoardEvent[];
  unavailable: boolean;
  unavailableReason?: string;
  navigation: PluginSurfaceProps["navigation"];
  draft: string;
  pending: boolean;
  beginOperation(sessionId: string): boolean;
  endOperation(sessionId: string): void;
  onDraftChange(sessionId: string, text: string, expectedDraft?: string): void;
  /** The composer got focus (the drawer stops restoring a saved draft into it). */
  onComposerFocus?(sessionId: string): void;
  onBack(): void;
  /**
   * Show another session of this card in the sidebar (a subagent picked from the chip).
   * Returns false when it is not one of the card's sessions; the chip then opens it in Paseo.
   */
  onOpenSession?(sessionId: string): boolean;
  /** Close the whole side bar (from any level). */
  onClose?(): void;
  refresh(): void;
  visible?: boolean;
  /** The card is in Done/Cancelled or archived: action next moves go (NEXT-MOVES-SPEC §7). */
  cardFinished?: boolean;
  /** Move the card to Done (an action next move); the drawer owns revision and wrap-up. */
  onMoveToDone?(): void;
}) {
  usePerfRender("switch.preview.commit");
  const switchStart = perfStart();
  const theme = useTheme(),
    { colors } = theme,
    paseo = usePaseo(),
    contextRead = useRpc(rpc.taskContext),
    healthRead = useRpc(rpc.toolsHealth),
    prepareExisting = useRpc(rpc.prepareExisting),
    accessRead = useRpc(rpc.accessState);
  const reads = useSessionReads();
  const toast = useToast();
  const [sending, setSending] = useState(false),
    [error, setError] = useState(""),
    [showTools, setShowTools] = useState(false),
    [confirmArchive, setConfirmArchive] = useState(false),
    [renaming, setRenaming] = useState(false),
    [chipMenu, setChipMenu] = useState<ChipMenuId | null>(null);
  const keyboard = useKeyboardInset(visible, useReducedMotion());
  const lock = useRef(false);
  const transcript = useRef<TranscriptHandle | null>(null);
  const mounted = useRef(visible);
  mounted.current = visible;
  useEffect(() => {
    mounted.current = visible;
    return () => {
      mounted.current = false;
    };
  }, [visible]);
  const box = useComposerDraft({ sessionId, draft, onDraftChange, isMounted: () => mounted.current });
  const agent = useMemo(() => paseo.agents.ref(sessionId), [paseo, sessionId]);
  // The board's streamed agent list has this session already: show it at once
  // and revalidate (PERFORMANCE-SPEC §3). Archived sessions are not in it.
  const liveAgents = useLiveAgents({
    poll: false,
    select: useCallback((agents: PaseoAgent[]) => agents.find((a) => a.id === sessionId) ?? null, [sessionId]),
  });
  const streamed = liveAgents.data ?? undefined;
  const current = useQuery({
    queryKey: ["flowly", "agent", sessionId],
    queryFn: () => agent.refresh(),
    enabled: visible,
    refetchInterval: 10000,
    placeholderData: () => (streamed ? { agent: streamed, project: null } : undefined),
  });
  // The stream is fresher than the last poll while it runs.
  const polled = current.data?.agent;
  const actor = streamed && (!polled || streamed.updatedAt >= polled.updatedAt) ? streamed : polled;
  // Archived sessions of the card's earlier workspaces stay readable (WORKSPACE-SWITCH-SPEC §8).
  const belongs =
    !!actor && (actor.workspaceId === task.workspaceId || (!!actor.archivedAt && !!actor.workspaceId && cardWorkspaceIds(task).includes(actor.workspaceId)));
  const active = belongs ? actor : undefined;
  // The transcript (markdown, images) and the slower reads wait for the open
  // transition to finish (PERFORMANCE-SPEC §3).
  const settled = useSettled(sessionId);
  // Only the Kanban tools section shows these.
  const tools = useQuery({
    queryKey: ["flowly", "tools"],
    queryFn: () => healthRead({}),
    enabled: visible && belongs && showTools,
    refetchInterval: 5000,
  });
  const access = useQuery({
    queryKey: ["flowly", "access", task.id, sessionId],
    queryFn: () => accessRead({ id: task.id, agentId: sessionId }),
    enabled: visible && belongs && !current.isError && showTools,
    refetchInterval: 3000,
  });
  const state = active ? sessionState(active, events) : null;
  const attention = active
    ? sessionAttention(active, task.id, reads.receipts, events)
    : null;
  // Reading is something the user does: opening the session, or interacting
  // with it (pointer down inside, focusing the composer, sending). A turn that
  // finishes while the view merely stays open — e.g. while the user works
  // elsewhere in Paseo — stays unread. "Mark as unread" holds until the next
  // interaction or the next open.
  const holdUnread = useRef(false);
  const [readIntent, setReadIntent] = useState(1);
  const handledIntent = useRef(0);
  const readsReady = !reads.query.isPending && !reads.query.isError;
  const noteInteraction = () => {
    holdUnread.current = false;
    setReadIntent((n) => n + 1);
  };
  useEffect(() => {
    if (!visible || !active || !readsReady || handledIntent.current === readIntent) return;
    // Each open/interaction reads what is unread at that moment, once.
    handledIntent.current = readIntent;
    if (active.archivedAt || task.archivedAt || !attention?.unread || holdUnread.current) return;
    void reads
      .markRead({ taskId: task.id, agentId: sessionId, ...(attention.token ? { token: attention.token } : {}) })
      .catch(() => undefined);
  }, [visible, active?.id, active?.archivedAt, task.archivedAt, attention?.unread, attention?.token, readsReady, readIntent]);
  const busy = sending || pending;
  const canWrite =
    visible &&
    !!active &&
    !active.providerUnavailable &&
    !unavailable &&
    !current.isError &&
    !busy;
  const view = useBoardView();
  const preferred: SendBehavior = view.values?.sendBehavior || "steer";
  const composer = useComposer(visible && settled);
  const openMenu = useMenuOpener();
  const config = useSessionConfig(task.id, active, visible && settled, () => void current.refetch());
  const queueEntry = composer.entry(sessionId);
  const queued = queueEntry?.queue || [];
  const running = active?.status === "running" || active?.status === "initializing";
  const submitState = useRef({ canWrite, preferred, running, pendingPermission: false });
  submitState.current = {
    canWrite,
    preferred,
    running,
    pendingPermission: !!active?.pendingPermissions?.length,
  };
  async function perform(action: () => Promise<unknown>) {
    if (!mounted.current || lock.current || !beginOperation(sessionId)) return;
    lock.current = true;
    setSending(true);
    setError("");
    try {
      await action();
      refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      lock.current = false;
      endOperation(sessionId);
      setSending(false);
    }
  }
  // Header overflow: everything that is not navigation lives here.
  const sessionActions = (): MenuEntry[] => {
    if (!active) return [];
    const runningNow = active.status === "running" || active.status === "initializing";
    return [
      attention?.unread
        ? {
            id: "read",
            label: t("Mark as read"),
            icon: "MailCheck",
            disabled: !canWrite || reads.query.isPending || reads.query.isError,
            onPress: () =>
              void perform(async () => {
                holdUnread.current = false;
                await reads.markRead({ taskId: task.id, agentId: sessionId, ...(attention.token ? { token: attention.token } : {}) });
                toast.show(t("Marked as read"), { variant: "success" });
                await current.refetch();
              }),
          }
        : {
            id: "unread",
            label: t("Mark as unread"),
            icon: "Mail",
            disabled: !canWrite || reads.query.isPending || reads.query.isError || !!active.archivedAt,
            onPress: () =>
              void perform(async () => {
                // Stay unread while this view is open; opening it again reads it.
                holdUnread.current = true;
                await reads.markUnread({ taskId: task.id, agentId: sessionId });
                toast.show(t("Marked as unread"), { variant: "success" });
              }),
          },
      ...(!active.archivedAt
        ? [{ id: "rename", label: t("Rename session"), icon: "Pencil", disabled: !canWrite || busy, onPress: () => setRenaming(true) }]
        : []),
      { id: "tools", label: showTools ? t("Hide Kanban tools") : t("Kanban tools"), icon: "Wrench", onPress: () => setShowTools(!showTools) },
      ...(runningNow
        ? [{ id: "stop", label: t("Stop"), icon: "Square", onPress: () => void config.apply({ stop: true }, t("Session stopped")) }]
        : []),
      ...(!active.archivedAt
        ? [
            { kind: "separator" as const, id: "s" },
            {
              id: "archive",
              label: t("Archive session"),
              icon: "Archive",
              danger: true,
              disabled: !visible || busy,
              onPress: () => (runningNow ? setConfirmArchive(true) : void archiveSession()),
            },
          ]
        : []),
    ];
  };
  async function archiveSession() {
    setConfirmArchive(false);
    let archived = false;
    await perform(async () => {
      await workspaceSession(paseo, sessionId, task.workspaceId);
      await agent.archive();
      archived = true;
    });
    if (archived && mounted.current) {
      toast.show(t("Session archived. Send it a message later to restore it."), { variant: "success" });
      onBack();
    }
  }
  async function submitInstruction(alternate = false) {
    noteInteraction();
    // The drawer must hold the latest text before the send clears it.
    box.flush();
    const { canWrite: writable, preferred: behavior, running: busyTurn, pendingPermission } = submitState.current;
    const instruction = box.read();
    const attached = box.attachmentsRef.current;
    const images = attached.map(({ data, mimeType }) => ({ data, mimeType }));
    if (!mounted.current || !writable || (!instruction.trim() && !images.length)) return;
    const action = resolveSend(behavior, { running: busyTurn, alternate, pendingPermission });
    if (action.kind === "queue") {
      // Paseo parity: queued messages are sent when the current turn ends.
      void composer.queue(task.id, sessionId, instruction, images).then((item) =>
        rememberSentImages(item.id, attached.map((a) => a.uri)),
      ).catch((e) => {
        // Never lose the text or images: put them back in the composer.
        box.flush();
        onDraftChange(sessionId, restoredDraft(instruction, box.read()));
        if (mounted.current) box.setAttachments([...attached, ...box.attachmentsRef.current].slice(0, maxImages));
        setError(message(e));
      });
      box.clear(instruction);
      onDraftChange(sessionId, "", instruction);
      box.setAttachments([]);
      return;
    }
    await perform(async () => {
      const messageId = newMessageId();
      rememberSentImages(messageId, attached.map((a) => a.uri));
      // Clear at once, so text typed while the send is in flight is never
      // erased by it; a failed send puts the text back (PERFORMANCE-SPEC §2).
      box.clear(instruction);
      onDraftChange(sessionId, "", instruction);
      box.setAttachments(box.attachmentsRef.current.filter((a) => !attached.includes(a)));
      // The message shows in the transcript at once, not after the checks, the send and the next read (SESSION-UX-SPEC).
      transcript.current?.echo(messageId, instruction);
      if (mounted.current) transcript.current?.jumpToLatest();
      try {
        await sendCardInstruction(paseo, task, sessionId, contextRead, instruction, action.activeTurnBehavior, images, messageId);
      } catch (e) {
        transcript.current?.unecho(messageId);
        box.flush();
        const typed = box.read();
        onDraftChange(sessionId, restoredDraft(instruction, typed));
        if (mounted.current) box.setAttachments([...attached, ...box.attachmentsRef.current].slice(0, maxImages));
        throw e;
      }
      if (mounted.current) transcript.current?.jumpToLatest();
      void current.refetch();
      transcript.current?.refresh();
    });
  }
  // Open agent questions and approvals, answered here instead of in Paseo (SESSION-QUESTION-SPEC).
  const requestsKey = JSON.stringify(active?.pendingPermissions ?? []);
  const requests = useMemo(() => pendingRequests(active), [requestsKey]);
  const respond = useStableCallback((request: PendingRequest, reply: PermissionReply) => {
    noteInteraction();
    void perform(async () => {
      const latest = await workspaceSession(paseo, sessionId, task.workspaceId, true);
      if (!pendingRequests(latest).some((r) => r.id === request.id))
        throw new Error(t("This request was already answered or withdrawn."));
      await agent.respondToPermission({ requestId: request.id, response: reply });
      toast.show(reply.behavior === "allow" && request.kind === "question" ? t("Answer sent") : t("Response sent"), { variant: "success" });
      if (mounted.current) transcript.current?.jumpToLatest();
      await current.refetch();
      transcript.current?.refresh();
    });
  });
  // This turn's suggested next messages (NEXT-MOVES-SPEC §3-4); × hides one set until the next.
  const suggestion = openNextMoves(events, sessionId);
  const [hiddenMoves, setHiddenMoves] = useState("");
  const moves = suggestion ? shownMoves(suggestion.moves, cardFinished) : [];
  const showMoves =
    !!suggestion &&
    moves.length > 0 &&
    !!active &&
    !running &&
    !requests.length &&
    hiddenMoves !== suggestion.id &&
    !(active.lastUserMessageAt && Date.parse(active.lastUserMessageAt) > Date.parse(suggestion.at));
  const pickMove = useStableCallback((move: NextMove) => {
    noteInteraction();
    if (move.moveTo) {
      onMoveToDone?.();
      return;
    }
    if (!move.prompt) return;
    box.flush();
    const next = nextMoveDraft(move.prompt, box.read());
    box.focusAfterChange();
    onDraftChange(sessionId, next);
  });
  const hideMoves = useStableCallback(() => {
    if (suggestion) setHiddenMoves(suggestion.id);
  });
  const tone = state ? sessionTone(colors, state, !!attention?.unread) : colors.foregroundMuted;
  const toggleSubagents = useStableCallback(() => setChipMenu((m) => (m === "subagents" ? null : "subagents")));
  // In the sidebar when the subagent is one of this card's sessions, else in a Paseo agent pane.
  const openSubagent = useStableCallback((agentId: string) => {
    setChipMenu(null);
    if (onOpenSession?.(agentId)) return;
    if (typeof navigation?.openAgent === "function") openNativeSession(navigation, agentId, hostId);
  });
  // Takes a queued message out of the queue and into the input (appended to what is already typed).
  const withdraw = (m: { id: string; text: string }) =>
    void composer.remove(sessionId, m.id).then(
      () => onDraftChange(sessionId, box.read().trim() ? `${box.read()}\n${m.text}` : m.text),
      (e) => setError(message(e)),
    );
  const renderComposer = () => {
    if (!active) return null;
    return (
      <>
          {!!queueEntry?.lastError && (
            <Notice>{t("Queued message not sent: {error}", { error: queueEntry.lastError })}</Notice>
          )}
          {queued.length > 0 && (
            <View style={{ gap: 4 }}>
              {queued.map((m) => {
                // Shown before the daemon confirmed it: everything stays in place and looks the same, presses wait.
                const pending = m.id.startsWith("pending-");
                return (
                <QueuedRow
                  key={queuedRowKey(m.id)}
                  menu={menuHandlers(openMenu, t("Queued message"), () => [
                    ...(running && !m.id.startsWith("pending-")
                      ? [{ id: "steer", label: t("Send now (steer)"), icon: "CornerDownRight", onPress: () =>
                          void composer.sendNow(task.id, sessionId, m.id)
                            .then(() => toast.show(t("Sent to the running turn"), { variant: "success" }))
                            .catch((e) => setError(message(e))) }]
                      : []),
                    { id: "edit", label: t("Edit"), icon: "Pencil", disabled: m.id.startsWith("pending-") || !!m.images?.length, onPress: () => withdraw(m) },
                    { kind: "separator", id: "s" },
                    { id: "remove", label: t("Remove"), icon: "Trash2", danger: true, disabled: m.id.startsWith("pending-"), onPress: () =>
                        void composer.remove(sessionId, m.id).catch((e) => setError(message(e))) },
                  ])}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space[2],
                    paddingLeft: space[3],
                    paddingRight: 2,
                    minHeight: 30,
                    borderRadius: radius.md,
                    backgroundColor: colors.surface2,
                  }}
                >
                  <Icon name="Clock" size={13} color={colors.foregroundMuted} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Label size={font.sm} lines={1} selectable={false}>
                      {m.text.replace(/\s+/g, " ") || (m.images?.length === 1 ? t("Image") : tn(m.images?.length || 0, "{n} image", "{n} images"))}
                    </Label>
                  </View>
                  {!!m.images?.length && !!m.text.trim() && (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                      <Icon name="Image" size={12} color={colors.foregroundMuted} />
                      <Label muted size={font.xs} selectable={false}>{m.images.length}</Label>
                    </View>
                  )}
                  <Label muted size={font.xs} selectable={false}>{t("Queued")}</Label>
                  {running && (
                    <Button
                      quiet
                      icon="CornerDownRight"
                      label={t("Send now and steer the running turn")}
                      onPress={() =>
                        !pending &&
                        void composer
                          .sendNow(task.id, sessionId, m.id)
                          .then(() => toast.show(t("Sent to the running turn"), { variant: "success" }))
                          .catch((e) => setError(message(e)))
                      }
                    >
                      {t("Steer")}</Button>
                  )}
                  {!m.images?.length && (
                    <IconButton
                      icon="Undo2"
                      size={26}
                      label={t("Take back to the message box")}
                      onPress={() => !pending && withdraw(m)}
                    />
                  )}
                  <IconButton
                    icon="X"
                    size={26}
                    label={t("Remove queued message")}
                    onPress={() => !pending && void composer.remove(sessionId, m.id).catch((e) => setError(message(e)))}
                  />
                </QueuedRow>
                );
              })}
            </View>
          )}
          <ComposerBox
            composer={box}
            canWrite={canWrite}
            busy={busy}
            running={running}
            preferred={preferred}
            compact={compact}
            editable={!!active}
            placeholder={
              active.archivedAt
                ? t("Send a message to restore this session…")
                : compact
                  ? t("Message this session…")
                  : t("Tell this session what to do next…")
            }
            keyboard={keyboard}
            onFocus={() => {
              onComposerFocus?.(sessionId);
              if (attention?.unread) noteInteraction();
            }}
            onSubmit={(alternate) => void submitInstruction(alternate)}
            onStop={() => void config.apply({ stop: true }, t("Session stopped"))}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], zIndex: 2 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <ComposerChips
                config={config}
                menu={chipMenu}
                setMenu={setChipMenu}
                inline={false}
                disabled={!!active.archivedAt}
                onOpenInPaseo={
                  typeof navigation?.openAgent === "function"
                    ? () => {
                        setChipMenu(null);
                        openNativeSession(navigation, sessionId, hostId);
                      }
                    : undefined
                }
              />
            </View>
          </View>
      </>
    );
  };

  // Shown above the transcript, scrolling with it (the transcript compares them by content).
  const notices: TranscriptNotice[] = [];
  if (current.error) notices.push({ key: "session", text: message(current.error) });
  if (!current.isPending && !current.error && !belongs)
    notices.push({ key: "foreign", tone: "warning", text: t("Session is unavailable or belongs to a different workspace. Return to the task to choose another session.") });
  if (active) {
    if (unavailable)
      notices.push({ key: "unavailable", tone: "warning", text: unavailableReason || t("Task or workspace is unavailable. Return to task details for more information.") });
    if (active.lastError) notices.push({ key: "last-error", text: active.lastError });
    if (active.providerUnavailable)
      notices.push({ key: "provider", tone: "warning", text: t("This session's provider is unavailable. Open in Paseo to inspect its configuration.") });
    if (active.archivedAt)
      notices.push({ key: "archived", tone: "info", text: t("This session is archived. Sending a message restores it and continues the conversation.") });
    if (reads.query.error) notices.push({ key: "reads", text: message(reads.query.error) });
    if (attention?.unread && !attention.token)
      notices.push({ key: "attention", tone: "info", text: t("This host did not provide a readable attention timestamp. Open in Paseo to acknowledge this session.") });
  } else if (error) notices.push({ key: "error", text: error });

  perfEnd("switch.preview.own", switchStart);
  return (
    <View
      ref={keyboard.ref}
      onLayout={keyboard.onLayout}
      style={{ flex: 1, minHeight: 0, minWidth: 0 }}
      // Any press inside the session counts as looking at it (does not claim the responder).
      onPointerDown={() => attention?.unread && !holdUnread.current && noteInteraction()}
    >
      <View
        style={{
          paddingLeft: space[2],
          paddingRight: space[2],
          paddingVertical: space[2],
          flexDirection: "row",
          alignItems: "center",
          gap: space[1],
          borderBottomWidth: 1,
          borderColor: colors.border,
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        {/* A running session's header carries the same dot sweep as its row in the card (MOTION-SPEC, running state). */}
        {state?.active && !active?.archivedAt && <RunningDots color={tone} seed={sessionId} />}
        <IconButton icon="ArrowLeft" label={t("Back to task")} onPress={onBack} />
        <View style={{ flex: 1, minWidth: 0, paddingHorizontal: space[1] }}>
          <Label medium size={font.base} lines={1}>
            {active?.title || t("Session preview")}
          </Label>
          {state ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5], minWidth: 0 }}>
              <PulseDot color={tone} size={7} active={state.active} />
              <View style={{ flexShrink: 1, minWidth: 0 }}>
                <Label muted size={font.sm} lines={1} selectable={false}>
                  <Label size={font.sm} medium color={state.active || state.label === "Error" || "waiting" in state ? tone : colors.foregroundMuted} selectable={false}>
                    {t(state.label)}
                  </Label>
                  {reads.query.isPending
                    ? ` · ${t("Loading read state…")}`
                    : reads.query.isError
                      ? ` · ${t("Read state unavailable")}`
                      : !attention?.readKnown
                        ? ` · ${t("Read state unknown")}`
                        : attention.unread
                          ? ` · ${t("Unread")}`
                          : ""}
                  {active?.provider ? ` · ${active.provider}${active.model ? `/${active.model}` : ""}` : ""}
                </Label>
              </View>
            </View>
          ) : (
            <Label muted size={font.sm}>{task.title}</Label>
          )}
        </View>
        {typeof navigation?.openAgent === "function" && (
          <IconButton
            icon="ArrowUpRight"
            label={t("Open in Paseo")}
            disabled={!visible || !active || current.isError || busy}
            onPress={() =>
              void perform(async () => {
                await workspaceSession(paseo, sessionId, task.workspaceId);
                if (mounted.current)
                  openNativeSession(navigation, sessionId, hostId);
              })
            }
          />
        )}
        {active && (
          <IconButton
            icon="Ellipsis"
            label={t("More session actions")}
            onPress={(event) => openMenu?.(eventPoint(event), active.title || t("Session"), sessionActions())}
          />
        )}
        {onClose && <IconButton icon="X" label={t("Close side bar")} onPress={onClose} />}
      </View>
      {active && showTools && (
        <MotionReveal transitionKey="session-tools" distance={8} style={{ flexShrink: 0 }}>
          <View
            style={{
              margin: space[3],
              marginBottom: 0,
              padding: space[3],
              gap: space[2],
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface1,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
              <Icon name="Wrench" size={14} color={colors.foregroundMuted} />
              <Label medium size={font.md}>{t("Kanban tools")}</Label>
              <View style={{ flex: 1 }} />
              <Dot color={tools.data?.ready ? colors.statusSuccess : colors.statusWarning} size={7} />
              <Label muted size={font.sm}>{tools.data?.ready ? t("Ready") : t("Not ready")}</Label>
            </View>
            <Label muted size={font.sm}>
              {t("Lets this agent read its task, report progress and move it between Design, Development and Test, to Blocked, In review, Committed or Integrated. You confirm Done or Cancelled.")}</Label>
            <Label muted size={font.sm}>
              {access.data?.methods.length
                ? t("Configuration provided: {methods}", { methods: access.data.methods.join(" + ").toUpperCase() })
                : t("No Kanban configuration recorded.")}
              {" · "}
              {access.data?.lastSuccessAt
                ? t("Last call: {lastAction} {time}", { lastAction: access.data.lastAction ?? "", time: relativeTime(access.data.lastSuccessAt) })
                : t("No successful tool call yet.")}
            </Label>
            {access.error && <Notice>{message(access.error)}</Notice>}
            {tools.error && <Notice>{message(tools.error)}</Notice>}
            {access.data && !access.data.ready && (
              <Notice tone="warning">{access.data.reason}</Notice>
            )}
            <View style={{ flexDirection: "row" }}>
              <Button
                icon="Send"
                disabled={!canWrite || !tools.data?.ready}
                onPress={() =>
                  void perform(async () => {
                    const latest = await workspaceSession(
                      paseo,
                      sessionId,
                      task.workspaceId,
                      true,
                    );
                    const prepared = await prepareExisting({
                      id: task.id,
                      agentId: sessionId,
                    });
                    await agent.send(
                      prepared.instructions,
                      latest.status === "running"
                        ? { activeTurnBehavior: "steer" }
                        : {},
                    );
                    toast.show(t("Kanban instructions sent"), { variant: "success" });
                    await access.refetch();
                    await current.refetch();
                  })
                }
              >
                {t("Send Kanban work instructions")}</Button>
            </View>
          </View>
        </MotionReveal>
      )}
      <SessionTranscript
        handle={transcript}
        taskId={task.id}
        agentId={sessionId}
        enabled={visible && settled && !current.isError}
        subscribe={visible && belongs && !current.isError}
        settled={settled}
        showOutput={!!active}
        live={!!state?.active}
        starting={active?.status === "initializing"}
        loadingSession={current.isPending}
        notices={notices}
        requests={requests}
        requestsDisabled={!canWrite || busy}
        onRespond={respond}
        lift={keyboard.translate}
        inset={keyboard.inset}
        onStreamError={setError}
      />
      {!!chipMenu && (
        <Pressable
          accessibilityLabel={t("Close menu")}
          onPress={() => setChipMenu(null)}
          style={{ ...noFocusRing, position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 }}
        />
      )}
      {active && (
        <Animated.View
          testID="session-composer"
          style={{
            flexShrink: 0,
            minWidth: 0,
            // Rides above the keyboard on the native driver; opaque so the transcript does not show through.
            backgroundColor: colors.surface0,
            transform: [{ translateY: keyboard.translate }],
            // Above the dismiss layer so chip menus can open upward over the transcript.
            zIndex: 25,
            paddingHorizontal: space[3],
            paddingTop: space[2],
            paddingBottom: space[3],
            gap: space[2],
          }}
        >
          {!!error && (
            <Notice>{error}</Notice>
          )}
          {showMoves && (
            <NextMoves key={suggestion.id} moves={moves} disabled={!canWrite} onPick={pickMove} onDismiss={hideMoves} />
          )}
          {!active.archivedAt && (
            <SubagentsChip
              sessionId={sessionId}
              open={chipMenu === "subagents"}
              onToggle={toggleSubagents}
              onOpenAgent={onOpenSession || typeof navigation?.openAgent === "function" ? openSubagent : undefined}
            />
          )}
          {renderComposer()}
        </Animated.View>
      )}
      {renaming && visible && active && (
        <RenameSession
          title={active.title || ""}
          onSave={(title) => config.apply({ title }, t("Session renamed"))}
          onClose={() => setRenaming(false)}
        />
      )}
      <Modal
        open={confirmArchive && visible}
        title={t("Archive running session?")}
        onOpenChange={(open) => {
          if (!open) setConfirmArchive(false);
        }}
      >
        <Modal.Content>
          <Theme.Provider value={theme}>
            <Label size={font.base}>
              {t("Archiving interrupts the current turn. The conversation is kept; send it a message later to restore it.")}</Label>
            <Actions>
              <Button quiet onPress={() => setConfirmArchive(false)}>{t("Cancel")}</Button>
              <Button danger icon="Archive" onPress={() => void archiveSession()}>{t("Archive")}</Button>
            </Actions>
          </Theme.Provider>
        </Modal.Content>
      </Modal>
    </View>
  );
}

/** A queued message row: enters with a short rise, supports a context menu. */
function QueuedRow({ menu, style, children }: { menu: object; style: object; children: ReactNode }) {
  const enter = useMotionValue(1, motionDuration.forward, 0);
  return (
    <Animated.View
      style={{
        opacity: enter,
        transform: [{ translateY: lerp(enter, [6, 0]) }],
      }}
    >
      <Pressable {...menu} accessibilityRole="none" style={{ ...noFocusRing, ...style }}>
        {children}
      </Pressable>
    </Animated.View>
  );
}
