import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { taskTypeLabels, type Idea } from "../shared/model";
import { continuesInCard } from "../shared/ideas";
import { eventPoint, useMenuOpener, type MenuEntry, type Point } from "./context-menu";
import { CardBody, CardField, CardHeadline, CardMeta, CardMetaRow, CardText, ContentCard } from "./content-card";
import { Disclosure, Section, type SectionState } from "./disclosure";
import { FocusTarget, Marked, useFocusTarget, useMark } from "./drawer-focus";
import { lerp, motionDuration, useReducedMotion } from "./motion";
import { exitRows } from "./idea-rows";
import { useTaskDetail, invalidateCardViews } from "./card-detail-query";
import type { CardReference } from "../shared/card-detail";
import { useStableCallback } from "./stable";
import { PriorityIcon, TypeIcon, priorityLabels } from "./status";
import { Button, CueRing, Label, font, message, radius, relativeTime, space, touch, useTheme, noFocusRing } from "./ui";
import { t } from "../shared/i18n";

export type IdeaSession = { id: string; title?: string | null; archivedAt?: string | null };

/**
 * Drawer "Ideas": next steps agents proposed on this card (IDEAS-SPEC §5.2).
 * Renders nothing without ideas. "Good idea" offers two paths (§6): continue
 * in this card (sent to one of its sessions) or start a new card. Closing an
 * idea (Dismiss, Do it here) is optimistic: the card collapses away at once and
 * comes back with an error toast if the save fails.
 */
export function TaskIdeas({
  taskId,
  sessions,
  disabled,
  onCreate,
  onNewSession,
  onOpenTask,
  onAllIdeas,
  section,
}: {
  taskId: string;
  /** This card's sessions, newest first (archived included, for names). */
  sessions: readonly IdeaSession[];
  disabled: boolean;
  onCreate(idea: Idea): void;
  /** Opens Start session prefilled with the idea (IDEAS-SPEC §6.3). */
  onNewSession(idea: Idea): void;
  onOpenTask(id: string): void;
  /** Opens the project Ideas page showing only this card (IDEAS-INBOX-SPEC §5). */
  onAllIdeas?(): void;
  section: SectionState;
}) {
  const { detail } = useTaskDetail();
  const [closedOpen, setClosedOpen] = useState(false);
  const actions = useIdeaActions({ sessionsOf: () => sessions, onCreate, onNewSession, ideas: detail?.ideas || [], tasks: detail?.relatedTasks || [] });
  const { hidden, restoring } = actions;
  const ideas = useMemo(() => (detail?.ideas || []).filter((i) => i.taskId === taskId), [detail?.ideas, taskId]);
  const open = useMemo(() => ideas.filter((i) => i.status === "open" && !hidden.has(i.id)), [ideas, hidden]);
  const closed = ideas.filter((i) => i.status !== "open" || hidden.has(i.id)).reverse();
  const rows = useExitList(open);
  const closedRows = useExitList(closed);
  // A search hit on an accepted or dismissed idea opens Closed (DRAWER-SPEC "Focus from search").
  const focusTarget = useFocusTarget();
  const closedTarget = focusTarget.startsWith("idea:") && closed.some((i) => `idea:${i.id}` === focusTarget);
  useEffect(() => {
    if (closedTarget) setClosedOpen(true);
  }, [closedTarget]);
  if (!ideas.length) return null;
  const titleOf = (id: string) => detail?.relatedTasks.find((t) => t.id === id)?.title;
  return (
    <Section
      id={taskId}
      focusId="ideas"
      title={t("Ideas")}
      ai
      count={open.length}
      open={section.open}
      onToggle={section.onToggle}
      actions={
        onAllIdeas && (
          <Button small quiet label={t("Show this card's ideas on the project Ideas page")} onPress={onAllIdeas}>
            {t("All ideas")}</Button>
        )
      }
    >
      {rows.length ? (
        <View>
          {rows.map((row) => (
            <IdeaRow key={row.item.id} leaving={row.leaving} entering={row.entering} restored={actions.restored.has(row.item.id)}>
              <FocusTarget id={`idea:${row.item.id}`}>
                <IdeaCard idea={row.item} disabled={disabled || row.leaving} onGood={actions.choose} onDismiss={actions.dismiss} />
              </FocusTarget>
            </IdeaRow>
          ))}
        </View>
      ) : (
        <Label muted size={font.sm}>{t("No open ideas. Agents add them when they see a worthwhile next step.")}</Label>
      )}
      {closedRows.length > 0 && (
        <Disclosure title={t("Closed · {n}", { n: closed.length })} open={closedOpen} onChange={setClosedOpen}>
          <View>
            {closedRows.map((row) => (
              <IdeaRow key={row.item.id} leaving={row.leaving} entering={row.entering} spacing={space[1]}>
                <FocusTarget id={`idea:${row.item.id}`}>
                <ClosedIdea
                  idea={row.item}
                  acceptedTitle={row.item.acceptedTaskId ? titleOf(row.item.acceptedTaskId) : undefined}
                  sentTo={row.item.acceptedAgentId ? sessionName(sessions, row.item.acceptedAgentId) : undefined}
                  disabled={disabled || !!restoring || hidden.has(row.item.id) || row.leaving}
                  onOpenTask={onOpenTask}
                  onRestore={actions.restore}
                />
                </FocusTarget>
              </IdeaRow>
            ))}
          </View>
        </Disclosure>
      )}
    </Section>
  );
}

