import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import type { PaseoAgent } from "@getpaseo/client";
import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { msg, t } from "../shared/i18n";
import type { ChatItem } from "../shared/dispatcher";
import { nativeSessionSettings, nativeSessionSettingsValues } from "../shared/settings";
import { maxImages } from "../shared/composer";
import { pendingRequests, type PendingRequest, type PermissionReply } from "../shared/permission-question";
import { Actions, Button, Label, Notice, Theme, font, message, noFocusRing, space, useTheme } from "./ui";
import { Modal } from "./modal";
import { SessionTranscript, type TranscriptExtra, type TranscriptExtraRow, type TranscriptHandle, type TranscriptNotice } from "./session-transcript";
import { ComposerBox, useComposerDraft } from "./session-composer";
import { restoredDraft } from "./session-input";
import { newMessageId, rememberSentImages } from "./sent-images";
import { CardLinkContext, type CardLinkInfo } from "./card-links";
import { dispatcherStartMessage } from "./start-again";
import { useReducedMotion } from "./motion";
import { useKeyboardInset } from "./keyboard";
import { useDispatcherItemsQuery, useLiveAgents } from "./queries";
import { useStableCallback } from "./stable";
import { chatRows, discussFill, newToolsNotice, replaceOffer, sameItem, type ChatExtra } from "./dispatcher-panel-logic";
import { ComposerChips, useSessionConfig, type ChipMenuId } from "./session-settings";

/**
 * The dispatcher chat next to the board (DISPATCHER-SPEC §9.3), on the card session view's own parts: the session
 * transcript (messages, streaming, tool calls, permissions) and the message box. Only the dispatcher's rows (notes and
 * the board summary) are its own; asks and the changed cards are the overview's need-you and updated step-throughs (Ruling, Noah 2026-11-09).
 * The dock (left-dock.tsx) holds the tabs, Expand and Minimize.
 */

export const dispatcherStatusKey = ["flowly", "dispatcher", "status"] as const;
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
  /** A card's current state for the card links in the chat (stable; reads the board). */
  resolveCard(taskId: string): CardLinkInfo | null;
  /** Changes when the board's cards change, so chips refresh. */
  cardsVersion?: unknown;
  /** Discuss on an idea (§9.5): text for the message box, after what is typed; never sent. A new `key` adds it again. */
  fill?: { text: string; key: number } | null;
  /** The fill with this key is in the box: the board drops it, so a remounted panel does not add it again. */
  onFilled?(key: number): void;
  /** D (or the toolbar button) opened or pressed the dock: focus the message box. A new value asks again. */
  focusRequest?: number;
  /** Esc in the focused box. The board decides (escAction) with the draft's state and returns "blur" to leave the box. */
  onEscape?(draftEmpty: boolean): "blur" | "closeDock" | "chain" | "modal";
  /** The message box gained focus: the dock is the board's active area. */
  onBoxFocus?(): void;
  /** The board group whose dispatcher this chat talks to (DISPATCHER-SPEC §0); null while none is known: nothing is read. */
  groupId: string | null;
  /** Opens the dispatcher session in Paseo, as a card session's Open in Paseo; absent when the host cannot. */
  onOpenInPaseo?(agentId: string): void;
  /** The dispatcher session the chat shows while it is up, else null: the dock header offers Open in Paseo for it. */
  onSession?(agentId: string | null): void;
};

