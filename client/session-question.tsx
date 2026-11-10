import { memo, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import {
  allAnswered,
  answerReply,
  choose,
  dismissLabel,
  dismissReply,
  emptyDraft,
  isAnswered,
  nextUnanswered,
  parseQuestions,
  showsTextInput,
  stepQuestion,
  typeOther,
  type FormQuestion,
  type PendingRequest,
  type PermissionReply,
} from "../shared/permission-question";
import { Button, Label, TextBox, font, noFocusRing, radius, space, tint, touch, useTheme } from "./ui";
import { useShortcutBlock } from "./shortcuts";
import { Enter } from "./motion";
import { composerEnterAction, type ComposerKey } from "./session-input";
import { t } from "../shared/i18n";

/** RN-Web forwards React keyboard events on View; React Native's types omit them. */
type WebKeyEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  nativeEvent?: { isComposing?: boolean };
  preventDefault(): void;
  stopPropagation(): void;
};

type Respond = (request: PendingRequest, reply: PermissionReply) => void;

/**
 * The session's open agent questions and permission requests, answered in
 * place (SESSION-QUESTION-SPEC). It sits in the surrounding scroll (the
 * transcript's, or the drawer's), so a tall form scrolls with it.
 */
export const PendingRequests = memo(function PendingRequests({
  requests,
  disabled,
  onRespond,
}: {
  requests: readonly PendingRequest[];
  disabled: boolean;
  onRespond: Respond;
}) {
  const { colors } = useTheme();
  if (!requests.length) return null;
  const forms = requests.map((request) => {
    const questions = parseQuestions(request);
    return questions ? (
      <QuestionForm key={request.id} request={request} questions={questions} disabled={disabled} onRespond={onRespond} />
    ) : (
      <Approval key={request.id} request={request} disabled={disabled} onRespond={onRespond} />
    );
  });
  return (
    <Enter distance={6}>
      <View
        testID="session-pending-requests"
        style={{
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: tint(colors.statusWarning, 0.45),
          backgroundColor: colors.surface1,
          overflow: "hidden",
        }}
      >
        <View style={{ padding: space[3], gap: space[3] }}>{forms}</View>
      </View>
    </Enter>
  );
});

function Heading({ icon, text }: { icon: string; text: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
      <Icon name={icon} size={14} color={colors.statusWarning} />
      <Label medium size={font.md} selectable={false}>{text}</Label>
    </View>
  );
}

function QuestionForm({
  request,
  questions,
  disabled,
  onRespond,
}: {
  request: PendingRequest;
  questions: FormQuestion[];
  disabled: boolean;
  onRespond: Respond;
}) {
  const [draft, setDraftState] = useState(() => emptyDraft(questions));
  // The latest draft for Enter-to-submit, which can run before the re-render.
  const latest = useRef(draft);
  const setDraft = (next: (d: typeof draft) => typeof draft) => {
    latest.current = next(latest.current);
    setDraftState(latest.current);
  };
  // Several questions are answered one tab at a time.
  const [tab, setTab] = useState(0);
  const tabbed = questions.length > 1;
  const index = Math.min(tab, questions.length - 1);
  const q = questions[index];
  const ready = allAnswered(questions, draft);
  // Enter in a typed answer submits once everything is answered, otherwise moves on.
  const submit = () => {
    if (disabled) return;
    if (!allAnswered(questions, latest.current)) {
      const next = nextUnanswered(questions, latest.current, index);
      if (next >= 0) setTab(next);
      return;
    }
    onRespond(request, answerReply(request, questions, latest.current));
  };
  // Web: ←/→ switch questions while focus is in the form (not in a typed answer). The
  // focused option unmounts with its question, so focus moves to the form itself.
  const form = useRef<View>(null);
  const typing = useRef(false);
  const keys =
    Platform.OS === "web" && tabbed
      ? {
          focusable: true,
          onKeyDown: (e: WebKeyEvent) => {
            if (typing.current) return;
            const next = stepQuestion({ ...e, isComposing: e.nativeEvent?.isComposing }, index, questions.length);
            if (next === null) return;
            e.preventDefault();
            e.stopPropagation();
            setTab(next);
            (form.current as unknown as { focus?: () => void } | null)?.focus?.();
          },
        }
      : {};
  return (
    <View ref={form} {...(keys as {})} accessibilityLabel={t("Agent question")} style={{ ...noFocusRing, gap: space[3] }}>
      <Heading icon="MessageCircleQuestion" text={t("The agent is asking")} />
      {tabbed && (
        <QuestionTabs questions={questions} draft={draft} active={index} onSelect={setTab} />
      )}
      <QuestionItem
        key={`${index}:${q.header}`}
        question={q}
        showHeader={!tabbed}
        selected={draft.selected[index] || []}
        other={draft.other[index] || ""}
        disabled={disabled}
        onChoose={(option) => setDraft((d) => choose(d, questions, index, option))}
        onTyping={(on) => (typing.current = on)}
        onType={(value) => setDraft((d) => typeOther(d, questions, index, value))}
        onSubmit={submit}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space[2] }}>
        <Button quiet small disabled={disabled} onPress={() => onRespond(request, dismissReply(request, questions, draft))}>
          {dismissLabel(questions) || t("Dismiss")}
        </Button>
        <Button primary small icon="Send" disabled={disabled || !ready} onPress={submit}>
          {t("Submit answer")}
        </Button>
      </View>
    </View>
  );
}