export const sessionName = (sessions: readonly IdeaSession[], id: string) => sessions.find((s) => s.id === id)?.title || t("a session");

/**
 * What both idea lists share (IDEAS-INBOX-SPEC §2.1): the Good idea menu,
 * Dismiss and Restore, with optimistic hiding. `hidden` holds ideas closed
 * here but not yet closed on the board.
 */
export function useIdeaActions({
  sessionsOf,
  onCreate,
  onNewSession,
  ideas, tasks,
}: {
  ideas: readonly Idea[];
  tasks: readonly CardReference[];
  /** The idea's card's sessions, newest first (archived included). */
  sessionsOf(taskId: string): readonly IdeaSession[];
  onCreate(idea: Idea): void;
  onNewSession(idea: Idea): void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const openMenu = useMenuOpener();
  const updateIdea = useRpc(rpc.updateIdea);
  const adoptIdea = useRpc(rpc.adoptIdea);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [restoring, setRestoring] = useState("");
  // Ideas restored here: their row opens its slot and the card comes back in, even if it was on the list at first render.
  const restored = useRef(new Set<string>()).current;
  // A closing is settled once the board shows it; drop it from the optimistic set.
  useEffect(() => {
    if (!hidden.size) return;
    const settled = [...hidden].filter((id) => !ideas?.some((i) => i.id === id && i.status === "open"));
    if (settled.length) setHidden((current) => without(current, settled));
  }, [ideas, hidden]);
  const adopt = async (idea: Idea, session: IdeaSession) => {
    setHidden((current) => new Set(current).add(idea.id));
    try {
      await adoptIdea({ id: idea.id, agentId: session.id });
      await invalidateCardViews(queryClient);
      toast.show(t("Sent to {session}", { session: session.title || t("the session") }), { variant: "success" });
    } catch (e) {
      setHidden((current) => without(current, [idea.id]));
      toast.show(message(e), { variant: "error" });
    }
  };
  const name = (s: IdeaSession) => s.title || t("this card's session");
  /**
   * Good idea (IDEAS-SPEC §6): continue in a session of this card (the
   * proposer's by default, or another one), start a new session in this card,
   * or start a new card. The agent's suggestion leads. A finished or archived
   * card only offers a new card (IDEAS-INBOX-SPEC §2.3).
   */
  const choose = useStableCallback((idea: Idea, at: Point) => {
    // A project idea has no card to continue in: New card is the only action (PROJECT-IDEAS-SPEC §5).
    if (!openMenu || !idea.taskId) return onCreate(idea);
    const card = tasks.find((t) => t.id === idea.taskId);
    if (!card || !continuesInCard(card))
      return openMenu(at, t("Good idea"), [
        { id: "card", label: t("Start a new task · Suggested"), icon: "SquarePlus", onPress: () => onCreate(idea) },
        { kind: "separator", id: "divider" },
        {
          kind: "label",
          id: "finished",
          label: card
            ? t(card.archivedAt ? "{title} is archived. Move it back to a work lane to continue in it." : "{title} is finished. Move it back to a work lane to continue in it.", { title: card.title })
            : t("Its card is gone."),
        },
      ]);
    const here = idea.scope === "here";
    const live = sessionsOf(idea.taskId).filter((s) => !s.archivedAt);
    // The session that proposed it keeps its context; otherwise the newest live one.
    const session = live.find((s) => s.id === idea.agentId) || live[0];
    const continueEntries: MenuEntry[] = [
      ...(session
        ? [{ id: "continue", label: `${t("Continue in {session}", { session: name(session) })}${here ? ` · ${t("Suggested")}` : ""}`, icon: "CornerDownRight", onPress: () => void adopt(idea, session) }]
        : []),
      ...(live.length > 1
        ? [{
            id: "other",
            label: t("Send to another session…"),
            icon: "MessagesSquare",
            onPress: () =>
              openMenu(at, t("Send to"), live.map((s) => ({ id: s.id, label: name(s), icon: s.id === session?.id ? "Check" : "MessageSquare", onPress: () => void adopt(idea, s) }))),
          }]
        : []),
      { id: "session", label: `${t("Do it in a new session")}${here && !session ? ` · ${t("Suggested")}` : ""}`, icon: "Plus", onPress: () => onNewSession(idea) },
    ];
    const cardEntry: MenuEntry = { id: "card", label: `${t("Start a new task")}${here ? "" : ` · ${t("Suggested")}`}`, icon: "SquarePlus", onPress: () => onCreate(idea) };
    const divider: MenuEntry = { kind: "separator", id: "divider" };
    openMenu(at, t("Good idea"), here ? [...continueEntries, divider, cardEntry] : [cardEntry, divider, ...continueEntries]);
  });
  const dismiss = useStableCallback(async (idea: Idea) => {
    restored.delete(idea.id);
    setHidden((current) => new Set(current).add(idea.id));
    try {
      await updateIdea({ id: idea.id, status: "dismissed" });
      await invalidateCardViews(queryClient);
    } catch (e) {
      setHidden((current) => without(current, [idea.id]));
      toast.show(message(e), { variant: "error" });
    }
  });
  const restore = useStableCallback(async (idea: Idea) => {
    restored.add(idea.id);
    setRestoring(idea.id);
    try {
      await updateIdea({ id: idea.id, status: "open" });
      await invalidateCardViews(queryClient);
      // Only this return animates in; a list mounted later (another tab, the drawer reopened) shows it plainly.
      setTimeout(() => restored.delete(idea.id), 1000);
    } catch (e) {
      restored.delete(idea.id);
      toast.show(message(e), { variant: "error" });
    } finally {
      setRestoring("");
    }
  });
  return { hidden, restoring, restored: restored as ReadonlySet<string>, choose, dismiss, restore };
}

const without = (set: ReadonlySet<string>, ids: readonly string[]) => {
  const next = new Set(set);
  for (const id of ids) next.delete(id);
  return next;
};

/**
 * The open list plus rows that just left it, held in place for their exit.
 * Rows present on first render never animate in; later arrivals do. A row that
 * just left is added back in the same render that dropped it (not after an
 * effect), so it never unmounts and its card keeps its state and size.
 */
export function useExitList<T extends { id: string }>(items: readonly T[]) {
  const [leaving, setLeaving] = useState<ReadonlyMap<string, { item: T; index: number }>>(() => new Map());
  const previous = useRef(items);
  const initial = useRef(new Set(items.map((i) => i.id)));
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const ids = new Set(items.map((i) => i.id));
    const gone = previous.current.map((item, index) => ({ item, index })).filter(({ item }) => !ids.has(item.id));
    const back = [...leaving.keys()].filter((id) => ids.has(id));
    previous.current = items;
    if (!gone.length && !back.length) return;
    for (const id of back) {
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
    }
    setLeaving((current) => {
      const next = new Map(current);
      for (const id of back) next.delete(id);
      for (const row of gone) next.set(row.item.id, row);
      return next;
    });
    // forEach, not a for loop: each timer must keep its own id on Hermes (one binding per loop `const`).
    gone.forEach(({ item }) => {
      clearTimeout(timers.current.get(item.id));
      timers.current.set(
        item.id,
        setTimeout(() => {
          timers.current.delete(item.id);
          setLeaving((current) => {
            const next = new Map(current);
            next.delete(item.id);
            return next;
          });
        }, rowExitMs + 40),
      );
    });
    // `leaving` is read, not tracked: only a change of the open list starts or cancels exits.
  }, [items]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return useMemo(() => {
    // Dropped since the last commit: the effect above has not registered them yet.
    const ids = new Set(items.map((i) => i.id));
    const dropped = previous.current
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !ids.has(item.id) && !leaving.has(item.id));
    return exitRows(items, [...leaving.values(), ...dropped], initial.current);
  }, [items, leaving]);
}


