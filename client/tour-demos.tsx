import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { statusLabels, type Idea, type NextMove, type Status, type Task } from "../shared/model";
import { TaskCard } from "./card";
import { CardFootnote, ContentCard } from "./content-card";
import { Enter, MotionReveal, useReducedMotion } from "./motion";
import { loopAutoStep, type LoopAutoStep } from "./onboarding-logic";
import { NativeCardHeading } from "./native-card";
import { NextMoves } from "./next-moves";
import { StatusIcon } from "./status";
import { SummaryBody } from "./task-progress";
import { modelLabel } from "../shared/summary";
import { ClosedIdea, IdeaCard } from "./task-ideas";
import { ActivityBlock, TranscriptEntry } from "./session-transcript";
import { groupTranscript, recentSessionOutput } from "./session-state";
import { Button, CueRing, Dot, IconButton, Label, Row, font, noFocusRing, radius, relativeTime, space, tint, touch, useTheme } from "./ui";
import { t, tn } from "../shared/i18n";

/*
 * The welcome tour's live demos (ONBOARDING-SETUP-SPEC §3.1): Flowly's own components with sample
 * data that react like the real thing (open an Attention card, end a turn, pick a next step, follow
 * up an idea). Nothing here reads or writes the board, a session or a setting.
 */

export const noop = () => undefined;
export const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export function sampleTask(id: string, title: string, status: Status, type: Task["type"], priority: Task["priority"] = "normal"): Task {
  return { id: `tour-${id}`, projectId: "tour", workspaceId: "tour", sourcePath: "", repoPaths: [], title, description: "", status, priority, type, position: 0, revision: 1, operationId: "tour", createdAt: ago(240), updatedAt: ago(3), archivedAt: null };
}

/** A real Flowly component with sample data: looks live, does nothing. */
export function Sample({ children }: { children: ReactNode }) {
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {children}
    </View>
  );
}

/** Runs a callback later; every pending one is dropped when the demo unmounts (page change, tour closed). */
function useLater() {
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);
  return useCallback((run: () => void, ms: number) => {
    const id = setTimeout(() => {
      timers.current.delete(id);
      run();
    }, ms);
    timers.current.add(id);
  }, []);
}

// ——— Attention ———

type Need = { id: string; title(): string; status: Status; kind: "question" | "approval" | "error" | "unread"; minutes: number };

/** One card per kind of thing a person decides (ATTENTION-DISMISS-SPEC §2): answer, approve, fix, review. */
const needs: readonly Need[] = [
  { id: "question", title: () => t("Add rate limiting"), status: "design", kind: "question", minutes: 1 },
  { id: "approval", title: () => t("Migrate users table"), status: "development", kind: "approval", minutes: 3 },
  { id: "error", title: () => t("Fix flaky CI"), status: "test", kind: "error", minutes: 8 },
  { id: "unread", title: () => t("Update README"), status: "in_review", kind: "unread", minutes: 15 },
];

function needDetail(need: Need) {
  const reason =
    need.kind === "question"
      ? tn(1, "{n} question", "{n} questions")
      : need.kind === "approval"
        ? tn(1, "{n} approval", "{n} approvals")
        : need.kind === "error"
          ? tn(1, "{n} error", "{n} errors")
          : t("{unread} unread", { unread: 1 });
  return `Tinylink · ${statusLabels[need.status]} · ${reason}`;
}

/**
 * The overview's "N need you" chip and the step-through it starts in the card sidebar (DISPATCHER-SPEC §9.4; Ruling,
 * Noah 2026-11-09): "1 of N" with ‹ Prev / Next ›, the card's ask on top. Answering or dismissing it leaves the card
 * shown as Answered and offers Next card; the count follows. Nothing moves by itself.
 */
