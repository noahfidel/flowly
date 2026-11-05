import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Modal as RNModal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useSettings } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { nativeSessionSettings, nativeSessionSettingsValues } from "../shared/settings";
import { FlowlyMark } from "./brand-icons";
import { Enter, MotionReveal, motionDuration, useMotionValue } from "./motion";
import { firstRunOutside, outsidePatch, outsideShown, stepPage, tourKey, welcomePageCount, type OutsideChoice } from "./onboarding-logic";
import { AiLanguageRow, InsightsFeatureGroup, InterfaceLanguageRow, MemoryFeatureGroup, SummaryModelGroup, UsageDataGroup, aiCostText, summaryModelOf } from "./settings-pages";
import { summarySettings, summarySettingsValues } from "../shared/summary";
import { SettingSwitch, SettingsGroup } from "./settings-ui";
import { useStored } from "./stored-settings";
export { useOnboarding } from "./onboarding-state";
import { Button, IconButton, Label, Theme, font, noFocusRing, radius, space, tint, touch, useTheme } from "./ui";
import { useShortcutBlock } from "./shortcuts";
import { AttentionDemo, DemoControls, DemoFrame, LoopDemo, MemoryDemo, SideTitle } from "./tour-demos";
import { formatLocale, t, tn } from "../shared/i18n";

/** The three Kanban objects and the Paseo object each one is (page 1 and the empty-board strip). */
const objects = [
  { icon: "Folder", name: () => t("Project"), paseo: () => t("Paseo project"), note: () => t("One folder") },
  { icon: "SquarePlus", name: () => t("Card"), paseo: () => t("Paseo workspace"), note: () => t("One task") },
  { icon: "MessagesSquare", name: () => t("Session"), paseo: () => t("Paseo agent session"), note: () => t("A chat with an agent") },
] as const;

/*
 * The welcome tour (ONBOARDING-SETUP-SPEC §3): a window of its own, wide enough for Flowly's real
 * components with sample data: live demos on the first two pages (client/tour-demos.tsx), still
 * samples after. One text scale: title lg bold · heading base bold · body md · caption sm muted.
 */

function IconTile({ name, color }: { name: string; color?: string }) {
  const { colors } = useTheme();
  const c = color || colors.accent;
  return (
    <View style={{ width: 28, height: 28, borderRadius: radius.lg, alignItems: "center", justifyContent: "center", backgroundColor: tint(c, 0.12) }}>
      <Icon name={name} size={15} color={c} />
    </View>
  );
}

function PageTitle({ title, detail, aside }: { title: string; detail?: string; aside?: ReactNode }) {
  return (
    <View style={{ gap: space[1] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
        <Label bold size={font.lg} selectable={false}>{title}</Label>
        {aside}
      </View>
      {!!detail && <Label muted size={font.md}>{detail}</Label>}
    </View>
  );
}

/** The one bordered surface of the tour. */
function Panel({ children, style }: { children: ReactNode; style?: object }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: space[2], padding: space[3], borderRadius: radius.xl, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, ...style }}>
      {children}
    </View>
  );
}

/** Columns of exactly equal width (any separators are fixed-width); stacked on narrow windows. */
function Columns({ children, separator }: { children: ReactNode[]; separator?: ReactNode }) {
  const stacked = useNarrow();
  return (
    <View style={{ flexDirection: stacked ? "column" : "row", alignItems: "stretch", gap: space[2] }}>
      {children.flatMap((child, index) => [
        ...(index > 0 && separator && !stacked
          ? [<View key={`s${index}`} style={{ width: 12, alignItems: "center", justifyContent: "center" }}>{separator}</View>]
          : []),
        <View key={index} style={stacked ? undefined : { flex: 1, flexBasis: 0, minWidth: 0 }}>
          {child}
        </View>,
      ])}
    </View>
  );
}

const tourMaxWidth = 780;
/** Columns stack when the tour window is narrower than this (phones). */
function useNarrow() {
  const { width } = useWindowDimensions();
  return Math.min(tourMaxWidth, width - 32) < 600;
}

