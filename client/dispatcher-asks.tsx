import { memo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import * as rpc from "../shared/rpc";
import { msg, t } from "../shared/i18n";
import type { AskKind } from "../shared/attention-dismiss";
import type { ChatItem } from "../shared/dispatcher";
import { Button, IconButton, Label, Notice, TextBox, font, message, noFocusRing, radius, space, touch, useTheme } from "./ui";
import { answersWithText, sameItem } from "./dispatcher-panel-logic";
import { markAsksAnswered } from "./answered-asks";
import { startAgainMessage } from "./start-again";

/** Asks pinned on top of the card sidebar during the need-you step-through, answered in place (DISPATCHER-SPEC §9.4; Ruling, Noah 2026-11-09). */

type AskItem = Extract<ChatItem, { kind: "ask" }>;
type Answer = { optionIds?: string[]; text?: string; texts?: string[]; allow?: boolean };

const kindNames: Record<AskKind, string> = {
  question_report: msg("Question"),
  blocker_report: msg("Blocker"),
  ask_user: msg("Agent question"),
  permission: msg("Approval"),
  error: msg("Error"),
  unread: msg("Unread"),
};
const kindIcons: Record<AskKind, string> = {
  question_report: "MessageCircleQuestion",
  blocker_report: "TriangleAlert",
  ask_user: "MessageCircleQuestion",
  permission: "ShieldAlert",
  error: "CircleAlert",
  unread: "Mail",
};
/** Allow / Deny of a request without provider actions are English identities, translated here. */
const plainActions: Record<string, string> = { allow: msg("Allow"), deny: msg("Deny") };

type RowProps = { item: AskItem; focused: boolean; onOpenCard(taskId: string): void; onChanged(): void };

export const AskRow = memo(function AskRow({ item, focused, onOpenCard, onChanged }: RowProps) {
  const { colors } = useTheme();
  const kind = item.askKind ?? "unread";
  const head = [item.title, t(kindNames[kind])].join(" · ");
  if (item.state === "dismissed")
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={`${head} · ${t("Snoozed")}`} onPress={() => onOpenCard(item.taskId)} style={{ ...noFocusRing, flexDirection: "row", alignItems: "center", gap: space[1.5], minWidth: 0, opacity: 0.7 }}>
        <Icon name="BellOff" size={12} color={colors.foregroundMuted} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label muted size={font.sm} lines={1} selectable={false}>{`${head} · ${t("Snoozed")}`}</Label>
        </View>
      </Pressable>
    );
  return (
    <View style={{ borderWidth: 1, borderColor: focused ? colors.accent : colors.border, borderRadius: radius.lg, backgroundColor: colors.surface1, padding: space[2], gap: space[1.5] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5], minWidth: 0 }}>
        <Icon name={kindIcons[kind]} size={14} color={item.state === "open" ? colors.statusWarning : colors.foregroundMuted} />
        <Pressable accessibilityRole="button" accessibilityLabel={t("Open {title}", { title: item.title })} onPress={() => onOpenCard(item.taskId)} style={{ ...noFocusRing, flex: 1, minWidth: 0 }}>
          <Label medium size={font.sm} lines={1} selectable={false}>{head}</Label>
        </Pressable>
        {(item.state === "open" || item.state === "session_ended") && <DismissButton item={item} onChanged={onChanged} />}
      </View>
      {!!item.detail && <Label size={font.md} lines={8}>{item.detail}</Label>}
      {item.state === "open" ? (
        <AskBody item={item} kind={kind} onOpenCard={onOpenCard} onChanged={onChanged} />
      ) : item.state === "session_ended" ? (
        <Ended item={item} onChanged={onChanged} />
      ) : (
        <Label muted size={font.sm} selectable={false}>{item.elsewhere ? t("Answered in the session") : t("Answered")}</Label>
      )}
    </View>
  );
}, (a, b) => a.focused === b.focused && a.onOpenCard === b.onOpenCard && a.onChanged === b.onChanged && sameItem(a.item, b.item));