export function AttentionDemo() {
  const { colors } = useTheme();
  const [shown, setShown] = useState<string | null>(null);
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());
  const queue = useMemo(() => needs.filter((need) => !handled.has(need.id)), [handled]);
  const current = shown ? needs.find((need) => need.id === shown) ?? null : null;
  const index = current ? queue.findIndex((need) => need.id === current.id) : -1;
  // Once answered the card stays; its neighbours are where it was in the full list.
  const at = current ? needs.indexOf(current) : 0;
  const prev = index >= 0 ? queue[index - 1] : [...queue].reverse().find((need) => needs.indexOf(need) < at);
  const next = index >= 0 ? queue[index + 1] : queue.find((need) => needs.indexOf(need) > at);
  const handle = (id: string) => setHandled((done) => new Set(done).add(id));
  const tone = (need: Need) =>
    need.kind === "error" ? colors.statusDanger : need.kind === "unread" ? colors.statusSuccess : colors.statusWarning;
  return (
    <View style={{ gap: space[2] }}>
      <DemoControls hint={t("Try it: open or snooze a card.")} canRestart={handled.size > 0 || !!shown} onStartOver={() => (setHandled(new Set()), setShown(null))} />
      <DemoFrame height={330}>
        <View style={{ flex: 1, minWidth: 0, padding: space[3], gap: space[2] }}>
          {/* The board's overview row: the merged need-you chip starts the step-through. */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <SideTitle>{t("Board")}</SideTitle>
            </View>
            {queue.length > 0 && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={tn(queue.length, "{n} ask waiting on you. Step through it", "{n} asks waiting on you. Step through them")}
                onPress={() => setShown(queue[0].id)}
                style={(state) => {
                  const { hovered, pressed } = state as typeof state & { hovered?: boolean };
                  return { ...noFocusRing, flexDirection: "row", alignItems: "center", gap: 6, height: touch ? 30 : 24, paddingHorizontal: space[1.5] + 2, borderRadius: radius.md, backgroundColor: hovered || pressed ? colors.surface2 : "transparent" };
                }}
              >
                <Dot size={7} color={colors.statusWarning} />
                <Label size={font.sm} medium selectable={false}>{tn(queue.length, "{n} needs you", "{n} need you")}</Label>
              </Pressable>
            )}
          </View>
          {current ? (
            <Enter key="sidebar" distance={0} style={{ flex: 1, minHeight: 0 }}>
              <View style={{ flex: 1, minHeight: 0, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface0, overflow: "hidden" }}>
                {/* The step-through on top of the card sidebar. */}
                <View style={{ flexDirection: "row", alignItems: "center", gap: space[1], paddingLeft: space[3], paddingRight: space[2], paddingVertical: space[1.5], borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>
                  <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline", gap: space[2] }}>
                    <Label medium size={font.md} lines={1} selectable={false}>{t("Needs you")}</Label>
                    <Label muted size={font.sm} lines={1} selectable={false}>
                      {index >= 0 ? t("{index} of {total}", { index: index + 1, total: queue.length }) : next ? t("Answered") : t("All caught up")}
                    </Label>
                  </View>
                  <IconButton icon="ChevronLeft" label={t("Previous card")} disabled={!prev} onPress={() => prev && setShown(prev.id)} />
                  {index < 0 && next ? (
                    <Button small primary onPress={() => setShown(next.id)}>{t("Next card")}</Button>
                  ) : index < 0 ? (
                    <Button small onPress={() => setShown(null)}>{t("Done")}</Button>
                  ) : (
                    <IconButton icon="ChevronRight" label={t("Next card")} disabled={!next} onPress={() => next && setShown(next.id)} />
                  )}
                </View>
                <View style={{ padding: space[1.5] }}>
                  {index >= 0 ? (
                    <View style={{ flexDirection: "row", alignItems: "center" }}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Row
                          title={current.title()}
                          detail={needDetail(current)}
                          label={t("Open {title}", { title: current.title() })}
                          leading={<Dot size={8} color={tone(current)} />}
                          trailing={<Label muted size={font.xs} lines={1} selectable={false}>{relativeTime(ago(current.minutes))}</Label>}
                          onPress={() => handle(current.id)}
                        />
                      </View>
                      <IconButton icon="BellOff" label={t("Snooze {title}", { title: current.title() })} onPress={() => handle(current.id)} />
                    </View>
                  ) : (
                    <Enter>
                      <View style={{ paddingVertical: space[4], alignItems: "center", gap: space[2] }}>
                        <Icon name={next ? "Check" : "BellOff"} size={20} color={colors.foregroundMuted} />
                        <Label muted>{next ? current.title() : t("Nothing needs your attention.")}</Label>
                      </View>
                    </Enter>
                  )}
                </View>
              </View>
            </Enter>
          ) : !queue.length ? (
            <Enter>
              <View style={{ paddingVertical: space[4], alignItems: "center", gap: space[2] }}>
                <Icon name="BellOff" size={20} color={colors.foregroundMuted} />
                <Label muted>{t("Nothing needs your attention.")}</Label>
              </View>
            </Enter>
          ) : null}
        </View>
      </DemoFrame>
    </View>
  );
}

// ——— Progress, Next steps and Ideas: one case, turn by turn ———

/** A transcript item in the shape Paseo's timeline gives Flowly's session view (`recentSessionOutput`). */
type Said = { type: string; text?: string; name?: string; status?: string; messageId?: string };

type Turn = { work(): Said[]; reply(): string; state(): string; recap(): string; next(): string; moves(): NextMove[]; idea?: boolean };

/** The card's goal, the same in every version of its Progress (as the summarizer keeps it). */
const target = () => t("People return to the page they came from after signing in.");

const tool = (name: string): Said => ({ type: "tool_call", name, status: "completed" });

/**
 * One session fixing a bug: each turn's thinking and tool calls, its reply, the card's Progress written after it,
 * the next steps it suggests and, after the tests, an idea the agent found on the way.
 */
const turns: readonly Turn[] = [
  {
    work: () => [{ type: "reasoning", text: t("The sign-in callback drops the next parameter, so everyone lands on /home.") }, tool("Read"), tool("Grep"), tool("Edit")],
    reply: () => t("Fixed the login redirect: the sign-in callback now keeps `next` and sends people back to the page they came from."),
    state: () => t("Login redirect fixed; not tested yet."),
    recap: () => t("The sign-in callback dropped the next parameter; it now keeps it."),
    next: () => t("Run the tests."),
    moves: () => [{ label: t("Run tests"), prompt: t("Run the full test suite and fix any failures.") }],
  },
  {
    work: () => [tool("Bash"), { type: "reasoning", text: t("All green. Uploads that fail are never retried; that is outside this task.") }, tool("Read")],
    reply: () => t("Ran `npm test`: **all 132 tests pass**.\n\nWhile reading the upload code I noticed failed uploads are never retried, so I proposed an idea."),
    state: () => t("Tests pass; ready to commit."),
    recap: () => t("Ran the test suite: all 132 tests pass. Proposed retrying failed uploads as a separate idea."),
    next: () => t("Commit and push the fix."),
    moves: () => [
      { label: t("Push"), prompt: t("Commit and push the fix.") },
      { label: t("Open a PR"), prompt: t("Open a pull request for this fix.") },
    ],
    idea: true,
  },
  {
    work: () => [tool("Bash"), tool("Bash")],
    reply: () => t("Committed and pushed to `fix/login-redirect`."),
    state: () => t("Ready for review."),
    recap: () => t("Committed and pushed the fix to fix/login-redirect."),
    next: () => t("Review and merge."),
    moves: () => [],
  },
];

/** The conversation before the demo starts: your request and the first turn. */
const opening = (): Said[] => [
  { type: "user_message", text: t("After signing in, people land on /home instead of the page they came from. Fix it."), messageId: "tour-0" },
  ...turns[0].work(),
  { type: "assistant_message", text: turns[0].reply() },
];

function sampleIdea(status: Idea["status"]): Idea {
  return {
    id: "tour-idea",
    taskId: "tour",
    projectId: "tour",
    agentId: "tour",
    eventId: "tour",
    title: t("Retry failed uploads"),
    detail: "",
    rationale: t("Found while running the tests."),
    context: "",
    type: "feature",
    scope: "new",
    status,
    createdAt: ago(0),
    updatedAt: ago(0),
  };
}

/** The conversation, drawn by Flowly's own session transcript; the latest activity runs while the agent works. */
function Transcript({ said, live, before }: { said: readonly Said[]; live: boolean; before?: ReactNode }) {
  const blocks = useMemo(() => groupTranscript(recentSessionOutput(said.map((item) => ({ item })))), [said]);
  const scroll = useRef<{ scrollToEnd?(options: { animated: boolean }): void } | null>(null);
  return (
    <ScrollView
      ref={scroll as never}
      style={{ flex: 1, minHeight: 0 }}
      contentContainerStyle={{ gap: space[4], paddingRight: space[1] }}
      onContentSizeChange={() => scroll.current?.scrollToEnd?.({ animated: true })}
      // The next steps appearing below shrink the view: keep the newest reply in sight.
      onLayout={() => scroll.current?.scrollToEnd?.({ animated: false })}
    >
      {before}
      {blocks.map((block, index) =>
        block.kind === "activity" ? (
          <ActivityBlock key={block.key} block={block} live={live && index === blocks.length - 1} />
        ) : (
          <TranscriptEntry key={block.key} entry={block.entry} taskId="tour" agentId="tour" />
        ),
      )}
    </ScrollView>
  );
}

/** The message box: shows what a next step filled in; the send button starts the turn. */
function Composer({ draft, disabled, cue, onSend }: { draft: string; disabled: boolean; cue: boolean; onSend(): void }) {
  const { colors } = useTheme();
  const sendSize = touch ? 34 : 28;
  const ready = !!draft && !disabled;
  return (
    <View style={{ gap: space[1], padding: space[2], borderRadius: radius.xl, borderWidth: 1, borderColor: ready ? tint(colors.accent, 0.5) : colors.border, backgroundColor: colors.surface1 }}>
      <Label muted={!draft} size={font.md} lines={2} selectable={false}>{draft || t("Message")}</Label>
      <View style={{ alignItems: "flex-end" }}>
        <View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Send instruction")}
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          onPress={onSend}
          style={({ pressed }) => ({
            ...noFocusRing,
            width: sendSize,
            height: sendSize,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: sendSize / 2,
            backgroundColor: ready ? colors.accent : tint(colors.foregroundMuted, 0.14),
            transform: [{ scale: ready && pressed ? 0.92 : 1 }],
          })}
        >
          <Icon name="ArrowUp" size={touch ? 18 : 16} color={ready ? colors.accentForeground : colors.foregroundMuted} />
        </Pressable>
        <CueRing on={cue} radius={sendSize / 2} inset={3} />
        </View>
      </View>
    </View>
  );
}

export function SideTitle({ children }: { children: string }) {
  return (
    <Label muted medium size={font.sm} selectable={false}>
      {children}
    </Label>
  );
}

/** The hint, Pause / Play and Start over above a live demo. */
export function DemoControls({
  hint,
  auto,
  onAuto,
  canRestart,
  onStartOver,
}: {
  hint: string;
  /** Demos without autoplay leave these out and show no Pause / Play. */
  auto?: boolean;
  onAuto?(on: boolean): void;
  canRestart?: boolean;
  /** Without it there is no Start over (a still sample). */
  onStartOver?(): void;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], minHeight: 28 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        {!!hint && <Label muted size={font.sm} selectable={false}>{hint}</Label>}
      </View>
      {onAuto && <Button small quiet icon={auto ? "Pause" : "Play"} onPress={() => onAuto(!auto)}>{auto ? t("Pause") : t("Play")}</Button>}
      {onStartOver && <Button small quiet icon="RotateCcw" disabled={!canRestart} onPress={onStartOver}>{t("Start over")}</Button>}
    </View>
  );
}

