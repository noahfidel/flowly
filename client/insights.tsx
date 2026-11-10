import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { Project, Status, Task } from "../shared/model";
import { addDays } from "../shared/insights";
import { ACTIVITY_WEEKS, activityLevel, type Activity } from "../shared/activity";
import { type CardTokens, type WorkflowStats } from "../shared/workflow-stats";
import type { DigestItem } from "../shared/digest";
import { compactDuration, compactNumber, percent } from "../shared/usage";
import { complexityLevel, complexityShare, type DayCard } from "../shared/day-detail";
import { modelLabel } from "../shared/summary";
import { Collapse, Disclosure, ShowMore } from "./disclosure";
import { Enter } from "./motion";
import { localZone, useDayQuery, useDigestQuery, useInsightsQuery, useTokensQuery, useWorkflowInsightsQuery } from "./queries";
import { lineDiff, skillFile, usageIn, type Finding, type FindingTarget, type WorkflowView } from "../shared/workflow-insights";
import { AiMark, Button, IconButton, Label, Notice, TurnChevron, font, message, noFocusRing, pageBarHeight, radius, relativeTime, space, touch, useTheme, verticalContent, verticalScroll } from "./ui";
import { formatLocale, msg, t, tn } from "../shared/i18n";
import { AgentHabits, habitsSummary } from "./agent-habits";
import { useStableCallback } from "./stable";

/** Project Insights (INSIGHTS-REDESIGN-SPEC §2): a year of activity, the selected day, skills, other suggestions, the workflow. */
export const InsightsPage = memo(function InsightsPage({
  project,
  tasks,
  revision,
  compact,
  active,
  onOpenTask,
  onBack,
  onCreateFromFinding,
  onOpenSettings,
  onOpenGuardrails,
}: {
  project: Project;
  tasks: readonly Task[];
  revision: number;
  compact: boolean;
  active: boolean;
  nameOf(status: Status): string;
  onOpenTask(id: string): void;
  onBack(): void;
  /** Opens the new-task form prefilled from a workflow-insights suggestion. */
  onCreateFromFinding(finding: Finding): void;
  /** Settings → AI features, where Skills (workflow insights) are configured. */
  onOpenSettings(): void;
  /** The Guardrails page, when guardrails are on for the project (GUARDRAILS-SPEC §7.2). */
  onOpenGuardrails?(): void;
}) {
  const { colors } = useTheme();
  const insights = useInsightsQuery(project.id, revision, active);
  const data = insights.data;
  const workflow = useWorkflowInsightsQuery(project.id, active);
  const [picked, setPicked] = useState<string | null>(null);
  const day = picked ?? data?.today ?? null;
  const titleOf = (id: string) => tasks.find((x) => x.id === id)?.title || t("Removed card");
  const select = useStableCallback((d: string) => setPicked(d));
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], paddingHorizontal: space[3], height: pageBarHeight, borderBottomWidth: 1, borderColor: colors.border }}>
        <Button quiet icon="ChevronLeft" label={t("Back to board (Esc)")} onPress={onBack}>
          {t("Board")}
        </Button>
      </View>
      <ScrollView
        {...verticalScroll}
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ ...verticalContent, padding: space[3], paddingBottom: space[6] * 2, alignItems: "center" }}
      >
        <View style={{ width: "100%", maxWidth: 760, gap: space[5] }}>
          {insights.error && !data ? (
            <Notice>{message(insights.error)}</Notice>
          ) : !data || !day ? (
            <Label muted>{t("Loading insights…")}</Label>
          ) : (
            <>
              <GuardrailLedger projectId={project.id} active={active} onOpen={onOpenGuardrails} />
              <Section title={t("Activity")}>
                <Heatmap activity={data.activity} today={data.today} selected={day} compact={compact} onSelect={select} />
                <DayPanel projectId={project.id} day={day} today={data.today} activity={data.activity} active={active} titleOf={titleOf} onOpenTask={onOpenTask} onSelect={select} />
              </Section>
              <Skills projectId={project.id} view={workflow.data} error={workflow.error} titleOf={titleOf} onOpenTask={onOpenTask} onOpenSettings={onOpenSettings} />
              <OtherSuggestions projectId={project.id} view={workflow.data} titleOf={titleOf} onOpenTask={onOpenTask} onCreate={onCreateFromFinding} />
              <WorkflowNumbers projectId={project.id} flow={data.workflow} active={active} />
              {!!data.habits && (
                <Section title={t("Agent habits")} detail={[t("Last 7 days"), habitsSummary(data.habits)].filter(Boolean).join(" · ")}>
                  <AgentHabits habits={data.habits} today={data.today} compact={compact} titleOf={titleOf} onOpenTask={onOpenTask} />
                </Section>
              )}
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
});

const shortDate = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(formatLocale(), { month: "short", day: "numeric", timeZone: "UTC" });
const longDate = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(formatLocale(), { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

// ---- Activity (§2.1, §2.2) ----------------------------------------------------------

const CELL_GAP = 3;
/** Line height of an extra-small label. */
const WEEKDAY_LINE = 16;
/** Accent opacity per level; level 0 is the neutral surface. */
const LEVEL_OPACITY = [0, 0.28, 0.5, 0.75, 1];

const Cell = memo(function Cell({ day, turns, level, size, selected, onSelect }: { day: string; turns: number; level: number; size: number; selected: boolean; onSelect(day: string): void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={tn(turns, "{date}, {n} turn", "{date}, {n} turns", { date: shortDate(day) })}
      onPress={() => onSelect(day)}
      style={{ ...noFocusRing, width: size, height: size, borderRadius: 2, overflow: "hidden", backgroundColor: colors.surface2, borderWidth: selected ? 1.5 : 0, borderColor: colors.foreground }}
    >
      {level > 0 && <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.accent, opacity: LEVEL_OPACITY[level] }} />}
    </Pressable>
  );
});