/** One tab per question, titled by its header; answered ones carry a check. */
function QuestionTabs({
  questions,
  draft,
  active,
  onSelect,
}: {
  questions: FormQuestion[];
  draft: ReturnType<typeof emptyDraft>;
  active: number;
  onSelect(index: number): void;
}) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1.5] }}>
      {questions.map((q, i) => {
        const on = i === active;
        const done = isAnswered(q, i, draft);
        const label = q.header || String(i + 1);
        return (
          <Pressable
            key={`${i}:${q.header}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: on, checked: done }}
            accessibilityLabel={label}
            onPress={() => onSelect(i)}
            style={(state) => {
              const { hovered } = state as typeof state & { hovered?: boolean };
              return {
                ...noFocusRing,
                flexDirection: "row",
                alignItems: "center",
                gap: space[1],
                minHeight: touch ? 36 : 26,
                paddingHorizontal: space[2],
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: on ? colors.accent : colors.border,
                backgroundColor: on ? tint(colors.accent, 0.1) : hovered ? colors.surface2 : colors.surface0,
              };
            }}
          >
            {done && <Icon name="Check" size={12} color={colors.statusSuccess} />}
            <Label size={font.sm} medium={on} muted={!on && !done} lines={1} selectable={false}>{label}</Label>
          </Pressable>
        );
      })}
    </View>
  );
}

function QuestionItem({
  question,
  showHeader,
  selected,
  other,
  disabled,
  onChoose,
  onType,
  onTyping,
  onSubmit,
}: {
  question: FormQuestion;
  /** The header doubles as the tab title when there are several questions. */
  showHeader: boolean;
  selected: number[];
  other: string;
  disabled: boolean;
  onChoose(option: number): void;
  onType(value: string): void;
  onTyping(on: boolean): void;
  /** Enter (web) submits the form; Shift+Enter is a new line. */
  onSubmit(): void;
}) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  useShortcutBlock(focused);
  return (
    <View style={{ gap: space[1.5] }}>
      {showHeader && !!question.header && (
        <Label muted size={font.xs} medium selectable={false}>{question.header.toUpperCase()}</Label>
      )}
      <Label size={font.base}>{question.question}</Label>
      {question.multiSelect && question.options.length > 0 && (
        <Label muted size={font.xs} selectable={false}>{t("Choose one or more")}</Label>
      )}
      {question.options.map((option, i) => {
        const on = selected.includes(i);
        return (
          <Pressable
            key={`${i}:${option.label}`}
            accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
            accessibilityState={{ checked: on, disabled }}
            accessibilityLabel={option.label}
            disabled={disabled}
            onPress={() => onChoose(i)}
            style={(state) => {
              const { hovered } = state as typeof state & { hovered?: boolean };
              return {
                ...noFocusRing,
                flexDirection: "row",
                alignItems: "flex-start",
                gap: space[2],
                minHeight: touch ? 44 : 32,
                paddingHorizontal: space[2],
                paddingVertical: space[1.5],
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: on ? colors.accent : colors.border,
                backgroundColor: on ? tint(colors.accent, 0.1) : hovered ? colors.surface2 : colors.surface0,
                opacity: disabled ? 0.6 : 1,
              };
            }}
          >
            <View
              style={{
                marginTop: 2,
                width: 16,
                height: 16,
                borderRadius: question.multiSelect ? radius.sm : 8,
                borderWidth: 1.5,
                borderColor: on ? colors.accent : colors.foregroundMuted,
                backgroundColor: on && question.multiSelect ? colors.accent : "transparent",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {on && (question.multiSelect ? (
                <Icon name="Check" size={11} color={colors.accentForeground} />
              ) : (
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent }} />
              ))}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Label size={font.md} medium={on} selectable={false}>{option.label}</Label>
              {!!option.description && <Label muted size={font.sm} selectable={false}>{option.description}</Label>}
            </View>
          </Pressable>
        );
      })}
      {showsTextInput(question) && (
        <TextBox
          accessibilityLabel={question.options.length ? t("Other answer") : question.question}
          value={other}
          onChangeText={onType}
          editable={!disabled}
          multiline
          placeholder={question.placeholder || (question.options.length ? t("Other…") : t("Type your answer"))}
          {...(Platform.OS === "web"
            ? {
                onKeyPress: (event: { nativeEvent: unknown; preventDefault(): void }) => {
                  const action = composerEnterAction(event.nativeEvent as ComposerKey);
                  if (action === "native") return;
                  event.preventDefault();
                  if (action !== "suppress") onSubmit();
                },
              }
            : {})}
          onFocus={() => {
            setFocused(true);
            onTyping(true);
          }}
          onBlur={() => {
            setFocused(false);
            onTyping(false);
          }}
          style={{
            borderWidth: 1,
            borderColor: focused ? colors.foregroundMuted : colors.border,
            borderRadius: radius.md,
            paddingHorizontal: space[2] + 2,
            paddingVertical: space[1.5] + 2,
            minHeight: touch ? 44 : 34,
            maxHeight: 120,
            color: colors.foreground,
            backgroundColor: colors.surface0,
            fontSize: font.md,
            textAlignVertical: "top",
            outlineStyle: "none",
          } as never}
        />
      )}
    </View>
  );
}

/** A tool, plan or mode approval: its title and the provider's actions (or Allow / Deny). */
function Approval({ request, disabled, onRespond }: { request: PendingRequest; disabled: boolean; onRespond: Respond }) {
  const actions = request.actions?.length
    ? request.actions
    : [
        { id: "", label: t("Deny"), behavior: "deny" as const, variant: "secondary" },
        { id: "", label: t("Allow"), behavior: "allow" as const, variant: "primary" },
      ];
  return (
    <View accessibilityLabel={t("Permission request")} style={{ gap: space[2] }}>
      <Heading icon="ShieldAlert" text={request.kind === "plan" ? t("The agent has a plan for you to review") : t("The agent needs your approval")} />
      <Label size={font.md} medium>{request.title || request.name || t("Permission request")}</Label>
      {!!request.description && <Label muted size={font.sm} lines={8}>{request.description}</Label>}
      <Label muted size={font.xs} selectable={false}>{t("Open in Paseo for the full details.")}</Label>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space[2] }}>
        {actions.map((action, i) => (
          <Button
            key={`${i}:${action.id}`}
            small
            primary={action.variant === "primary"}
            danger={action.variant === "danger"}
            quiet={action.variant !== "primary" && action.variant !== "danger"}
            disabled={disabled}
            onPress={() =>
              onRespond(
                request,
                action.behavior === "allow"
                  ? { behavior: "allow", ...(action.id ? { selectedActionId: action.id } : {}) }
                  : { behavior: "deny", ...(action.id ? { selectedActionId: action.id } : {}), message: "Denied by user" },
              )
            }
          >
            {action.label}
          </Button>
        ))}
      </View>
    </View>
  );
}