const useDemoNarrow = () => useWindowDimensions().width < 640;

/** A demo's frame: a main pane and a side pane next to it, stacked on narrow windows. */
export function DemoFrame({ height, children }: { height?: number; children: ReactNode }) {
  const { colors } = useTheme();
  const narrow = useDemoNarrow();
  return (
    <View
      style={{
        flexDirection: narrow ? "column" : "row",
        alignItems: "stretch",
        height: narrow || !height ? undefined : height,
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface0,
        overflow: "hidden",
      }}
    >
      {children}
    </View>
  );
}

/** The frame's side pane: the card next to the session. */
function DemoSide({ children, first = false, width = 340 }: { children: ReactNode; first?: boolean; width?: number }) {
  const { colors } = useTheme();
  const narrow = useDemoNarrow();
  const edge = narrow ? (first ? { borderBottomWidth: 1 } : { borderTopWidth: 1 }) : first ? { borderRightWidth: 1 } : { borderLeftWidth: 1 };
  return (
    <View style={{ width: narrow ? undefined : width, padding: space[3], gap: space[3], backgroundColor: colors.surface1, ...edge, borderColor: colors.border }}>
      {children}
    </View>
  );
}

/**
 * The whole loop on one case (ONBOARDING-SETUP-SPEC §3, page 2): a session on the left, its card's Progress and
 * Ideas on the right. The last turn ended: pick Run tests, send it, and the agent answers; the card's Progress is
 * rewritten, new next steps appear and so does an idea; Good idea turns it into a task. Start over replays it.
 */