/** Page 1: what the board is made of, and how cards ask for you (the Attention list). */
function HowPage() {
  const { colors } = useTheme();
  return (
    <View style={{ gap: space[5] }}>
      <PageTitle title={t("How Flowly works")} detail={t("Everything on the board is a real Paseo object, so you can always open it in Paseo.")} />
      <SettingsGroup>
        <InterfaceLanguageRow />
      </SettingsGroup>
      <Columns separator={<Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />}>
        {objects.map((item) => (
          <Panel key={item.icon} style={{ flex: 1 }}>
            <IconTile name={item.icon} />
            <View style={{ gap: 2 }}>
              <Label bold size={font.base} lines={1} selectable={false}>{item.name()}</Label>
              <Label size={font.sm}>{item.note()}</Label>
              <Label muted size={font.sm}>{item.paseo()}</Label>
            </View>
          </Panel>
        ))}
      </Columns>
      <AttentionDemo />
      <Columns>
        {[
          <Legend key="n" title={t("Needs you")} text={t("When an agent asks, waits for approval or fails, its card says so.")} />,
          <Legend key="b" title={t("The bell")} text={t("Counts every card that needs you.")} />,
          <Legend key="o" title={t("Open or dismiss")} text={t("Open a card to answer it, or dismiss it from the list.")} />,
        ]}
      </Columns>
    </View>
  );
}

/** "Always on" in place of a switch: built-in features are tuned in the tour, not turned off (ONBOARDING-SETUP-SPEC D1). */
function AlwaysOn() {
  const { colors } = useTheme();
  return (
    <View style={{ height: 20, justifyContent: "center", paddingHorizontal: space[1.5], borderRadius: radius.full, backgroundColor: tint(colors.statusSuccess, 0.14) }}>
      <Label medium size={font.xs} color={colors.statusSuccess} lines={1} selectable={false}>{t("Always on")}</Label>
    </View>
  );
}

/** One built-in feature under the demo: its name and one line. */
function Legend({ title, text }: { title: string; text: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Label bold size={font.base} lines={1} selectable={false}>{title}</Label>
      <Label muted size={font.sm}>{text}</Label>
    </View>
  );
}

/** Page 2: Progress, Next steps and Ideas run on every card; only their options are set here. */
function BuiltInPage({ active, outside, onOutside }: { active: boolean; outside: OutsideChoice; onOutside(next: OutsideChoice): void }) {
  const summary = useStored(useSettings(summarySettings), summarySettingsValues);
  const part = (key: keyof OutsideChoice, title: string) => (
    <SettingSwitch title={title} value={outside[key]} onChange={(value) => onOutside({ ...outside, [key]: value })} />
  );
  return (
    <View style={{ gap: space[5] }}>
      <PageTitle title={t("Built in")} aside={<AlwaysOn />} detail={t("These run on every card. You can tune them here, not turn them off.")} />
      <LoopDemo />
      <Columns>
        {[
          <Legend key="p" title={t("Progress")} text={t("Rewritten after every agent turn.")} />,
          <Legend key="n" title={t("Next steps")} text={t("Your likely next message, one tap away.")} />,
          <Legend key="i" title={t("Ideas")} text={t("Follow-ups the agent found, yours to decide.")} />,
        ]}
      </Columns>
      <SummaryModelGroup active={active} bare extra={<AiLanguageRow />} />
      <SettingsGroup
        title={t("Also in sessions outside Flowly")}
        description={`${t("After each turn in sessions Flowly doesn't manage, summary models read the recent conversation in priority order. If one fails, the same conversation is sent to the next model's provider.")} ${aiCostText("outside", summaryModelOf(summary.values))}`}
      >
        {part("progress", t("Progress"))}
        {part("nextMoves", t("Next steps"))}
        {part("ideas", t("Ideas"))}
      </SettingsGroup>
    </View>
  );
}

/** Page 3: Project memory. */
function MemoryPage() {
  return (
    <View style={{ gap: space[5] }}>
      <PageTitle title={t("Project memory")} detail={t("Later cards start knowing what earlier ones learned.")} />
      <MemoryFeatureGroup bare />
      <MemoryDemo />
      <Columns>
        {[
          <Legend key="s" title={t("Agents suggest")} text={t("Agents, and a review of each finished card, propose what is worth keeping.")} />,
          <Legend key="c" title={t("You confirm")} text={t("Nothing reaches a session until you confirm it.")} />,
          <Legend key="u" title={t("Later cards use it")} text={t("New sessions on the project start with what you confirmed.")} />,
        ]}
      </Columns>
    </View>
  );
}