/** A row that left is held this long: its exit (fade and collapse). */
const rowExitMs = motionDuration.reverse;

/**
 * `value` while it is truthy; once it turns falsy, the last truthy value for a
 * row exit longer. A container uses it to outlive its last row's exit instead
 * of unmounting the row while it is still collapsing.
 */
export function useHeld<T>(value: T, ms: number = rowExitMs + 40): T | undefined {
  const [held, setHeld] = useState<T | undefined>(value || undefined);
  useEffect(() => {
    if (value) {
      setHeld(value);
      return;
    }
    const timer = setTimeout(() => setHeld(undefined), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return value || held;
}

/**
 * Holds one idea's slot (also each memory's). Arriving (or `restored`) rows
 * open their slot, then the card rises in. Leaving rows fade and collapse.
 */
export function IdeaRow({
  leaving,
  entering,
  restored = false,
  spacing = space[2],
  children,
}: {
  leaving: boolean;
  entering: boolean;
  /** Restored while the list was showing: animate it in even if it was there at first render. */
  restored?: boolean;
  /** Space below the row, inside the collapsing slot. */
  spacing?: number;
  children: ReactNode;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const body = (
    <View onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })} style={{ paddingBottom: spacing }}>
      {children}
    </View>
  );
  // The same wrapper whether the row is arriving, resting or leaving, so the card is not remounted when it starts to leave.
  return (
    <RowOut leaving={leaving} height={size.height}>
      {entering || restored ? <InsertIn>{body}</InsertIn> : body}
    </RowOut>
  );
}

/**
 * Opens a slot for its child (height from 0), then brings the child in,
 * rising a few points while it fades in. Once in,
 * the same views lay out normally so the card can still grow (Show more).
 * JS driver: height is layout.
 */
function InsertIn({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [open] = useState(() => new Animated.Value(0));
  const [show] = useState(() => new Animated.Value(0));
  const [done, setDone] = useState(reduced);
  const measured = size.height > 0;
  useEffect(() => {
    if (done || !measured) return;
    const animation = Animated.sequence([
      Animated.timing(open, { toValue: 1, duration: motionDuration.reverse, easing: Easing.out(Easing.quad), useNativeDriver: false }),
      Animated.timing(show, { toValue: 1, duration: motionDuration.forward, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
    ]);
    animation.start(({ finished }) => finished && setDone(true));
    return () => animation.stop();
  }, [open, show, done, measured]);
  return (
    <Animated.View style={done ? undefined : { overflow: "hidden", height: lerp(open, [0, size.height || 1]) }}>
      <Animated.View
        onLayout={done ? undefined : (e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
        style={
          done
            ? undefined
            : {
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                opacity: show,
                transform: [{ translateY: lerp(show, [8, 0]) }],
              }
        }
      >
        {children}
      </Animated.View>
    </Animated.View>
  );
}

/**
 * A row's exit. At rest it is a plain pass-through. Leaving, the card fades and
 * shrinks slightly while its slot closes. JS driver: height is layout.
 */
function RowOut({ leaving, height, children }: { leaving: boolean; height: number; children: ReactNode }) {
  const reduced = useReducedMotion();
  const [close] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!leaving) {
      close.setValue(0);
      return;
    }
    if (reduced) {
      close.setValue(1);
      return;
    }
    const animation = Animated.timing(close, { toValue: 1, duration: motionDuration.reverse, easing: Easing.inOut(Easing.quad), useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [leaving, reduced, close]);
  return (
    <Animated.View
      pointerEvents={leaving ? "none" : undefined}
      accessibilityElementsHidden={leaving || undefined}
      importantForAccessibility={leaving ? "no-hide-descendants" : undefined}
      style={leaving ? { overflow: "hidden", height: height ? lerp(close, [height, 0]) : undefined } : undefined}
    >
      <Animated.View style={leaving ? { opacity: lerp(close, [1, 0]), transform: [{ scale: lerp(close, [1, 0.97]) }] } : undefined}>
        {children}
      </Animated.View>
    </Animated.View>
  );
}

export const IdeaCard = memo(function IdeaCard({
  idea,
  disabled,
  source,
  onGood,
  onDismiss,
  cueGood = false,
}: {
  idea: Idea;
  disabled: boolean;
  /** The source card line on the Ideas page (IDEAS-INBOX-SPEC §4.2). */
  source?: ReactNode;
  /** Ring Good idea (the welcome tour's autoplay). */
  cueGood?: boolean;
  onGood(idea: Idea, at: Point): void;
  onDismiss(idea: Idea): void;
}) {
  const { colors } = useTheme();
  // A search hit on this idea marks its words and opens it past Show more (DRAWER-SPEC "Focus from search" 7).
  const mark = useMark(`idea:${idea.id}`);
  const terms = mark?.terms;
  const meta = [
    <CardMeta
      key="scope"
      icon={<Icon name={idea.scope === "here" ? "CornerDownRight" : "SquarePlus"} size={12} color={colors.foregroundMuted} />}
      text={idea.scope === "here" ? t("Continues this task") : t("New task")}
    />,
    idea.type && (
      <CardMeta key="type" icon={<TypeIcon type={idea.type} size={12} />} text={taskTypeLabels[idea.type]} />
    ),
    idea.priority && idea.priority !== "normal" && (
      // Low's single-bar glyph reads as stray punctuation at this size; only the High/Urgent arrows add meaning.
      <CardMeta
        key="priority"
        icon={idea.priority === "low" ? null : <PriorityIcon priority={idea.priority} size={12} />}
        text={idea.priority === "low" ? t("Low priority") : priorityLabels[idea.priority]}
      />
    ),
  ].filter(Boolean);
  return (
    <ContentCard
      after={source}
      openWhen={mark}
      footer={
        <View style={{ flexShrink: 1, flexDirection: "row", justifyContent: "flex-end", gap: space[2] }}>
          <Button quiet disabled={disabled} label={t("Dismiss {title}", { title: idea.title })} onPress={() => onDismiss(idea)}>
            {t("Dismiss")}</Button>
          <View>
          <Button
            primary
            icon="ThumbsUp"
            disabled={disabled}
            label={t("Good idea: {title}. Choose to do it in this task or start a new task.", { title: idea.title })}
            onPress={(event) => onGood(idea, eventPoint(event))}
          >
            {t("Good idea")}</Button>
          <CueRing on={cueGood} radius={radius.md} inset={3} />
          </View>
        </View>
      }
    >
      <CardBody>
        {/* Title and meta stay together. */}
        <View style={{ gap: space[1.5] }}>
          <CardHeadline selectable={false}>
            <Marked text={idea.title} terms={terms} />
          </CardHeadline>
          <CardMetaRow>
            {meta}
            <CardMeta text={relativeTime(idea.createdAt)} />
          </CardMetaRow>
        </View>
        {!!idea.rationale.trim() && (
          <CardText>
            <Marked text={idea.rationale} terms={terms} />
          </CardText>
        )}
        <CardField title={t("What to do")} text={idea.detail} terms={terms} />
        <CardField title={t("Context")} text={idea.context} terms={terms} />
      </CardBody>
    </ContentCard>
  );
});

export function ClosedIdea({
  idea,
  acceptedTitle,
  sentTo,
  disabled,
  onOpenTask,
  onRestore,
}: {
  idea: Idea;
  acceptedTitle?: string;
  /** Accepted in this card: the session it was sent to. */
  sentTo?: string;
  disabled: boolean;
  onOpenTask(id: string): void;
  onRestore(idea: Idea): void;
}) {
  const { colors } = useTheme();
  const accepted = idea.status === "accepted";
  // A search hit here: mark the title and, when the words are in another field, show that field under it.
  const mark = useMark(`idea:${idea.id}`);
  const matched = mark && mark.field && mark.field !== "title" ? idea[mark.field as "detail" | "rationale" | "context"] : "";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], minHeight: touch ? 44 : 32 }}>
      <Icon name={accepted ? "ThumbsUp" : "CircleSlash"} size={14} color={accepted ? colors.statusSuccess : colors.foregroundMuted} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Label size={font.sm} muted={!accepted} lines={mark ? undefined : 1} selectable={false}>
          <Marked text={idea.title} terms={mark?.terms} />
        </Label>
        {!!matched && (
          <Label size={font.sm} muted selectable={false}>
            <Marked text={matched} terms={mark?.terms} />
          </Label>
        )}
        {accepted &&
          (sentTo ? (
            <Label muted size={font.xs} lines={1} selectable={false}>{`→ ${t("Sent to {session}", { session: sentTo })}`}</Label>
          ) : acceptedTitle && idea.acceptedTaskId ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={t("Open task {title}",  { title: acceptedTitle })}
              onPress={() => onOpenTask(idea.acceptedTaskId!)}
              style={({ pressed }) => ({ ...noFocusRing, opacity: pressed ? 0.7 : 1 })}
            >
              <Label size={font.xs} color={colors.accent} lines={1} selectable={false}>→ {acceptedTitle}</Label>
            </Pressable>
          ) : (
            <Label muted size={font.xs} selectable={false}>{`→ ${t("deleted card")}`}</Label>
          ))}
      </View>
      {!accepted && (
        <Button small quiet icon="Undo2" disabled={disabled} label={t("Restore {title}", { title: idea.title })} onPress={() => onRestore(idea)}>
          {t("Restore")}</Button>
      )}
    </View>
  );
}