/** Snoozes one ask in its list (ATTENTION-DISMISS-SPEC, Needs you rows). */
function DismissButton({ item, onChanged }: { item: AskItem; onChanged(): void }) {
  const dismiss = useRpc(rpc.asksDismiss);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <IconButton
      icon="BellOff"
      label={t("Snooze {title}", { title: item.title })}
      disabled={busy}
      onPress={() => {
        setBusy(true);
        void dismiss({ signal: item.signal })
          .then(() => {
            markAsksAnswered([item.signal]);
            // An ended session has nothing that could bring it back: only a live ask promises that.
            if (item.state === "open") toast.show(t("Snoozed. It comes back when something new happens."), { variant: "success" });
            onChanged();
          }, () => onChanged())
          .finally(() => setBusy(false));
      }}
    />
  );
}

/** The ask's buttons, and the answer while it is on its way (no tick until it was delivered). */
function AskBody({ item, kind, onOpenCard, onChanged }: { item: AskItem; kind: AskKind; onOpenCard(taskId: string): void; onChanged(): void }) {
  const { colors } = useTheme();
  const answerRpc = useRpc(rpc.asksAnswer);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const send = (answer: Answer, shown: string) => {
    if (sending !== null) return;
    setSending(shown);
    setError("");
    void answerRpc({ signal: item.signal, answer })
      .then(() => {
        // Answered, answered in the session or ended: no longer open, so the bell drops it now (§9.4).
        markAsksAnswered([item.signal]);
        onChanged();
      }, (e) => setError(message(e)))
      .finally(() => setSending(null));
  };
  if (sending !== null)
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
        <ActivityIndicator size="small" color={colors.foregroundMuted} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label muted size={font.sm} lines={3}>{sending}</Label>
        </View>
      </View>
    );
  return (
    <View style={{ gap: space[1.5] }}>
      {answersWithText(item) ? (
        <TextAnswer onSend={(text) => send({ text }, text)} />
      ) : kind === "ask_user" ? (
        <QuestionAnswer item={item} onSend={send} onOpenCard={() => onOpenCard(item.taskId)} />
      ) : kind === "permission" ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
          {(item.options ?? []).map((option) => {
            const label = plainActions[option.id] ? t(plainActions[option.id]) : option.label;
            return (
              <Button key={option.id} small primary={option.id === "allow"} quiet={option.id !== "allow"} onPress={() => send({ optionIds: [option.id] }, label)}>
                {label}
              </Button>
            );
          })}
        </View>
      ) : (
        <View style={{ flexDirection: "row" }}>
          <Button small icon="ArrowUpRight" onPress={() => onOpenCard(item.taskId)}>{t("Open card")}</Button>
        </View>
      )}
      {!!error && <Notice>{error}</Notice>}
    </View>
  );
}

/** A text box with Send: the text is sent exactly as typed. */
function TextAnswer({ onSend, placeholder }: { onSend(text: string): void; placeholder?: string }) {
  const { colors } = useTheme();
  const text = useRef("");
  const [empty, setEmpty] = useState(true);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space[2] }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <TextBox
          value=""
          multiline
          placeholder={placeholder ?? t("Type your answer")}
          onChangeText={(next) => {
            text.current = next;
            setEmpty((was) => (was === !next.trim() ? was : !next.trim()));
          }}
          style={{ minHeight: touch ? 40 : 32, maxHeight: 120, paddingHorizontal: space[2], paddingVertical: space[1.5], borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, color: colors.foreground, backgroundColor: colors.surface0, fontSize: font.md }}
        />
      </View>
      <IconButton icon="Send" label={t("Send")} disabled={empty} onPress={() => text.current.trim() && onSend(text.current)} />
    </View>
  );
}

/**
 * An AskUserQuestion: its options (one per question unless multi-select), a text box under each question that
 * takes text, Send or Decline. A single-choice question takes an option or a typed answer, not both.
 */