/** Weekday names for the sample's labels, Monday first, in the interface locale (2026-10-19 is a Monday). */
const sampleWeekday = (offset: number) => new Date(Date.UTC(2026, 9, 19 + offset, 12)).toLocaleDateString(formatLocale(), { weekday: "short", timeZone: "UTC" });

const SAMPLE_CELL = 11;
const SAMPLE_GAP = 3;
/** Accent opacity per level, as on the Insights page; level 0 is the neutral surface. */
const SAMPLE_OPACITY = [0, 0.28, 0.5, 0.75, 1];
/** A fixed pattern of quiet and busy days, repeated over as many weeks as fit. */
const SAMPLE_PATTERN = "0012300124310023441001342200133410024432013420031244200";
/** Sample cards of a day, busiest first; a day shows as many as its level. */
const sampleCards = () => [
  { title: t("Add rate limiting"), done: true, share: 1 },
  { title: t("Fix flaky CI"), done: false, share: 0.55 },
  { title: t("Migrate users table"), done: false, share: 0.3 },
  { title: t("Update README"), done: true, share: 0.15 },
];

/**
 * The Insights page in miniature (client/insights.tsx), with sample data: the heatmap across the frame's width,
 * ending today, and the selected day's summary card. Tap a day, or page with the arrows, as on the page.
 */