export function LoopDemo() {
  const [run, setRun] = useState(0);
  // Plays itself by default; Reduce Motion starts it paused (ONBOARDING-SETUP-SPEC §3, page 2).
  const [auto, setAuto] = useState(!useReducedMotion());
  return <LoopCase key={run} auto={auto} onAuto={setAuto} onStartOver={() => setRun((n) => n + 1)} />;
}

function LoopCase({ auto, onAuto, onStartOver }: { auto: boolean; onAuto(on: boolean): void; onStartOver(): void }) {
  const narrow = useDemoNarrow();
  const later = useLater();
  const [turn, setTurn] = useState(0);
  const [draft, setDraft] = useState("");
  const [said, setSaid] = useState<Said[]>(opening);
  const [working, setWorking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [at, setAt] = useState(() => ago(2));
  const [idea, setIdea] = useState<"none" | "open" | "task" | "dismissed">("none");
  const [cue, setCue] = useState<LoopAutoStep["cue"] | null>(null);
  const cardScroll = useRef<{ scrollToEnd?(options: { animated: boolean }): void } | null>(null);
  const send = (message = draft) => {
    if (!message || working || updating) return;
    const next = turn + 1;
    const work = turns[next].work();
    setSaid((current) => [...current, { type: "user_message", text: message, messageId: `tour-${next}` }]);
    setDraft("");
    setWorking(true);
    // The agent works step by step; forEach keeps each timer's own step on Hermes.
    work.forEach((step, index) => later(() => setSaid((current) => [...current, step]), 300 + index * 350));
    later(() => {
      // The turn ends: the reply arrives, then Flowly rewrites the card's Progress and suggests what is next.
      setSaid((current) => [...current, { type: "assistant_message", text: turns[next].reply() }]);
      setTurn(next);
      setWorking(false);
      setHidden(false);
      setUpdating(true);
      later(() => {
        setUpdating(false);
        setAt(new Date().toISOString());
        if (turns[next].idea) setIdea("open");
      }, 900);
    }, 300 + work.length * 350 + 300);
  };
  const shown = turns[turn];
  // Autoplay presses what a person would, one step at a time: ring the target, then press it.
  const autoRef = useRef(auto);
  autoRef.current = auto;
  useEffect(() => {
    setCue(null);
    if (!auto) return;
    const step = loopAutoStep({ turn, draft: !!draft, working, updating, idea });
    if (!step) return;
    const press = () => {
      if (!autoRef.current) return;
      if (step.cue === "move") setDraft(turns[0].moves()[0].prompt || "");
      else if (step.cue === "send") send(draft);
      else if (step.cue === "idea") setIdea("task");
      else onStartOver();
    };
    const ring = setTimeout(() => {
      if (step.cue === "restart") return press();
      setCue(step.cue);
      later(press, 700);
    }, step.wait);
    return () => clearTimeout(ring);
  }, [auto, turn, draft, working, updating, idea]);
  // Any press of your own takes over from autoplay.
  const own = <A extends unknown[]>(run: (...args: A) => void) => (...args: A) => {
    onAuto(false);
    run(...args);
  };
  const hint = auto
    ? t("Playing it for you. Press anything to try it yourself.")
    : idea === "open"
      ? t("Try it: Good idea turns the idea into a task.")
      : turn === 0 && !working
        ? t("Try it: pick the suggested step, then send it.")
        : "";
  return (
    <View style={{ gap: space[2] }}>
      <DemoControls hint={hint} auto={auto} onAuto={onAuto} canRestart={turn > 0 || working || !!draft} onStartOver={onStartOver} />
      {/* Tall enough that the idea below the expanded Progress card is in view. */}
      <DemoFrame height={480}>
        <View style={{ flex: narrow ? undefined : 1, minWidth: 0, padding: space[3], gap: space[3] }}>
          <SideTitle>{t("Session")}</SideTitle>
          <View style={{ flex: 1, minHeight: 0, gap: space[3] }}>
            <View style={{ flex: 1, minHeight: narrow ? 260 : 0 }}>
              <Transcript said={said} live={working} />
            </View>
            {!working && !updating && !hidden && (
              <NextMoves
                key={turn}
                moves={shown.moves()}
                disabled={false}
                cue={cue === "move" ? 0 : -1}
                onPick={own((move: NextMove) => setDraft(move.prompt || ""))}
                onDismiss={own(() => setHidden(true))}
              />
            )}
            <Composer draft={draft} disabled={working || updating} cue={cue === "send"} onSend={own(() => send())} />
          </View>
        </View>
        <DemoSide>
          <SideTitle>{t("Card")}</SideTitle>
          {/* Scrolls when Progress is expanded with Show more; stacked on narrow windows it just grows. */}
          <ScrollView
            ref={cardScroll as never}
            style={narrow ? undefined : { flex: 1, minHeight: 0 }}
            scrollEnabled={!narrow}
            contentContainerStyle={{ gap: space[3] }}
            // A new idea or task below the Progress card scrolls into view.
            onContentSizeChange={() => idea !== "none" && cardScroll.current?.scrollToEnd?.({ animated: true })}
          >
          <View style={{ gap: space[1.5] }}>
            <NativeCardHeading
              title={t("Progress")}
              trailing={updating ? <Label muted size={font.sm} selectable={false}>{t("Updating…")}</Label> : undefined}
            />
            <View style={{ opacity: updating ? 0.5 : 1 }}>
              <MotionReveal transitionKey={updating ? String(turn - 1) : String(turn)} direction={1} distance={8}>
                <ContentCard defaultOpen footer={<CardFootnote>{t("Updated {time}", { time: relativeTime(at) })} · {modelLabel("claude/claude-haiku-5-5")}</CardFootnote>}>
                  <SummaryBody
                    entry={{
                      state: (updating ? turns[turn - 1] : shown).state(),
                      target: target(),
                      recap: (updating ? turns[turn - 1] : shown).recap(),
                      next: (updating ? turns[turn - 1] : shown).next(),
                    }}
                  />
                </ContentCard>
              </MotionReveal>
            </View>
          </View>
          {idea !== "none" && (
            <Enter distance={10}>
              <View style={{ gap: space[1.5] }}>
                {idea !== "task" && <NativeCardHeading title={t("Ideas")} />}
                {idea === "open" ? (
                  <IdeaCard
                    idea={sampleIdea("open")}
                    disabled={false}
                    cueGood={cue === "idea"}
                    onGood={own(() => setIdea("task"))}
                    onDismiss={own(() => setIdea("dismissed"))}
                  />
                ) : idea === "dismissed" ? (
                  <ClosedIdea idea={sampleIdea("dismissed")} disabled={false} onOpenTask={noop} onRestore={own(() => setIdea("open"))} />
                ) : (
                  // Good idea: the follow-up card, landed in Todo.
                  <Enter distance={10}>
                    <View style={{ gap: space[1.5] }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
                        <StatusIcon status="todo" size={14} />
                        <Label medium size={font.md} selectable={false}>{statusLabels.todo}</Label>
                      </View>
                      <Sample>
                        <TaskCard
                          task={sampleTask("follow-up", t("Retry failed uploads"), "todo", "feature")}
                          selected={false}
                          legacy={false}
                          available
                          running={0}
                          sessions={0}
                          onOpen={noop}
                          onActions={noop}
                        />
                      </Sample>
                    </View>
                  </Enter>
                )}
              </View>
            </Enter>
          )}
          </ScrollView>
        </DemoSide>
      </DemoFrame>
    </View>
  );
}