/** One week, Monday on top; days after today leave a blank. Only the column holding the selection changes on a pick. */
const Week = memo(function Week({ days, counts, levels, today, size, selected, onSelect }: { days: readonly string[]; counts: string; levels: readonly number[]; today: string; size: number; selected: string | null; onSelect(day: string): void }) {
  const turns = counts.split(",").map(Number);
  return (
    <View style={{ gap: CELL_GAP }}>
      {days.map((day, i) =>
        day > today ? <View key={day} style={{ width: size, height: size }} /> : <Cell key={day} day={day} turns={turns[i]} level={activityLevel(turns[i], levels)} size={size} selected={selected === day} onSelect={onSelect} />,
      )}
    </View>
  );
});

/** A year of turns per day, GitHub style (§2.1): no totals, no streaks, just how dense the days were. */
const Heatmap = memo(function Heatmap({ activity, today, selected, compact, onSelect }: { activity: Activity; today: string; selected: string; compact: boolean; onSelect(day: string): void }) {
  const { colors } = useTheme();
  // Wide layouts stretch the 53 columns over the room beside the weekday labels, so the last week ends where the page does; compact ones scroll.
  const [gridWidth, setGridWidth] = useState(0);
  const size = compact ? 10 : gridWidth > 0 ? Math.max(8, Math.min(14, (gridWidth - (ACTIVITY_WEEKS - 1) * CELL_GAP) / ACTIVITY_WEEKS)) : 11;
  const step = size + CELL_GAP;
  const scroller = useRef<{ scrollToEnd?(o: { animated: boolean }): void } | null>(null);
  const { weeks, months } = useMemo(() => {
    const turns = new Map(activity.days.map((d) => [d.day, d.turns]));
    const weeks = Array.from({ length: ACTIVITY_WEEKS }, (_, w) => {
      const days = Array.from({ length: 7 }, (_, d) => addDays(activity.from, w * 7 + d));
      return { days, counts: days.map((d) => turns.get(d) ?? 0).join(",") };
    });
    const months: { left: number; label: string }[] = [];
    let last = "";
    weeks.forEach((w, i) => {
      const month = w.days[0].slice(0, 7);
      if (month === last) return;
      last = month;
      // A month that starts the grid with under two weeks left would crowd the next label.
      if (i === 0 && Number(w.days[0].slice(8)) > 14) return;
      months.push({ left: i * step, label: new Date(`${w.days[0]}T12:00:00Z`).toLocaleDateString(formatLocale(), { month: "short", timeZone: "UTC" }) });
    });
    return { weeks, months };
  }, [activity, step]);
  const weekday = (offset: number) => new Date(`${addDays(activity.from, offset)}T12:00:00Z`).toLocaleDateString(formatLocale(), { weekday: "short", timeZone: "UTC" });
  const grid = (
    <View>
      <View style={{ height: 16, marginLeft: 0 }}>
        {months.map((m) => (
          <View key={m.left} style={{ position: "absolute", left: m.left, top: 0 }}>
            <Label muted size={font.xs} lines={1} selectable={false}>
              {m.label}
            </Label>
          </View>
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: CELL_GAP }}>
        {weeks.map((w) => (
          <Week key={w.days[0]} days={w.days} counts={w.counts} levels={activity.levels} today={today} size={size} selected={w.days.includes(selected) ? selected : null} onSelect={onSelect} />
        ))}
      </View>
    </View>
  );
  return (
    <View style={{ gap: space[1] }}>
      <View style={{ flexDirection: "row", gap: space[1] }}>
        <View style={{ paddingTop: 16, gap: CELL_GAP }}>
          {[0, 1, 2, 3, 4, 5, 6].map((d) => (
            <View key={d} style={{ height: size }}>
              {/* The label is taller than a cell: give it its own line box, centered on the cell, or its text is cut off. */}
              {d % 2 === 0 && d < 6 ? (
                <View style={{ height: WEEKDAY_LINE, marginTop: (size - WEEKDAY_LINE) / 2, flexShrink: 0 }}>
                  <Label muted size={font.xs} lines={1} selectable={false}>
                    {weekday(d)}
                  </Label>
                </View>
              ) : null}
            </View>
          ))}
        </View>
        {compact ? (
          <ScrollView horizontal ref={scroller as never} showsHorizontalScrollIndicator={false} onContentSizeChange={() => scroller.current?.scrollToEnd?.({ animated: false })}>
            {grid}
          </ScrollView>
        ) : (
          <View style={{ flex: 1, minWidth: 0 }} onLayout={(e) => setGridWidth(e.nativeEvent.layout.width)}>
            {grid}
          </View>
        )}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 3 }}>
        <Label muted size={font.xs} selectable={false}>
          {t("Less")}
        </Label>
        {LEVEL_OPACITY.map((o, i) => (
          <View key={i} style={{ width: size, height: size, borderRadius: 2, overflow: "hidden", backgroundColor: colors.surface2 }}>
            {i > 0 && <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.accent, opacity: o }} />}
          </View>
        ))}
        <Label muted size={font.xs} selectable={false}>
          {t("More")}
        </Label>
      </View>
    </View>
  );
});

/**
 * The day summary card (§2.2): arrows step to the previous or next day with activity; the day's
 * numbers, its AI summary and its cards, the busiest first, each with a bar for its share of the
 * busiest card's agent time.
 */