function InsightsSample() {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  // Week columns that fit beside the weekday labels; the last column ends today (a Sunday in the sample).
  const weeks = width > 0 ? Math.max(8, Math.floor((width + SAMPLE_GAP) / (SAMPLE_CELL + SAMPLE_GAP))) : 0;
  const days = weeks * 7;
  const level = (index: number) => Number(SAMPLE_PATTERN[(days - 1 - index) % SAMPLE_PATTERN.length]);
  const lastActive = () => {
    for (let i = days - 1; i >= 0; i--) if (level(i) > 0) return i;
    return days - 1;
  };
  const [picked, setPicked] = useState<number | null>(null);
  const selected = picked !== null && picked < days ? picked : lastActive();
  // The day before the change: an earlier day slides in from the left, a later one from the right.
  const shown = useRef(selected);
  const from = selected < shown.current ? -16 : 16;
  useEffect(() => {
    shown.current = selected;
  }, [selected]);
  const step = (direction: 1 | -1) => {
    for (let i = selected + direction; i >= 0 && i < days; i += direction) if (level(i) > 0) return i;
    return null;
  };
  const prev = step(-1);
  const next = step(1);
  const back = days - 1 - selected;
  const date = new Date(Date.now() - back * 86_400_000).toLocaleDateString(formatLocale(), { weekday: "short", month: "short", day: "numeric" });
  const busy = level(selected);
  const cards = sampleCards().slice(0, busy);
  const turns = busy * 4 + (selected % 3);
  const done = cards.filter((c) => c.done).length;
  const numbers = busy
    ? [tn(turns, "{n} turn", "{n} turns"), tn(cards.length, "{n} card", "{n} cards"), done ? tn(done, "{n} done", "{n} done") : "", t("agent {time}", { time: `${busy * 19}m` }), t("{n} tokens", { n: `${(busy * 0.55).toFixed(1)}M` })]
        .filter(Boolean)
        .join(" · ")
    : t("No activity");
  return (
    <View style={{ gap: space[3] }}>
      <View style={{ flexDirection: "row", gap: space[2] }}>
        <View style={{ gap: SAMPLE_GAP }}>
          {[0, 1, 2, 3, 4, 5, 6].map((d) => (
            <View key={d} style={{ height: SAMPLE_CELL }}>
              {/* Taller than a cell: its own line box centered on the cell, as on the page, or the text is cut off. */}
              {d % 2 === 0 && d < 6 && (
                <View style={{ height: 16, marginTop: (SAMPLE_CELL - 16) / 2, flexShrink: 0 }}>
                  <Label muted size={font.xs} lines={1} selectable={false}>
                    {sampleWeekday(d)}
                  </Label>
                </View>
              )}
            </View>
          ))}
        </View>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", gap: SAMPLE_GAP }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
          {Array.from({ length: weeks }, (_, w) => (
            <View key={w} style={{ gap: SAMPLE_GAP }}>
              {Array.from({ length: 7 }, (_, d) => (
                <SampleCell key={d} index={w * 7 + d} level={level(w * 7 + d)} days={days} selected={selected === w * 7 + d} onSelect={setPicked} />
              ))}
            </View>
          ))}
        </View>
      </View>
      <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface0, overflow: "hidden" }}>
        <View style={{ padding: space[3], paddingBottom: cards.length ? space[2] : space[3], gap: space[1.5] }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[1], marginVertical: -space[1], marginLeft: -space[1.5] }}>
            <IconButton icon="ChevronLeft" label={t("Previous day")} disabled={prev === null} onPress={() => prev !== null && setPicked(prev)} />
            <Label bold size={font.md} selectable={false}>
              {back === 0 ? t("Today") : date}
            </Label>
            <IconButton icon="ChevronRight" label={t("Next day")} disabled={next === null} onPress={() => next !== null && setPicked(next)} />
          </View>
        </View>
        <Enter key={selected} axis="x" distance={from}>
          <View style={{ paddingHorizontal: space[3], paddingBottom: space[2] }}>
            <Label muted size={font.sm} lines={1} selectable={false}>
              {numbers}
            </Label>
          </View>
          {cards.map((card, i) => (
            <View key={card.title} style={{ flexDirection: "row", alignItems: "flex-start", gap: space[2], paddingHorizontal: space[3], paddingVertical: space[2], borderTopWidth: 1, borderColor: colors.border }}>
              <View style={{ height: 18, justifyContent: "center" }}>
                <Icon name={card.done ? "CircleCheck" : "Circle"} size={14} color={card.done ? colors.accent : colors.foregroundMuted} />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: space[1] }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Label size={font.md} lines={1} selectable={false}>
                      {card.title}
                    </Label>
                  </View>
                  <Label muted size={font.sm} lines={1} selectable={false}>
                    {[tn(Math.max(1, Math.round(turns * card.share / 2)), "{n} turn", "{n} turns"), `${Math.max(1, Math.round(busy * 19 * card.share))}m`].join(" · ")}
                  </Label>
                </View>
                <View style={{ height: 3, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" }}>
                  <View style={{ width: `${Math.round(card.share * 100)}%`, height: 3, borderRadius: 2, backgroundColor: colors.accent, opacity: SAMPLE_OPACITY[Math.max(1, 4 - i)] }} />
                </View>
              </View>
            </View>
          ))}
        </Enter>
      </View>
      <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface0, flexDirection: "row", alignItems: "flex-start", gap: space[2], paddingHorizontal: space[3], paddingVertical: space[2] }}>
        <View style={{ height: 22, justifyContent: "center" }}>
          <Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Label mono medium size={font.md} lines={1} selectable={false}>
            ship-pr
          </Label>
          <Label muted size={font.sm} lines={1} selectable={false}>
            {t("Ship a change through a pull request")}
          </Label>
        </View>
        <View style={{ alignItems: "flex-end", gap: 2 }}>
          <View style={{ paddingHorizontal: space[2], height: 20, justifyContent: "center", borderRadius: radius.full, backgroundColor: colors.surface2 }}>
            <Label size={font.xs} lines={1} selectable={false}>
              {t("New")}
            </Label>
          </View>
          <Label muted size={font.xs} selectable={false}>
            {tn(4, "{n} card", "{n} cards")}
          </Label>
        </View>
      </View>
    </View>
  );
}

