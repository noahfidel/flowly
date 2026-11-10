import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { statusLabels, type Idea, type NextMove, type Status, type Task } from "../shared/model";
import { AttentionButton } from "./attention-button";
import { TaskCard } from "./card";
import { CardFootnote, ContentCard } from "./content-card";
import { Collapse } from "./disclosure";
import { Enter, MotionReveal, useReducedMotion } from "./motion";
import { loopAutoStep, memoryAutoStep, type LoopAutoStep, type MemoryPhase } from "./onboarding-logic";
import { MemoryCard, SourceLine, type MemoryActions } from "./memory";
import type { MemoryEntry } from "../shared/memory";
import { NativeCardHeading } from "./native-card";
import { NextMoves } from "./next-moves";
import { StatusIcon } from "./status";
import { SummaryBody } from "./task-progress";
import { modelLabel } from "../shared/summary";
import { ClosedIdea, IdeaCard, IdeaRow, useExitList } from "./task-ideas";
import { ActivityBlock, TranscriptEntry } from "./session-transcript";
import { groupTranscript, recentSessionOutput } from "./session-state";
import { Button, CountPill, CueRing, Dot, IconButton, Label, Row, font, noFocusRing, radius, relativeTime, space, tint, touch, useTheme } from "./ui";
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
 * The board's Attention button over the left dock's Attention tab (DISPATCHER-SPEC §9.4). Opening or dismissing a
 * card takes it off the list and the count follows; the bell opens and closes the tab.
 */
export function AttentionDemo() {
  const { colors } = useTheme();
  const [open, setOpen] = useState(true);
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());
  const items = useMemo(() => needs.filter((need) => !handled.has(need.id)).map((need) => ({ id: need.id, need })), [handled]);
  const rows = useExitList(items);
  const handle = (id: string) => setHandled((current) => new Set(current).add(id));
  const tone = (need: Need) =>
    need.kind === "error" ? colors.statusDanger : need.kind === "unread" ? colors.statusSuccess : colors.statusWarning;
  return (
    <View style={{ gap: space[2] }}>
      <DemoControls hint={t("Try it: open or dismiss a card.")} canRestart={handled.size > 0 || !open} onStartOver={() => (setHandled(new Set()), setOpen(true))} />
      <DemoFrame height={330}>
        <View style={{ flex: 1, minWidth: 0, padding: space[3], gap: space[2] }}>
          {/* The board's top bar: its name on the left, the bell on the right. */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <SideTitle>{t("Board")}</SideTitle>
            </View>
            <AttentionButton count={items.length} compact={false} open={open} shortcut="" onPress={() => setOpen(!open)} />
          </View>
          <Collapse open={open} id="tour-attention">
            <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface0, overflow: "hidden" }}>
              {/* The dock's two tabs, Attention showing. */}
              <View style={{ flexDirection: "row", alignItems: "center", gap: space[1], paddingHorizontal: space[2], height: 40, borderBottomWidth: 1, borderColor: colors.border }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5], paddingHorizontal: space[2] + 2, height: 28, borderRadius: radius.md, backgroundColor: colors.surface2 }}>
                  <Label medium size={font.md} lines={1} selectable={false}>{t("Attention")}</Label>
                  {!!items.length && <CountPill text={String(items.length)} />}
                </View>
                <View style={{ paddingHorizontal: space[2] + 2 }}>
                  <Label medium muted size={font.md} lines={1} selectable={false}>{t("Dispatcher")}</Label>
                </View>
              </View>
              <View style={{ padding: space[1.5], gap: 2 }}>
                {rows.map((row) => (
                  <IdeaRow key={row.item.id} leaving={row.leaving} entering={row.entering} spacing={0}>
                    <View style={{ flexDirection: "row", alignItems: "center" }}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Row
                          title={row.item.need.title()}
                          detail={needDetail(row.item.need)}
                          label={t("Open {title}", { title: row.item.need.title() })}
                          leading={<Dot size={8} color={tone(row.item.need)} />}
                          trailing={<Label muted size={font.xs} lines={1} selectable={false}>{relativeTime(ago(row.item.need.minutes))}</Label>}
                          onPress={() => handle(row.item.id)}
                        />
                      </View>
                      <IconButton icon="BellOff" label={t("Dismiss {title} from Attention", { title: row.item.need.title() })} onPress={() => handle(row.item.id)} />
                    </View>
                  </IdeaRow>
                ))}
                {!rows.length && (
                  <Enter>
                    <View style={{ paddingVertical: space[4], alignItems: "center", gap: space[2] }}>
                      <Icon name="BellOff" size={20} color={colors.foregroundMuted} />
                      <Label muted>{t("Nothing needs your attention.")}</Label>
                    </View>
                  </Enter>
                )}
              </View>
            </View>
          </Collapse>
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

// ——— Project memory ———

/** The pitfall a finished card taught; `phase` decides how far it got. */
function sampleMemory(phase: MemoryPhase): MemoryEntry {
  const confirmed = phase !== "suggested";
  return {
    id: "tour-memory",
    projectId: "tour",
    kind: "pitfall",
    title: t("Never open a dialog in the frame another one closes."),
    body: "",
    tags: [],
    keywords: [],
    pinned: false,
    status: confirmed ? "active" : "candidate",
    source: { by: "retro", taskId: "tour-freeze" },
    revision: 1,
    createdAt: ago(3),
    updatedAt: ago(1),
    ...(confirmed ? { confirmedAt: ago(1) } : {}),
    ...(phase === "used" ? { usedAt: ago(0), usedBy: [{ taskId: "tour-jira", at: ago(0) }] } : {}),
  };
}