function QuestionAnswer({ item, onSend, onOpenCard }: { item: AskItem; onSend(answer: Answer, shown: string): void; onOpenCard(): void }) {
  const { colors } = useTheme();
  const [picked, setPicked] = useState<string[]>([]);
  // Question i's typed answer; `filled` only re-renders when a box turns empty or non-empty.
  const typed = useRef<string[]>([]);
  const [filled, setFilled] = useState<boolean[]>([]);
  const questions = item.questions ?? [];
  if (!questions.length)
    return (
      <View style={{ flexDirection: "row" }}>
        <Button small icon="ArrowUpRight" onPress={onOpenCard}>{t("Open card")}</Button>
      </View>
    );
  const labels = new Map((item.options ?? []).map((o) => [o.id, o.label]));
  const toggle = (id: string) =>
    setPicked((current) => {
      if (current.includes(id)) return current.filter((x) => x !== id);
      const question = questions.find((q) => q.optionIds.includes(id));
      return question && !question.multiSelect ? [...current.filter((x) => !question.optionIds.includes(x)), id] : [...current, id];
    });
  const chose = (index: number) => questions[index].optionIds.some((id) => picked.includes(id));
  const answered = questions.every((q, i) => chose(i) || (q.allowText && !!filled[i]));
  const both = questions.some((q, i) => !q.multiSelect && q.allowText && chose(i) && !!filled[i]);
  const texts = () => questions.map((q, i) => (q.allowText ? (typed.current[i] ?? "") : ""));
  return (
    <View style={{ gap: space[1.5] }}>
      {questions.map((q, index) => (
        <View key={index} style={{ gap: space[1] }}>
          {questions.length > 1 && <Label muted size={font.sm}>{q.text}</Label>}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1.5] }}>
            {q.optionIds.map((id) => {
              const on = picked.includes(id);
              return (
                <Pressable
                  key={id}
                  accessibilityRole={q.multiSelect ? "checkbox" : "radio"}
                  accessibilityState={{ checked: on }}
                  onPress={() => toggle(id)}
                  style={{ ...noFocusRing, paddingHorizontal: space[2], minHeight: touch ? 36 : 28, justifyContent: "center", borderRadius: radius.full, borderWidth: 1, borderColor: on ? colors.accent : colors.border, backgroundColor: on ? colors.surface2 : colors.surface0 }}
                >
                  <Label size={font.sm} selectable={false}>{(labels.get(id) ?? "").replace(`${q.header}: `, "")}</Label>
                </Pressable>
              );
            })}
          </View>
          {q.allowText && (
            <TextBox
              value=""
              multiline
              placeholder={q.optionIds.length ? t("Other answer") : t("Type your answer")}
              onChangeText={(next) => {
                typed.current[index] = next;
                const now = !!next.trim();
                setFilled((was) => (!!was[index] === now ? was : questions.map((_, i) => (i === index ? now : !!was[i]))));
              }}
              style={{ minHeight: touch ? 40 : 32, maxHeight: 120, paddingHorizontal: space[2], paddingVertical: space[1.5], borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, color: colors.foreground, backgroundColor: colors.surface0, fontSize: font.md }}
            />
          )}
        </View>
      ))}
      {both && <Notice tone="warning">{t("Choose an option or type an answer, not both.")}</Notice>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
        <Button
          small
          primary
          disabled={!answered || both}
          onPress={() =>
            onSend(
              { optionIds: picked, ...(texts().some((x) => x.trim()) ? { texts: texts() } : {}) },
              [...picked.map((id) => labels.get(id) ?? ""), ...texts().map((x) => x.trim())].filter(Boolean).join(", "),
            )
          }
        >
          {t("Send")}
        </Button>
        <Button small quiet onPress={() => onSend({ allow: false }, t("Decline"))}>
          {t("Decline")}
        </Button>
      </View>
    </View>
  );
}

/** The card's session ended: Flowly never restores it; Start again starts a new one through flowly_start_card. */
function Ended({ item, onChanged }: { item: AskItem; onChanged(): void }) {
  const toast = useToast();
  const startAgain = useRpc(rpc.startAgain);
  // One key per Start again, so a retried request after a lost response starts nothing twice.
  const key = useRef(`again-${item.signal}-${Date.now()}`);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");
  return (
    <View style={{ gap: space[1.5] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
        <Label muted size={font.sm} selectable={false}>{t("Session ended")}</Label>
        {!started && (
          <Button
            small
            icon="Play"
            disabled={busy}
            onPress={() => {
              setBusy(true);
              setError("");
              void startAgain({ taskId: item.taskId, idempotencyKey: key.current })
                .then(
                  () => {
                    setStarted(true);
                    toast.show(t("Session started"), { variant: "success" });
                    onChanged();
                  },
                  (e) => setError(startAgainMessage(message(e))),
                )
                .finally(() => setBusy(false));
            }}
          >
            {t("Start again")}
          </Button>
        )}
      </View>
      {!!error && <Notice>{error}</Notice>}
    </View>
  );
}