/** One day of the sample heatmap; days after today leave a blank. */
function SampleCell({ index, level, days, selected, onSelect }: { index: number; level: number; days: number; selected: boolean; onSelect(index: number): void }) {
  const { colors } = useTheme();
  const date = new Date(Date.now() - (days - 1 - index) * 86_400_000).toLocaleDateString(formatLocale(), { month: "short", day: "numeric" });
  const turns = level * 4 + (index % 3);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={tn(level ? turns : 0, "{date}, {n} turn", "{date}, {n} turns", { date })}
      onPress={() => onSelect(index)}
      style={{ ...noFocusRing, width: SAMPLE_CELL, height: SAMPLE_CELL, borderRadius: 2, overflow: "hidden", backgroundColor: colors.surface2, borderWidth: selected ? 1.5 : 0, borderColor: colors.foreground }}
    >
      {level > 0 && <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.accent, opacity: SAMPLE_OPACITY[level] }} />}
    </Pressable>
  );
}

/** Page 4: Insights. */
function InsightsPage() {
  return (
    <View style={{ gap: space[5] }}>
      <PageTitle title={t("Insights")} detail={t("See which days were busy, and turn what agents keep redoing into skills.")} />
      <InsightsFeatureGroup bare workflow />
      <View style={{ gap: space[2] }}>
        <DemoControls hint={t("Try it: tap a day to see its summary.")} />
        <DemoFrame>
          <View style={{ flex: 1, minWidth: 0, padding: space[3], gap: space[3] }}>
            <SideTitle>{t("Activity")}</SideTitle>
            <InsightsSample />
          </View>
        </DemoFrame>
      </View>
      <Columns>
        {[
          <Legend key="a" title={t("Activity")} text={t("A year of agent turns per day; tap a day for its summary.")} />,
          <Legend key="s" title={t("Skills")} text={t("Drafted from your cards; added to the project only when you say so.")} />,
          <Legend key="w" title={t("Workflow")} text={t("Review rounds and tokens per card, last 7 days.")} />,
        ]}
      </Columns>
    </View>
  );
}

function Hint({ icon, text }: { icon: string; text: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: space[1.5], alignItems: "flex-start" }}>
      <View style={{ paddingTop: 2 }}>
        <Icon name={icon} size={13} color={colors.foregroundMuted} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label muted size={font.sm}>{text}</Label>
      </View>
    </View>
  );
}

function MoreFeatures() {
  const { colors } = useTheme();
  const more = [
    { icon: "Zap", title: t("Quick task"), text: t("New task asks only what you want done. Enter creates the card, starts its agent in a new worktree and lets AI name it; More options opens the full form.") },
    { icon: "ListChecks", title: t("Workpad"), text: t("Agents set the card's type and tags and write a workpad before they start: acceptance criteria, checks marked passed, failed or not run on a named commit, and what confused them. Delivering without them needs a note.") },
    { icon: "Package", title: t("Inputs and outputs"), text: t("Each card lists the files and links it worked from and delivered, added by agents or by you.") },
    { icon: "Ticket", title: t("Tickets, docs and PRs as inputs"), text: t("Start a card from a Jira ticket, Confluence page, GitHub/GitLab issue or pull request, Azure DevOps work item, or Linear issue, or add one with the Artifacts +. Agents read it every turn; Flowly never changes it.") },
    { icon: "Columns3", title: t("Linear board"), text: t("With a Linear connection, Linear in the sidebar shows your issues by state. Start card opens New task with the issue attached and the agent ready.") },
    { icon: "Search", title: t("Search"), text: t("Search past cards, summaries, notes and deliverables.") },
    { icon: "SquarePlus", title: t("Cards from your agents"), text: t("Ask an agent to create or edit cards. New cards land in Backlog or Todo; you start them.") },
    { icon: "Tags", title: t("Tags"), text: t("Tag cards by module or direction. Agents tag their own cards too; filter and search by #tag.") },
    { icon: "GitBranch", title: t("Switch to a worktree"), text: t("When local work gets tangled with other cards, move the card to its own worktree: every uncommitted change is copied, its session keeps only the card's changes, and Release takes them out of the main checkout.") },
    { icon: "FolderGit2", title: t("Saved with your project"), text: t("Each project's board is also kept in its folder (.flowly, ignored by git). Add the folder again to restore it.") },
    { icon: "Database", title: t("Backups"), text: t("Settings → Storage shows where the board is kept and its daily backups, and can restore one or export the board to JSON.") },
  ];
  return (
    <View style={{ gap: space[3] }}>
      <Label bold size={font.base} selectable={false}>{t("More features")}</Label>
      {more.map((item) => (
        <View key={item.icon} style={{ flexDirection: "row", gap: space[2], alignItems: "flex-start" }}>
          <View style={{ paddingTop: 2 }}>
            <Icon name={item.icon} size={14} color={colors.foregroundMuted} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Label bold size={font.md} selectable={false}>{item.title}</Label>
            <Label muted size={font.sm}>{item.text}</Label>
          </View>
        </View>
      ))}
    </View>
  );
}