export const DispatcherPanel = memo(function DispatcherPanel({ visible, compact = false, laneOf, onOpenCard, resolveCard, cardsVersion, fill, onFilled, focusRequest = 0, onEscape, onBoxFocus, groupId, onOpenInPaseo, onSession }: Props) {
  const { colors } = useTheme();
  const paseo = usePaseo();
  const client = useQueryClient();
  const toast = useToast();
  const readStatus = useRpc(rpc.dispatcherStatus);
  const startRpc = useRpc(rpc.dispatcherStart);
  const sendRpc = useRpc(rpc.dispatcherSend);
  const replaceRpc = useRpc(rpc.dispatcherReplace);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const status = useQuery({
    queryKey: [...dispatcherStatusKey, groupId ?? "-"],
    queryFn: () => readStatus({ groupId: groupId! }),
    enabled: visible && !!groupId,
    refetchInterval: visible && groupId ? 5_000 : false,
    placeholderData: (p) => p,
  });
  const items = useDispatcherItemsQuery(visible, groupId);
  const state = status.data?.state;
  const agentId = status.data?.agentId ?? null;
  const up = state === "running" || state === "idle";
  // An unguarded dispatcher takes no messages from the user until Replace; the daemon refuses them too (§3).
  const locked = up && !!status.data?.unguarded;
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
  // The card session view's chips (Ruling, Noah 2026-11-11): model (read-only), reasoning, speed, permissions; same mode list.
  const config = useSessionConfig({ groupId: groupId ?? "" }, agent, visible && !!agent && !!groupId, () => void current.refetch());
  const [chipMenu, setChipMenu] = useState<ChipMenuId | null>(null);
  const shownSession = up && agent ? agentId : null;
  useEffect(() => onSession?.(shownSession), [shownSession]);
  useEffect(() => {
    if (!visible || !shownSession) setChipMenu(null);
  }, [visible, shownSession]);

  const start = useStableCallback(async () => {
    if (!groupId) return;
    setStartError("");
    setStarting(true);
    try {
      await startRpc({ groupId });
      await client.invalidateQueries({ queryKey: dispatcherStatusKey });
    } catch (e) {
      // Refusals arrive as `CODE: message`; the provider refusal is shown in the user's words (DISPATCHER-SPEC §3, §8).
      setStartError(dispatcherStartMessage(message(e)));
    } finally {
      setStarting(false);
    }
  });
  // Replace dispatcher (§3): only the user's confirmed click; archives exactly the session shown, then starts a guarded one.
  const replace = useStableCallback(async () => {
    if (!agentId || !groupId) return;
    setStartError("");
    setStarting(true);
    try {
      await replaceRpc({ groupId, agentId });
      setConfirmReplace(false);
      await client.invalidateQueries({ queryKey: dispatcherStatusKey });
    } catch (e) {
      setConfirmReplace(false);
      setStartError(dispatcherStartMessage(message(e)));
      // A create that failed after the archive leaves it ended: the panel shows Start with this error (§3).
      void client.invalidateQueries({ queryKey: dispatcherStatusKey });
    } finally {
      setStarting(false);
    }
  });

  // The dispatcher's rows on the shared transcript, in time order with its output (§9.3): notes and the summary.
  const renderExtra = useCallback(
    (row: TranscriptExtraRow) => {
      const extra = row.item as ChatExtra;
      if (extra.kind === "summary") return <SummaryRow />;
      return <NoteRow item={extra.item} laneOf={laneOf} onOpenCard={onOpenCard} />;
    },
    [onOpenCard, laneOf],
  );
  const chatItems = items.data;
  // Answers to other agents start as one line unless the user turned that off (§9.3); absent stored value: on.
  const nativePrefs = useSettings(nativeSessionSettings);
  const collapseReplies = nativeSessionSettingsValues(nativePrefs.status === "ready" ? nativePrefs.values : {}).dispatcherRepliesCollapsed;
  const cardLinks = useMemo(() => ({ resolve: resolveCard, open: onOpenCard, version: cardsVersion }), [resolveCard, onOpenCard, cardsVersion]);
  const extra = useMemo<TranscriptExtra>(
    () => ({
      rows: (entries) => chatRows(entries, chatItems ?? [], { collapseReplies }),
      render: renderExtra,
      focus: null,
    }),
    [chatItems, renderExtra, collapseReplies],
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
  // One draft per group (DISPATCHER-SPEC §0): switching groups keeps each group's unsent text, an outside change for the box.
  const drafts = useRef(new Map<string, string>());
  const draftGroup = useRef(groupId);
  useEffect(() => {
    if (draftGroup.current === groupId) return;
    box.flush();
    drafts.current.set(draftGroup.current ?? "-", box.read());
    draftGroup.current = groupId;
    setDraft(drafts.current.get(groupId ?? "-") ?? "");
  }, [groupId]);
  // D opened or pressed the dock (Ruling, Noah 2026-11-09): focus the message box once it shows (not on mount, not when hidden).
  const focusedFor = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === focusedFor.current || !visible) return;
    focusedFor.current = focusRequest;
    const timer = setTimeout(() => box.inputRef.current?.focus?.(), 50);
    return () => clearTimeout(timer);
  }, [focusRequest, visible]);
  const canWrite = visible && up && !locked && !!agentId && !!agent && !agent.providerUnavailable && !sending;
  // Discuss (§9.5): an outside change of the draft, as a picked next move is; the box remounts with it on phones.
  const filled = useRef(0);
  useEffect(() => {
    if (fill && fill.key !== filled.current) box.flush();
    const step = discussFill(fill, filled.current, box.read());
    if (!step) return;
    filled.current = step.key;
    onFilled?.(step.key);
    if (step.next === null) return;
    box.focusAfterChange();
    setDraft(step.next);
  }, [fill?.key]);
  const submit = useStableCallback(async () => {
    box.flush();
    const text = box.read();
    const attached = box.attachmentsRef.current;
    const images = attached.map(({ data, mimeType }) => ({ data, mimeType }));
    if (!canWrite || lock.current || !agentId || !groupId || (!text.trim() && !images.length)) return;
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
      // Through the daemon, which sends only to a guarded dispatcher (§3); steered (§9.3).
      await sendRpc({ groupId, text, ...(images.length ? { images } : {}), messageId });
      void current.refetch();
      transcript.current?.refresh();
    } catch (e) {
      transcript.current?.unecho(messageId);
      box.flush();
      setDraft(restoredDraft(text, box.read()));
      if (mounted.current) box.setAttachments([...attached, ...box.attachmentsRef.current].slice(0, maxImages));
      setError(dispatcherStartMessage(message(e)));
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
  // Saved tools are fixed when the session is created; Replace gives it this build's (§3; Ruling, Noah 2026-11-09).
  const offer = replaceOffer(status.data);
  if (agent?.providerUnavailable)
    notices.push({ key: "provider", tone: "warning", text: t("The dispatcher's provider is unavailable, so it can't take messages. Check that provider in Paseo's settings.") });

  return (
    <View ref={keyboard.ref} onLayout={keyboard.onLayout} style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: colors.surface0 }}>
      <CardLinkContext.Provider value={cardLinks}>
      <SessionTranscript
        handle={transcript}
        taskId="dispatcher"
        agentId={agentId ?? "-"}
        dispatcher={groupId ?? false}
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
      </CardLinkContext.Provider>
      {!!chipMenu && (
        <Pressable
          accessibilityLabel={t("Close menu")}
          onPress={() => setChipMenu(null)}
          style={{ ...noFocusRing, position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 }}
        />
      )}
      <Animated.View
        style={{ flexShrink: 0, minWidth: 0, backgroundColor: colors.surface0, transform: [{ translateY: keyboard.translate }], zIndex: 25, paddingHorizontal: space[3], paddingTop: space[2], paddingBottom: space[3], gap: space[2] }}
      >
        {!!error && <Notice>{error}</Notice>}
        {/* Its routes are fixed at create: one started without this build's guard keeps them, so it gets no notes until replaced (§3). */}
        {offer && (
          <View style={{ gap: space[2], alignItems: "flex-start" }}>
            <Notice tone="warning">
              {offer === "unguarded"
                ? t("This dispatcher can still answer cards' questions and permission requests: it started before Flowly took those routes away, or on a provider other than Claude. It gets no board notes until it is replaced.")
                : t(newToolsNotice)}
            </Notice>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space[2] }}>
              <Button icon="RefreshCw" disabled={starting} onPress={() => setConfirmReplace(true)}>
                {t("Replace dispatcher")}
              </Button>
              {offer === "unguarded" && <Label muted size={font.sm}>{t("Replace the dispatcher to keep chatting")}</Label>}
            </View>
            {!!startError && <Notice>{startError}</Notice>}
          </View>
        )}
        {confirmReplace && <ReplaceDialog pending={starting} onClose={() => setConfirmReplace(false)} onConfirm={() => void replace()} />}
        {up && agentId ? (
          <>
          <ComposerBox
            composer={box}
            canWrite={canWrite}
            busy={sending}
            running={running}
            preferred="steer"
            compact={compact}
            editable={!!agent && !locked}
            placeholder={t("Message the dispatcher")}
            keyboard={keyboard}
            onSubmit={() => void submit()}
            onStop={() => void config.apply({ stop: true }, t("Session stopped"))}
            // Esc: the board decides (escAction); only a kept draft leaves the box here, a close unmounts or hides it.
            onFocus={onBoxFocus}
            onEscape={() => {
              const action = onEscape?.(!draft.trim());
              if (action === "blur" || !onEscape) box.inputRef.current?.blur?.();
            }}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], zIndex: 2 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <ComposerChips
                config={config}
                menu={chipMenu}
                setMenu={setChipMenu}
                inline={false}
                disabled={!agent || locked}
                onOpenInPaseo={
                  onOpenInPaseo && agentId
                    ? () => {
                        setChipMenu(null);
                        onOpenInPaseo(agentId);
                      }
                    : undefined
                }
              />
            </View>
          </View>
          </>
        ) : (
          !!state && (
            <View style={{ gap: space[2], alignItems: "flex-start" }}>
              <Label muted size={font.md}>
                {state === "ended" ? t("The dispatcher session ended.") : t("Starts one agent session for this group's projects.")}
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

function ReplaceDialog({ pending, onClose, onConfirm }: { pending: boolean; onClose(): void; onConfirm(): void }) {
  const theme = useTheme();
  return (
    <Modal open title={t("Replace dispatcher?")} onOpenChange={(open) => !open && !pending && onClose()}>
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: space[3] }}>
            <Label>{t("Flowly archives this dispatcher session and starts a new one that can't answer cards' asks. The new one starts from a board summary, not this chat.")}</Label>
            <Label muted>{t("If the new one doesn't start, this one stays archived and you can start one again.")}</Label>
            <Actions>
              <Button quiet disabled={pending} onPress={onClose}>{t("Cancel")}</Button>
              <Button danger icon="RefreshCw" disabled={pending} onPress={onConfirm}>{t("Replace")}</Button>
            </Actions>
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
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

/** A note the dispatcher received, as one line; it opens its card. */
const NoteRow = memo(function NoteRow({ item, laneOf, onOpenCard }: { item: ChatItem; laneOf: Props["laneOf"]; onOpenCard(taskId: string): void }) {
  const { colors } = useTheme();
  // Only notes reach the chat (chatRows); asks, answers and the change line belong to the step-throughs.
  if (item.kind !== "note") return null;
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
}, (a, b) => a.laneOf === b.laneOf && a.onOpenCard === b.onOpenCard && sameItem(a.item, b.item));