function DayPanel({ projectId, day, today, activity, active, titleOf, onOpenTask, onSelect }: { projectId: string; day: string; today: string; activity: Activity; active: boolean; titleOf(id: string): string; onOpenTask(id: string): void; onSelect(day: string): void }) {
  const { colors } = useTheme();
  const stats = activity.days.find((d) => d.day === day);
  const version = stats ? `${stats.turns}:${stats.cards}:${stats.done.length}` : "0";
  const fast = useDayQuery(projectId, day, version, false, active && !!stats);
  const full = useDayQuery(projectId, day, version, true, active && !!stats);
  const detail = full.data ?? fast.data;
  const digest = useDigestQuery(projectId, day, active && !!stats);
  const refresh = useRpc(rpc.refreshDigest);
  const client = useQueryClient();
  const [failed, setFailed] = useState("");
  const [limit, setLimit] = useState(DAY_CARDS);
  // The day before the change: an earlier day slides in from the left, a later one from the right.
  const shown = useRef(day);
  const from = day < shown.current ? -DAY_SLIDE : DAY_SLIDE;
  useEffect(() => {
    shown.current = day;
  }, [day]);
  const view = digest.data;
  const running = !!view?.running;
  const entry = view?.entry;
  const prev = [...activity.days].reverse().find((d) => d.day < day)?.day;
  const next = activity.days.find((d) => d.day > day && d.day <= today)?.day;
  const go = (to: string | undefined) => {
    if (!to) return;
    setLimit(DAY_CARDS);
    onSelect(to);
  };
  const generate = async () => {
    setFailed("");
    try {
      await refresh({ projectId, tz: localZone(), day });
      await client.invalidateQueries({ queryKey: ["flowly", "digest", projectId, day] });
    } catch (e) {
      setFailed(message(e));
    }
  };
  const list = detail?.list ?? [];
  const done = list.filter((c) => c.done).length;
  const numbers = stats
    ? [
        tn(stats.turns, "{n} turn", "{n} turns"),
        tn(stats.cards, "{n} card", "{n} cards"),
        (detail ? done : stats.done.length) ? tn(detail ? done : stats.done.length, "{n} done", "{n} done") : "",
        detail?.agentMs ? t("agent {time}", { time: compactDuration(detail.agentMs) }) : "",
        detail?.tokens ? t("{n} tokens", { n: compactNumber(detail.tokens) }) : full.isFetching && !full.data ? "…" : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : t("No activity");
  return (
    <Panel>
      <View style={{ padding: space[3], gap: space[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
          <IconButton icon="ChevronLeft" label={t("Previous day")} disabled={!prev} onPress={() => go(prev)} />
          <Label bold size={font.md} selectable={false}>
            {day === today ? t("Today") : longDate(day)}
          </Label>
          <IconButton icon="ChevronRight" label={t("Next day")} disabled={!next} onPress={() => go(next)} />
          <View style={{ flex: 1 }} />
          {!!entry && (
            <Button quiet small icon="RefreshCw" disabled={running} label={t("Regenerate the summary")} onPress={() => void generate()}>
              {running ? t("Generating…") : t("Refresh")}
            </Button>
          )}
        </View>
        <Enter key={day} axis="x" distance={from} style={{ gap: space[2] }}>
          <Label muted size={font.sm} selectable={false}>
            {numbers}
          </Label>
          {!!stats &&
            (entry ? (
              <View style={{ flexDirection: "row", gap: space[1.5], alignItems: "flex-start" }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Label size={font.md}>{entry.headline}</Label>
                </View>
                <AiMark label={t("AI generated")} />
              </View>
            ) : running ? (
              <Empty>{t("Writing the summary…")}</Empty>
            ) : !view ? (
              <Empty>{digest.error ? message(digest.error) : t("Loading…")}</Empty>
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
                <Empty>{day === today ? t("Generate a summary of today so far.") : view.enabled ? t("No summary for this day yet.") : t("Daily digest is off in settings. Generate one here.")}</Empty>
                <Button small onPress={() => void generate()}>
                  {t("Generate summary")}
                </Button>
              </View>
            ))}
          {!!entry?.issues.length && (
            <View style={{ gap: space[1] }}>
              <Label muted size={font.xs} selectable={false}>
                {t("Issues")}
              </Label>
              {entry.issues.map((item, i) => (
                <DigestLine key={i} item={item} title={item.taskId ? titleOf(item.taskId) : ""} onOpenTask={onOpenTask} />
              ))}
            </View>
          )}
          {!!entry && (
            <Label muted size={font.xs} selectable={false}>
              {t("Updated {time}", { time: relativeTime(entry.at) })} · {modelLabel(entry.model)}
            </Label>
          )}
          {!!(failed || (view?.error && !running && !entry)) && <Empty>{failed || t("Last attempt failed: {message}", { message: view?.error?.message ?? "" })}</Empty>}
          {!!stats && list.length > 0 && (
            <View style={{ marginHorizontal: -space[3], borderTopWidth: 1, borderColor: colors.border }}>
              {list.slice(0, limit).map((c, i) => (
                <DayCardRow key={c.taskId} first={i === 0} card={c} share={complexityShare(c, list)} title={titleOf(c.taskId)} onOpenTask={onOpenTask} />
              ))}
              {list.length > limit && (
                <View style={{ paddingHorizontal: space[3] }}>
                  <ShowMore count={list.length - limit} onPress={() => setLimit((n) => n + DAY_CARDS)} />
                </View>
              )}
            </View>
          )}
          {!!stats && !detail && (fast.error ? <Empty>{message(fast.error)}</Empty> : null)}
        </Enter>
      </View>
    </Panel>
  );
}

/** Cards shown at first in the day summary card, and added by each Show more. */
const DAY_CARDS = 8;
/** How far a day's content slides in when the day changes. */
const DAY_SLIDE = 16;

/** A card in the day summary: done or not, its title, that day's turns, time and tokens, and a bar for its share of the day's busiest card. */
const DayCardRow = memo(function DayCardRow({ first, card, share, title, onOpenTask }: { first: boolean; card: DayCard; share: number; title: string; onOpenTask(id: string): void }) {
  const { colors } = useTheme();
  const note = [tn(card.turns, "{n} turn", "{n} turns"), card.agentMs ? compactDuration(card.agentMs) : "", card.tokens ? compactNumber(card.tokens) : ""].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}: ${note}`}
      onPress={() => onOpenTask(card.taskId)}
      style={(state) => ({
        ...noFocusRing,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: space[2],
        paddingHorizontal: space[3],
        paddingVertical: space[2],
        borderTopWidth: first ? 0 : 1,
        borderColor: colors.border,
        backgroundColor: (state as { hovered?: boolean }).hovered || state.pressed ? colors.surface2 : "transparent",
      })}
    >
      <View style={{ height: 18, justifyContent: "center" }}>
        <Icon name={card.done ? "CircleCheck" : "Circle"} size={14} color={card.done ? colors.accent : colors.foregroundMuted} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: space[1] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Label size={font.md} lines={1} selectable={false}>
              {title}
            </Label>
          </View>
          <Label muted size={font.sm} lines={1} selectable={false}>
            {note}
          </Label>
        </View>
        <View style={{ height: 3, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" }}>
          <View style={{ width: `${Math.max(2, Math.round(share * 100))}%`, height: 3, borderRadius: 2, backgroundColor: colors.accent, opacity: LEVEL_OPACITY[complexityLevel(share)] }} />
        </View>
      </View>
    </Pressable>
  );
});

// ---- Skills (§2.3) --------------------------------------------------------------------

const isDraft = (f: Finding) => f.target === "skill" && !!f.skill;
const draftRank = (f: Finding) => (f.skill?.updates ? 0 : 1);
const confidenceOrder = { high: 0, medium: 1, low: 2 } as const;

/** Skill drafts from the cards and the skills Flowly added to the project (§2.3). */
function Skills({ projectId, view, error, titleOf, onOpenTask, onOpenSettings }: { projectId: string; view: WorkflowView | undefined; error: unknown; titleOf(id: string): string; onOpenTask(id: string): void; onOpenSettings(): void }) {
  const run = useRpc(rpc.runWorkflowInsights);
  const setStatus = useRpc(rpc.setWorkflowFinding);
  const install = useRpc(rpc.installSkill);
  const client = useQueryClient();
  const toast = useToast();
  const [failed, setFailed] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["flowly", "workflow-insights", projectId] });
  const runNow = async () => {
    setFailed("");
    try {
      await run({ projectId });
      await refresh();
    } catch (e) {
      setFailed(message(e));
    }
  };
  const dismiss = async (f: Finding) => {
    if (!view) return;
    setFailed("");
    try {
      await setStatus({ projectId, findingId: f.id, status: "dismissed", expectedRevision: view.revision });
    } catch (e) {
      setFailed(message(e));
    }
    await refresh();
  };
  const add = async (f: Finding) => {
    if (!view || !f.skill) return;
    setFailed("");
    setBusyId(f.id);
    try {
      const result = await install({ projectId, findingId: f.id, expectedRevision: view.revision });
      const name = f.skill.name;
      toast.show(t("Added to the project. Commit .agents/skills/{name} and .claude/skills/{name} so worktrees and teammates get it.", { name }), { variant: "success" });
      if (result.notice) toast.show(result.notice, { variant: "info" });
    } catch (e) {
      setFailed(message(e));
    } finally {
      setBusyId(null);
    }
    await refresh();
  };
  const busy = !!view && (view.running || view.backfilling);
  const last = view?.lastRun;
  const trailing = view ? (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
      {!!last && (
        <Label muted size={font.xs} lines={1} selectable={false}>
          {[relativeTime(last.at), last.model ? modelLabel(last.model) : ""].filter(Boolean).join(" · ")}
        </Label>
      )}
      <Button quiet small icon="Play" disabled={busy} label={t("Analyze the last days now")} onPress={() => void runNow()}>
        {view.running ? t("Analyzing…") : t("Run now")}
      </Button>
      <IconButton icon="Settings" label={t("Skills settings")} onPress={onOpenSettings} />
    </View>
  ) : null;
  const drafts = (view?.findings || [])
    .filter((f) => f.status === "open" && isDraft(f))
    .sort((a, b) => draftRank(a) - draftRank(b) || confidenceOrder[a.confidence] - confidenceOrder[b.confidence] || b.createdAt.localeCompare(a.createdAt));
  const installed = view?.installed || [];
  const updating = new Set(drafts.filter((f) => f.skill?.updates).map((f) => f.skill!.name));
  return (
    <Section title={t("Skills")} ai trailing={trailing}>
      {!view ? (
        <Empty>{error ? message(error) : t("Loading…")}</Empty>
      ) : (
        <View style={{ gap: space[2] }}>
          {!view.enabled && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
              <View style={{ flex: 1, minWidth: 200 }}>
                <Empty>{t("Skills are off.")}</Empty>
              </View>
              <Button small onPress={onOpenSettings}>
                {t("Turn on")}
              </Button>
            </View>
          )}
          {view.enabled && !view.projectEnabled && <Empty>{t("This project is left out of skills in its settings. Run now still works.")}</Empty>}
          {view.backfilling && <Empty>{t("Reading recent sessions…")}</Empty>}
          {!!runReason(view) && <Empty>{runReason(view)}</Empty>}
          {!!failed && <Empty>{failed}</Empty>}
          {drafts.length + installed.length > 0 ? (
            <Panel>
              {drafts.map((f, i) => (
                <SkillRow key={f.id} first={i === 0} draft={f} current={f.skill?.updates ? view.current[f.skill.name] : undefined} busy={busyId === f.id} titleOf={titleOf} onOpenTask={onOpenTask} onAdd={() => void add(f)} onDismiss={() => void dismiss(f)} />
              ))}
              {installed
                .filter((s) => !updating.has(s.name))
                .map((s, i) => (
                  <SkillRow key={s.name} first={!drafts.length && i === 0} installed={s} titleOf={titleOf} onOpenTask={onOpenTask} />
                ))}
            </Panel>
          ) : !last ? (
            <Empty>{view.nextRunAt && view.enabled ? t("Not analyzed yet. Next analysis {time}.", { time: nextLabel(view.nextRunAt) }) : t("Not analyzed yet.")}</Empty>
          ) : last.status === "ok" && !runReason(view) ? (
            <Empty>{t("Nothing worth a skill this time.")}</Empty>
          ) : null}
          {!!last && !!usageLine(view) && (
            <Label muted size={font.xs} selectable={false}>
              {[usageLine(view), view.nextRunAt && !view.running ? t("Next run {time}", { time: nextLabel(view.nextRunAt) }) : ""].filter(Boolean).join(" · ")}
            </Label>
          )}
        </View>
      )}
    </Section>
  );
}

/** A skill draft (new or an update) or a skill Flowly added; what it would write opens below. */
function SkillRow({
  first,
  draft,
  current,
  installed,
  busy,
  titleOf,
  onOpenTask,
  onAdd,
  onDismiss,
}: {
  first: boolean;
  draft?: Finding;
  current?: string;
  installed?: { name: string; path: string; content: string };
  busy?: boolean;
  titleOf(id: string): string;
  onOpenTask(id: string): void;
  onAdd?(): void;
  onDismiss?(): void;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const skill = draft?.skill;
  const name = skill?.name ?? installed?.name ?? "";
  const update = !!skill?.updates;
  const preview = skill ? skillFile(skill) : (installed?.content ?? "");
  const diff = update && current !== undefined ? lineDiff(current, skill!.body.trim()) : null;
  const chip = (label: string) => (
    <View style={{ paddingHorizontal: space[2], height: touch ? 22 : 20, justifyContent: "center", borderRadius: radius.full, backgroundColor: colors.surface2 }}>
      <Label size={font.xs} lines={1} selectable={false}>
        {label}
      </Label>
    </View>
  );
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderColor: colors.border }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={draft ? `${name}: ${draft.title}` : name}
        onPress={() => setOpen((o) => !o)}
        style={(state) => ({
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "flex-start",
          gap: space[2],
          paddingVertical: space[2],
          paddingHorizontal: space[3],
          minHeight: touch ? 44 : 36,
          backgroundColor: (state as { hovered?: boolean }).hovered ? colors.surface2 : "transparent",
        })}
      >
        <View style={{ height: 22, justifyContent: "center" }}>
          <TurnChevron open={open} size={14} color={colors.foregroundMuted} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Label mono medium size={font.md} lines={1} selectable={false}>
            {name}
          </Label>
          {!!draft && (
            <Label muted size={font.sm} lines={open ? undefined : 1} selectable={false}>
              {draft.title}
            </Label>
          )}
        </View>
        {draft ? (
          <View style={{ alignItems: "flex-end", gap: 2 }}>
            {chip(update ? t("Update") : t("New"))}
            <Label muted size={font.xs} selectable={false}>
              {update ? t("In the project") : tn(draft.cards.length, "{n} card", "{n} cards")}
            </Label>
          </View>
        ) : (
          <Label muted size={font.xs} selectable={false}>
            {t("In the project")}
          </Label>
        )}
      </Pressable>
      <Collapse open={open} id="skill" style={{ paddingLeft: space[6] + space[2], paddingRight: space[3], paddingBottom: space[3], gap: space[2] }}>
        {!!(update ? skill?.change : draft?.evidence) && (
          <Label muted size={font.sm}>
            {update ? skill!.change! : draft!.evidence}
          </Label>
        )}
        {!!draft && draft.cards.length > 0 && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1] }}>
            {draft.cards.slice(0, 6).map((id) => (
              <TaskChip key={id} title={titleOf(id)} onPress={() => onOpenTask(id)} />
            ))}
            {draft.cards.length > 6 && (
              <Label muted size={font.sm} selectable={false}>
                +{draft.cards.length - 6}
              </Label>
            )}
          </View>
        )}
        <ScrollView style={{ maxHeight: 360, borderRadius: radius.md, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: space[2] }} nestedScrollEnabled>
          {diff ? (
            diff
              .filter((l) => l.kind !== "same")
              .map((l, i) => (
                <Label key={i} mono size={font.sm} muted={l.kind === "remove"}>
                  {`${l.kind === "add" ? "+" : "-"} ${l.text}`}
                </Label>
              ))
          ) : (
            <Label mono size={font.sm}>
              {preview}
            </Label>
          )}
        </ScrollView>
        {!!installed && (
          <Label muted size={font.xs} selectable={false}>
            {installed.path}
          </Label>
        )}
        {!!draft && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
            <Button small primary icon={update ? "RefreshCw" : "Plus"} disabled={busy} onPress={() => onAdd?.()}>
              {update ? t("Update in project") : t("Add to project")}
            </Button>
            <Button small quiet disabled={busy} onPress={() => onDismiss?.()}>
              {update ? t("Keep as is") : t("Dismiss")}
            </Button>
            {!update && (
              <Label muted size={font.xs} selectable={false}>
                {t("Writes .agents/skills/{name}/ and links it in .claude/skills/", { name })}
              </Label>
            )}
          </View>
        )}
      </Collapse>
    </View>
  );
}

// ---- Other suggestions (§2.4) and the workflow (§2.5) ---------------------------------

/** The two folded rows share one title column, so their summaries start at the same left edge. */
const FOLDED_TITLE_WIDTH = 150;

/** Workflow insights other than skills, folded (§2.4): scripts, worktree setup, repo tools, AGENTS.md. */
function OtherSuggestions({ projectId, view, titleOf, onOpenTask, onCreate }: { projectId: string; view: WorkflowView | undefined; titleOf(id: string): string; onOpenTask(id: string): void; onCreate(finding: Finding): void }) {
  const setStatus = useRpc(rpc.setWorkflowFinding);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [failed, setFailed] = useState("");
  if (!view) return null;
  const findings = view.findings
    .filter((f) => !isDraft(f) && f.target in targetLabels)
    .sort((a, b) => confidenceOrder[a.confidence] - confidenceOrder[b.confidence] || b.createdAt.localeCompare(a.createdAt));
  const active = findings.filter((f) => f.status !== "dismissed");
  const dismissed = findings.filter((f) => f.status === "dismissed");
  if (!findings.length) return null;
  const change = async (finding: Finding, status: "open" | "dismissed") => {
    setFailed("");
    try {
      await setStatus({ projectId, findingId: finding.id, status, expectedRevision: view.revision });
    } catch (e) {
      setFailed(message(e));
    }
    await client.invalidateQueries({ queryKey: ["flowly", "workflow-insights", projectId] });
  };
  const openCount = active.filter((f) => f.status === "open").length;
  return (
    <Disclosure title={t("Other suggestions")} flush titleMinWidth={FOLDED_TITLE_WIDTH} summary={tn(openCount, "Scripts, repo tools, AGENTS.md · {n} open", "Scripts, repo tools, AGENTS.md · {n} open")} open={open} onChange={setOpen}>
      <View style={{ gap: space[2], paddingTop: space[1] }}>
        {!!failed && <Empty>{failed}</Empty>}
        {active.length > 0 && (
          <Panel>
            {active.map((f, i) => (
              <FindingRow key={f.id} first={i === 0} finding={f} titleOf={titleOf} onOpenTask={onOpenTask} onCreate={() => onCreate(f)} onDismiss={() => void change(f, "dismissed")} />
            ))}
          </Panel>
        )}
        {dismissed.length > 0 && (
          <Disclosure title={t("Dismissed ({n})", { n: dismissed.length })} flush open={showDismissed} onChange={setShowDismissed}>
            <Panel>
              {dismissed.map((f, i) => (
                <FindingRow key={f.id} first={i === 0} finding={f} titleOf={titleOf} onOpenTask={onOpenTask} onRestore={() => void change(f, "open")} />
              ))}
            </Panel>
          </Disclosure>
        )}
      </View>
    </Disclosure>
  );
}

// ---- The closed loop (GUARDRAILS-SPEC §7.2) ------------------------------------------------

/**
 * The project's account at the top: deliveries in the last 14 days, the share that passed their first review and the
 * misfire share (hidden while nothing was failed by judgement), then this week's guardrail changes, each opening the
 * Guardrails page. Read once per opening; hidden when the daemon cannot answer.
 */
function GuardrailLedger({ projectId, active, onOpen }: { projectId: string; active: boolean; onOpen?(): void }) {
  const { colors } = useTheme();
  const read = useRpc(rpc.guardrailsInsights);
  const ledger = useQuery({
    queryKey: ["flowly", "insights-guardrails", projectId],
    queryFn: () => read({ projectId, tz: localZone() }),
    enabled: active,
    staleTime: 5 * 60_000,
    retry: false,
  }).data;
  if (!ledger || !ledger.deliveries) return null;
  const numbers = [
    tn(ledger.deliveries, "{n} delivery", "{n} deliveries"),
    ledger.reviewed ? t("{share} passed the first review", { share: percent(ledger.firstPass / ledger.reviewed) }) : "",
    ledger.judged ? t("{share} misfires", { share: percent(ledger.misfires / ledger.judged) }) : "",
  ].filter(Boolean);
  const c = ledger.changes;
  const changes = [
    c.learned ? tn(c.learned, "{n} guideline learned", "{n} guidelines learned") : "",
    c.widened ? tn(c.widened, "{n} widened", "{n} widened") : "",
    c.revived ? tn(c.revived, "{n} revived", "{n} revived") : "",
    c.retired ? tn(c.retired, "{n} retired", "{n} retired") : "",
    c.observing ? tn(c.observing, "{n} command observing", "{n} commands observing") : "",
  ].filter(Boolean);
  return (
    <Section title={t("Last 14 days")}>
      <Label size={font.md}>{numbers.join(" · ")}</Label>
      {!!changes.length && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: space[1.5], rowGap: space[1] }}>
          <Label muted size={font.sm} selectable={false}>{t("This week:")}</Label>
          {changes.map((text, i) => (
            <Pressable key={text} accessibilityRole={onOpen ? "link" : undefined} disabled={!onOpen} onPress={onOpen} style={noFocusRing}>
              <Label size={font.sm} color={onOpen ? colors.accent : undefined} muted={!onOpen} selectable={false}>
                {i < changes.length - 1 ? `${text} ·` : text}
              </Label>
            </Pressable>
          ))}
        </View>
      )}
    </Section>
  );
}

/** Rounds and tokens per model of the last 7 days, folded; the summary line gave way to the closed loop (GUARDRAILS-SPEC §7.2). */
function WorkflowNumbers({ projectId, flow, active }: { projectId: string; flow: WorkflowStats; active: boolean }) {
  const [open, setOpen] = useState(false);
  const tokens = useTokensQuery(projectId, active && open);
  return (
    <Disclosure title={t("Workflow")} flush titleMinWidth={FOLDED_TITLE_WIDTH} open={open} onChange={setOpen}>
      {flow.models.length > 0 ? (
        <View style={{ paddingTop: space[1] }}>
          <Panel>
            {flow.models.map((m, i) => (
              <StatRow
                key={m.model || "other"}
                first={i === 0}
                label={m.model ? modelLabel(m.model) : t("Other models")}
                note={[tn(m.rounds ?? 0, "{n} round", "{n} rounds", { n: fmt(m.rounds) }), modelTokens(tokens.data, m.model)].filter(Boolean).join(" · ")}
                value={tn(m.finished, "{n} card", "{n} cards")}
              />
            ))}
          </Panel>
        </View>
      ) : (
        <Empty>{t("No finished cards to compare.")}</Empty>
      )}
    </Disclosure>
  );
}

function modelTokens(tokens: CardTokens | undefined, model: string) {
  const n = tokens?.models.find((x) => x.model === model)?.perCard;
  return n == null ? "" : t("{n} tokens", { n: compactNumber(n) });
}

function Section({ title, detail, ai, trailing, children }: { title: string; detail?: string; ai?: boolean; trailing?: ReactNode; children: ReactNode }) {
  return (
    <Enter distance={4}>
      <View style={{ gap: space[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], minHeight: 28 }}>
          <View style={{ flexShrink: 0 }}>
            <Label bold size={font.md} lines={1} selectable={false}>
              {title}
            </Label>
          </View>
          {ai && <AiMark label={t("AI generated")} />}
          {!!detail && (
            <View style={{ flexShrink: 1 }}>
              <Label muted size={font.sm} lines={2} selectable={false}>
                {detail}
              </Label>
            </View>
          )}
          <View style={{ flex: 1 }} />
          {trailing}
        </View>
        {children}
      </View>
    </Enter>
  );
}

function Panel({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, overflow: "hidden" }}>{children}</View>;
}

/** A Panel row: label, a muted note, the value on the right. */
function StatRow({ first, label, value, note, selected, onPress, a11y }: { first: boolean; label: string; value: string; note?: string; selected?: boolean; onPress?(): void; a11y?: string }) {
  const { colors } = useTheme();
  const body = (
    <>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.md} lines={1} selectable={false}>
          {label}
        </Label>
      </View>
      {!!note && (
        <View style={{ flexShrink: 1 }}>
          <Label muted size={font.sm} lines={1} selectable={false}>
            {note}
          </Label>
        </View>
      )}
      <View style={{ minWidth: 48, alignItems: "flex-end" }}>
        <Label medium size={font.md} selectable={false}>
          {value}
        </Label>
      </View>
    </>
  );
  const style = { flexDirection: "row" as const, alignItems: "center" as const, gap: space[3], paddingHorizontal: space[3], minHeight: touch ? 44 : 36, borderTopWidth: first ? 0 : 1, borderColor: colors.border };
  if (!onPress)
    return (
      <View accessibilityLabel={a11y ?? `${label}: ${value}${note ? `, ${note}` : ""}`} style={style}>
        {body}
      </View>
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y ?? `${label}: ${value}`}
      onPress={onPress}
      style={(state) => ({ ...noFocusRing, ...style, backgroundColor: selected || (state as { hovered?: boolean }).hovered || state.pressed ? colors.surface2 : "transparent" })}
    >
      {body}
    </Pressable>
  );
}

function Empty({ children }: { children: string }) {
  return (
    <Label muted size={font.sm}>
      {children}
    </Label>
  );
}

/** Medians: whole numbers as they are, others to one decimal. */
const fmt = (n: number | null) => (n === null ? "—" : Number.isInteger(n) || n >= 10 ? String(Math.round(n)) : n.toFixed(1));


// ---- Shared rows ----------------------------------------------------------------------

function TaskChip({ title, onPress }: { title: string; onPress(): void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Open {title}", { title })}
      onPress={onPress}
      hitSlop={touch ? 6 : 0}
      style={(state) => {
        const { hovered, pressed } = state as typeof state & { hovered?: boolean };
        return {
          ...noFocusRing,
          maxWidth: 220,
          paddingHorizontal: space[2],
          height: touch ? 28 : 22,
          justifyContent: "center",
          borderRadius: radius.full,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: hovered || pressed ? colors.surface2 : colors.surface0,
        };
      }}
    >
      <Label size={font.sm} lines={1} selectable={false}>
        {title}
      </Label>
    </Pressable>
  );
}

function DigestLine({ item, title, onOpenTask }: { item: DigestItem; title: string; onOpenTask(id: string): void }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: space[2], alignItems: "flex-start" }}>
      <Label muted size={font.md} selectable={false}>
        •
      </Label>
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space[1.5] }}>
        <Label size={font.md}>{item.text}</Label>
        {!!item.taskId && (
          <Pressable accessibilityRole="link" accessibilityLabel={t("Open {title}", { title })} onPress={() => onOpenTask(item.taskId!)} hitSlop={touch ? 6 : 0} style={noFocusRing}>
            <Label size={font.sm} color={colors.accent} lines={1} selectable={false}>
              {title.length > 40 ? title.slice(0, 39) + "…" : title}
            </Label>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** Auto review findings are gone (GUARDRAILS-SPEC §7.2); any left over are not listed. */
const targetLabels: Partial<Record<FindingTarget, string>> = {
  paseo_script: msg("paseo.json script"),
  worktree_setup: msg("Worktree setup"),
  repo_tool: msg("Repo tool"),
  agents_md: msg("AGENTS.md"),
  skill: msg("Skill"),
};
const confidenceLabels: Record<Finding["confidence"], string> = { high: msg("High confidence"), medium: msg("Medium confidence"), low: msg("Low confidence") };

/** The daemon's reasons are English identities; known ones read in the user's language. */
function runReason(view: WorkflowView): string {
  const run = view.lastRun;
  if (!run) return "";
  if (run.status === "error") return t("Last run failed: {message}", { message: run.reason || "" });
  if (run.reason === "Not enough new activity.") return t("Skipped: not enough new activity since the last run.");
  if (run.reason === "No commands collected yet.") return t("No commands collected yet. They are recorded as agents work on cards.");
  if (run.reason === "No recent activity.") return t("No card was worked on in the last 30 days.");
  if (run.reason === "No suggestions this time.") return "";
  return "";
}

function usageLine(view: WorkflowView): string {
  const u = view.lastRun?.usage;
  if (!u) return "";
  const parts = [t("{n} in", { n: compactNumber(usageIn(u)) }), t("{n} out", { n: compactNumber(u.outputTokens ?? 0) })];
  if (typeof u.totalCostUsd === "number") parts.push(`$${u.totalCostUsd.toFixed(2)}`);
  return parts.join(" · ");
}

function nextLabel(iso: string) {
  const at = new Date(iso);
  if (at.getTime() - Date.now() < 15 * 60_000) return t("soon");
  return at.toLocaleString(formatLocale(), { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** One suggestion as a row; its evidence, cards, proposal and actions open below it. */
function FindingRow({
  first,
  finding,
  titleOf,
  onOpenTask,
  onCreate,
  onDismiss,
  onRestore,
}: {
  first: boolean;
  finding: Finding;
  titleOf(id: string): string;
  onOpenTask(id: string): void;
  onCreate?(): void;
  onDismiss?(): void;
  onRestore?(): void;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [proposal, setProposal] = useState(false);
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderColor: colors.border, opacity: finding.status === "dismissed" ? 0.75 : 1 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={finding.title}
        onPress={() => setOpen((o) => !o)}
        style={(state) => {
          const { hovered } = state as typeof state & { hovered?: boolean };
          return {
            ...noFocusRing,
            flexDirection: "row",
            alignItems: "center",
            gap: space[2],
            paddingVertical: space[2],
            paddingHorizontal: space[3],
            minHeight: touch ? 44 : 36,
            backgroundColor: hovered ? colors.surface2 : "transparent",
          };
        }}
      >
        <TurnChevron open={open} size={14} color={colors.foregroundMuted} />
        <View style={{ paddingHorizontal: space[2], height: touch ? 22 : 20, justifyContent: "center", borderRadius: radius.full, backgroundColor: colors.surface2 }}>
          <Label size={font.xs} lines={1} selectable={false}>
            {t(targetLabels[finding.target] ?? "")}
          </Label>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label medium size={font.md} lines={open ? undefined : 1} selectable={false}>
            {finding.title}
          </Label>
        </View>
        {finding.status === "accepted" ? (
          <Label muted size={font.xs} selectable={false}>
            {t("Card created")}
          </Label>
        ) : (
          <Label muted size={font.xs} selectable={false}>
            {t(confidenceLabels[finding.confidence])}
          </Label>
        )}
      </Pressable>
      <Collapse open={open} id="finding" style={{ paddingLeft: space[6] + space[2], paddingRight: space[3], paddingBottom: space[3], gap: space[2] }}>
        {!!finding.benefit && <Label size={font.md}>{finding.benefit}</Label>}
        {!!finding.evidence && (
          <Label muted size={font.sm}>
            {finding.evidence}
          </Label>
        )}
        {finding.cards.length > 0 && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1] }}>
            {finding.cards.slice(0, 6).map((id) => (
              <TaskChip key={id} title={titleOf(id)} onPress={() => onOpenTask(id)} />
            ))}
            {finding.cards.length > 6 && (
              <Label muted size={font.sm} selectable={false}>
                +{finding.cards.length - 6}
              </Label>
            )}
          </View>
        )}
        <Disclosure title={t("Proposal")} open={proposal} onChange={setProposal}>
          <View style={{ padding: space[2], borderRadius: radius.md, backgroundColor: colors.surface0 }}>
            <Label mono size={font.sm}>
              {finding.proposal}
            </Label>
          </View>
        </Disclosure>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
          {finding.status === "open" && onCreate && (
            <Button small primary icon="Plus" onPress={onCreate}>
              {t("Create card")}
            </Button>
          )}
          {finding.status === "open" && onDismiss && (
            <Button small quiet onPress={onDismiss}>
              {t("Dismiss")}
            </Button>
          )}
          {finding.status === "dismissed" && onRestore && (
            <Button small quiet icon="RotateCcw" onPress={onRestore}>
              {t("Restore")}
            </Button>
          )}
          {finding.status === "accepted" && (
            <Button
              small
              quiet
              icon="ArrowUpRight"
              disabled={!finding.acceptedTaskId}
              label={finding.acceptedTaskId ? t("Open {title}", { title: titleOf(finding.acceptedTaskId) }) : undefined}
              onPress={() => finding.acceptedTaskId && onOpenTask(finding.acceptedTaskId)}
            >
              {t("Card created")}
            </Button>
          )}
        </View>
      </Collapse>
    </View>
  );
}