function StartPage({ canCreate }: { canCreate: boolean }) {
  const { colors } = useTheme();
  const checklist = [
    { icon: "Folder", text: t("Pick a folder to make a project.") },
    { icon: "SquarePlus", text: t("Add your first task and start an agent.") },
    { icon: "Bell", text: t("Reply when a card says Needs you.") },
  ];
  return (
    <View style={{ gap: space[5] }}>
      <PageTitle
        title={t("Ready when you are")}
        detail={canCreate ? t("Your first three steps. Nothing is created until you confirm.") : t("Your first three steps.")}
      />
      <Panel style={{ padding: 0, gap: 0 }}>
        {checklist.map((item, index) => (
          <View
            key={item.icon}
            style={{ flexDirection: "row", alignItems: "center", gap: space[3], padding: space[3], borderTopWidth: index > 0 ? 1 : 0, borderTopColor: colors.border }}
          >
            <IconTile name={item.icon} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Label size={font.md}>{item.text}</Label>
            </View>
          </View>
        ))}
      </Panel>
      <MoreFeatures />
      <UsageDataGroup bare />
      <Hint icon="Settings" text={t("Change any of this later in Settings, the gear at the bottom left. You can reopen this tour there.")} />
    </View>
  );
}

/**
 * Floats over the bottom of a page that continues below the fold, until it is scrolled near its end:
 * page 2's settings sit under its demo (ONBOARDING-SETUP-SPEC §3.1). Pressing it scrolls to the end.
 */
function MoreBelow({ show, label, onPress }: { show: boolean; label: string; onPress(): void }) {
  const { colors } = useTheme();
  const opacity = useMotionValue(show ? 1 : 0, motionDuration.forward);
  return (
    <Animated.View pointerEvents={show ? "box-none" : "none"} style={{ position: "absolute", left: 0, right: 0, bottom: space[3], alignItems: "center", opacity }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={({ pressed }) => ({
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[1.5],
          height: touch ? 36 : 30,
          paddingHorizontal: space[3],
          borderRadius: radius.full,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: pressed ? colors.surface2 : colors.surface0,
          shadowColor: "#000",
          shadowOpacity: 0.12,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
          elevation: 3,
        })}
      >
        <Label medium size={font.sm} selectable={false}>{label}</Label>
        <Icon name="ChevronDown" size={14} color={colors.foreground} />
      </Pressable>
    </Animated.View>
  );
}

function Dots({ page }: { page: number }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: space[1.5], alignItems: "center" }} accessibilityLabel={t("Step {n} of {total}", { n: page + 1, total: welcomePageCount })}>
      {Array.from({ length: welcomePageCount }, (_, i) => (
        <View
          key={i}
          style={{
            width: i === page ? 16 : 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: i === page ? colors.accent : colors.border,
          }}
        />
      ))}
    </View>
  );
}

/** RN-Web forwards keyboard events on a focusable View; React Native's types omit them. */
type WebKeyEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  target: unknown;
  currentTarget: unknown;
  nativeEvent?: { isComposing?: boolean };
  preventDefault(): void;
  stopPropagation(): void;
};

/**
 * The welcome tour (ONBOARDING-SPEC, ONBOARDING-SETUP-SPEC): five pages that explain Flowly and
 * set its basics, in a window of its own (the host Modal's width is fixed). Closing it any way
 * (Skip, Esc, the backdrop, finishing) calls `onClose`; `onCreate` runs after the final primary
 * button. Enter, → and ← page through it (§3.2). The tour never creates a Paseo or board resource.
 */