const memorySession = {
  ask: () => t("Add a Jira connection dialog to Settings."),
  work: (): Said[] => [{ type: "reasoning", text: t("Settings closes as the new dialog opens: project memory says to wait until it has closed.") }, tool("Read"), tool("Edit")],
  reply: () => t("Added **Add Jira connection** to Settings. Project memory warns that opening a dialog in the frame another one closes freezes Paseo, so it opens once Settings has finished closing."),
};

/**
 * Project memory on one case (ONBOARDING-SETUP-SPEC §3, page 3): a finished card's review suggested a pitfall.
 * Confirm it and a later card's session starts with it and gets it right; Dismiss and no card sees it.
 */
export function MemoryDemo() {
  const [run, setRun] = useState(0);
  const [auto, setAuto] = useState(!useReducedMotion());
  return <MemoryCase key={run} auto={auto} onAuto={setAuto} onStartOver={() => setRun((n) => n + 1)} />;
}

function MemoryCase({ auto, onAuto, onStartOver }: { auto: boolean; onAuto(on: boolean): void; onStartOver(): void }) {
  const { colors } = useTheme();
  const narrow = useDemoNarrow();
  const later = useLater();
  const [phase, setPhase] = useState<MemoryPhase>("suggested");
  const [said, setSaid] = useState<Said[]>([]);
  const [cue, setCue] = useState(false);
  const confirm = () => {
    if (phase !== "suggested") return;
    setPhase("confirmed");
    // A later card starts: its session gets the confirmed memory with its first instructions.
    later(() => {
      const work = memorySession.work();
      setPhase("working");
      setSaid([{ type: "user_message", text: memorySession.ask(), messageId: "tour-jira" }]);
      work.forEach((step, index) => later(() => setSaid((current) => [...current, step]), 300 + index * 350));
      later(() => {
        setSaid((current) => [...current, { type: "assistant_message", text: memorySession.reply() }]);
        setPhase("used");
      }, 300 + work.length * 350 + 300);
    }, 900);
  };
  const autoRef = useRef(auto);
  autoRef.current = auto;
  useEffect(() => {
    setCue(false);
    if (!auto) return;
    const step = memoryAutoStep(phase);
    if (!step) return;
    const ring = setTimeout(() => {
      if (step.cue === "restart") return onStartOver();
      setCue(true);
      later(() => autoRef.current && confirm(), 700);
    }, step.wait);
    return () => clearTimeout(ring);
  }, [auto, phase]);
  // Returns what the action returns: MemoryCard closes its editor only when confirm resolves true.
  const own = <A extends unknown[], R>(run: (...args: A) => R) => (...args: A): R => {
    onAuto(false);
    return run(...args);
  };
  // MemoryCard's own buttons drive the demo; everything else it could do is inert here.
  const actions = useMemo(
    () =>
      new Proxy(
        { busy: null, confirm: own(async () => (confirm(), true)), dismiss: own(async () => (setPhase("dismissed"), true)) },
        { get: (target, key) => (key in target ? target[key as keyof typeof target] : async () => false) },
      ) as unknown as MemoryActions,
    [phase],
  );
  const entry = sampleMemory(phase);
  const hint = auto
    ? t("Playing it for you. Press anything to try it yourself.")
    : phase === "suggested"
      ? t("Try it: Confirm shares it with the project's later cards.")
      : "";
  return (
    <View style={{ gap: space[2] }}>
      <DemoControls hint={hint} auto={auto} onAuto={onAuto} canRestart={phase !== "suggested"} onStartOver={onStartOver} />
      <DemoFrame height={290}>
        <DemoSide first width={400}>
          <SideTitle>{t("Project memory")}</SideTitle>
          {/* Scrolls when Edit opens the editor in the card's place. */}
          <ScrollView
            style={narrow ? undefined : { flex: 1, minHeight: 0 }}
            scrollEnabled={!narrow}
            contentContainerStyle={{ gap: space[3] }}
          >
          {phase === "dismissed" ? (
            <Enter distance={8}>
              <Label muted size={font.md}>{t("Dismissed. No later card will see it.")}</Label>
            </Enter>
          ) : (
            <MotionReveal transitionKey={phase === "suggested" ? "suggested" : "active"} direction={1} distance={6}>
              <MemoryCard
                entry={entry}
                entries={[entry]}
                actions={actions}
                disabled={false}
                now={Date.now()}
                cueConfirm={cue}
                onEdit={() => onAuto(false)}
                source={<SourceLine task={sampleTask("freeze", t("Fix Settings freeze"), "done", "bugfix")} nameOf={(status) => statusLabels[status]} onOpenTask={noop} />}
              />
            </MotionReveal>
          )}
          </ScrollView>
        </DemoSide>
        <View style={{ flex: narrow ? undefined : 1, minWidth: 0, padding: space[3], gap: space[3] }}>
          <SideTitle>{t("A later card's session")}</SideTitle>
          {said.length ? (
            <View style={{ flex: 1, minHeight: narrow ? 240 : 0 }}>
              <Transcript
                said={said}
                live={phase === "working"}
                before={
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
                    <Icon name="Brain" size={13} color={colors.accent} />
                    <Label muted size={font.sm} selectable={false}>{t("Started with 1 project memory")}</Label>
                  </View>
                }
              />
            </View>
          ) : (
            <View style={{ flex: 1, minHeight: narrow ? 120 : 0, alignItems: "center", justifyContent: "center", padding: space[4] }}>
              <Label muted size={font.md} selectable={false}>
                {phase === "dismissed" ? t("Later cards start without it.") : t("A later card starts once you confirm.")}
              </Label>
            </View>
          )}
        </View>
      </DemoFrame>
    </View>
  );
}