export function WelcomeTour({
  open,
  theme,
  canCreate,
  firstRun,
  onClose,
  onCreate,
}: {
  open: boolean;
  theme: PluginTheme;
  /** There is no project yet: the last page offers Create project. */
  canCreate: boolean;
  /** Opened by itself for a new user: the outside-session switches are a draft stored when it closes. */
  firstRun: boolean;
  onClose(): void;
  onCreate(): void;
}) {
  useShortcutBlock(open);
  const native = useStored(useSettings(nativeSessionSettings), nativeSessionSettingsValues);
  // First run: nothing outside Flowly changes until the tour closes (ONBOARDING-SETUP-SPEC §4).
  const [draft, setDraft] = useState<OutsideChoice>(firstRunOutside);
  useEffect(() => {
    if (open) setDraft(firstRunOutside);
  }, [open]);
  const outside = firstRun ? draft : native.values ? outsideShown(native.values) : firstRunOutside;
  const changeOutside = (next: OutsideChoice) => (firstRun ? setDraft(next) : native.save(outsidePatch(next)));
  const finish = (then: () => void) => {
    if (firstRun) void native.saveSure(outsidePatch(draft));
    then();
  };
  const close = () => finish(onClose);
  return (
    <RNModal visible={open} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
      <Theme.Provider value={theme}>
        <TourWindow
          open={open}
          theme={theme}
          canCreate={canCreate}
          outside={outside}
          onOutside={changeOutside}
          onClose={close}
          onCreate={() => finish(onCreate)}
        />
      </Theme.Provider>
    </RNModal>
  );
}

function TourWindow({
  open,
  theme,
  canCreate,
  outside,
  onOutside,
  onClose,
  onCreate,
}: {
  open: boolean;
  theme: PluginTheme;
  canCreate: boolean;
  outside: OutsideChoice;
  onOutside(next: OutsideChoice): void;
  onClose(): void;
  onCreate(): void;
}) {
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const [page, setPage] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const root = useRef<View>(null);
  const scroll = useRef<{ scrollTo?(options: { y: number; animated: boolean }): void; scrollToEnd?(options: { animated: boolean }): void } | null>(null);
  // How far the page goes below the fold (MoreBelow).
  const fold = useRef({ y: 0, content: 0, view: 0 });
  const [below, setBelow] = useState(false);
  const measure = (patch: Partial<typeof fold.current>) => {
    Object.assign(fold.current, patch);
    const { y, content, view } = fold.current;
    setBelow(view > 0 && content - view - y > 24);
  };
  useEffect(() => {
    if (open) {
      setPage(0);
      setDirection(1);
    }
  }, [open]);
  // Keyboard: the tour holds focus on open and after each page change, so Enter works at once.
  useEffect(() => {
    if (!open) return;
    scroll.current?.scrollTo?.({ y: 0, animated: false });
    measure({ y: 0 });
    const timer = setTimeout(() => (root.current as unknown as { focus?(): void } | null)?.focus?.(), 50);
    return () => clearTimeout(timer);
  }, [open, page]);
  const last = page === welcomePageCount - 1;
  const go = (step: 1 | -1) => {
    setDirection(step);
    setPage((current) => stepPage(current, step));
  };
  const primary = () => (last ? (canCreate ? onCreate() : onClose()) : go(1));
  const onKeyDown = (e: WebKeyEvent) => {
    const action = tourKey(
      { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat, isComposing: e.nativeEvent?.isComposing },
      { page, onTour: e.target === e.currentTarget },
    );
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === "back") go(-1);
    else if (action === "next") go(1);
    else primary();
  };
  const keyboardProps = { focusable: true, onKeyDown } as object;
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space[4] }}>
      <Pressable accessible={false} importantForAccessibility="no" onPress={onClose} style={{ ...noFocusRing, ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.45)" }} />
      <View
        ref={root}
        accessibilityViewIsModal
        {...keyboardProps}
        style={{
          ...noFocusRing,
          width: Math.min(tourMaxWidth, width - 32),
          maxWidth: "100%",
          height: Math.min(760, height - 48),
          borderRadius: radius.xl,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface0,
          overflow: "hidden",
          shadowColor: "#000",
          shadowOpacity: 0.25,
          shadowRadius: 24,
          shadowOffset: { width: 0, height: 8 },
          elevation: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], paddingLeft: space[5], paddingRight: space[3], minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <FlowlyMark surface={theme.colors.surface0} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Label bold size={font.lg} selectable={false}>{t("Welcome to Flowly")}</Label>
          </View>
          <IconButton icon="X" label={t("Close")} onPress={onClose} />
        </View>
        <View style={{ flex: 1 }}>
        <ScrollView
          ref={scroll as never}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: space[5], paddingBottom: space[6] }}
          scrollEventThrottle={64}
          onScroll={(e) => measure({ y: e.nativeEvent.contentOffset.y })}
          onContentSizeChange={(_w: number, h: number) => measure({ content: h })}
          onLayout={(e) => measure({ view: e.nativeEvent.layout.height })}
        >
          <MotionReveal transitionKey={String(page)} direction={direction} distance={14}>
            {page === 0 ? (
              <HowPage />
            ) : page === 1 ? (
              <BuiltInPage active={open} outside={outside} onOutside={onOutside} />
            ) : page === 2 ? (
              <MemoryPage />
            ) : page === 3 ? (
              <InsightsPage />
            ) : (
              <StartPage canCreate={canCreate} />
            )}
          </MotionReveal>
        </ScrollView>
        <MoreBelow show={below} label={page === 1 ? t("Settings below") : t("More below")} onPress={() => scroll.current?.scrollToEnd?.({ animated: true })} />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], paddingHorizontal: space[5], paddingVertical: space[3], borderTopWidth: 1, borderTopColor: colors.border }}>
          <Dots page={page} />
          <View style={{ flex: 1 }} />
          {!last && (
            <Button quiet onPress={onClose}>
              {t("Skip")}
            </Button>
          )}
          {page > 0 && <Button onPress={() => go(-1)}>{t("Back")}</Button>}
          {last && canCreate && <Button onPress={onClose}>{t("Not now")}</Button>}
          <Button primary icon={last && canCreate ? "Plus" : touch ? undefined : "CornerDownLeft"} onPress={primary}>
            {last ? (canCreate ? t("Create project") : t("Done")) : t("Next")}
          </Button>
        </View>
      </View>
    </View>
  );
}

/** Project → Card → Session, shown on the empty board so the map is never a dead end. */
export function ConceptStrip({ onTour }: { onTour(): void }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: space[2], alignItems: "center" }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1.5], alignItems: "center", justifyContent: "center" }}>
        {objects.map((item, index) => (
          <View key={item.icon} style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
            {index > 0 && <Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space[1.5],
                paddingHorizontal: space[2],
                height: 28,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
              }}
            >
              <Icon name={item.icon} size={13} color={colors.foregroundMuted} />
              <Label size={font.sm} selectable={false}>{item.name()}</Label>
            </View>
          </View>
        ))}
      </View>
      <Label muted size={font.sm}>{t("A project is a Paseo project, a card is a workspace, a session is an agent session.")}</Label>
      <Button quiet icon="CircleHelp" onPress={onTour}>
        {t("Take the tour")}
      </Button>
    </View>
  );
}

/** One quiet row above the board: a one-time tip (dismissible) or the empty-project hint (action, no dismiss). */
export function GuideBanner({
  text,
  actionLabel,
  onAction,
  dismissLabel,
  onDismiss,
}: {
  text: string;
  actionLabel?: string;
  onAction?(): void;
  dismissLabel?: string;
  onDismiss?(): void;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        gap: space[2],
        marginHorizontal: space[3],
        marginTop: space[2],
        paddingHorizontal: space[3],
        paddingVertical: space[2],
        borderWidth: 1,
        borderColor: tint(colors.accent, 0.35),
        backgroundColor: tint(colors.accent, 0.08),
        borderRadius: radius.lg,
      }}
    >
      <Icon name="Lightbulb" size={14} color={colors.accent} />
      <View style={{ flex: 1, minWidth: 160 }}>
        <Label size={font.md}>{text}</Label>
      </View>
      {!!actionLabel && onAction && (
        <Button small primary onPress={onAction}>
          {actionLabel}
        </Button>
      )}
      {!!dismissLabel && onDismiss && (
        <Button small quiet onPress={onDismiss}>
          {dismissLabel}
        </Button>
      )}
    </View>
  );
}
