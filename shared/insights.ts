import { z } from "zod";
import { isWorkStatus, priorities, statuses, type Status, type Task } from "./model";
import { TOKEN_SLOT_MS, addUsage, tokenUsageSchema, totalTokens, zeroUsage, type TokenUsage } from "./usage";

/** Project insights: daily stats, waiting on you, suggestions (PROJECT-INSIGHTS-SPEC). */

/** One line of `flow/<projectId>.jsonl`: a board event without its note (§2). */
export const flowEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  taskId: z.string(),
  actor: z.enum(["human", "agent", "system"]),
  action: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  reportKind: z.string().optional(),
  outcome: z.string().optional(),
  rule: z.string().optional(),
  agentId: z.string().optional(),
  /** agent.turn_ended: `provider/model` at the end of the turn (WORKFLOW-INSIGHTS-SPEC §12.4). */
  model: z.string().optional(),
  /** agent.turn_ended: the next move the user's message matched (index), -1 for none. */
  pick: z.number().int().min(-1).optional(),
  /** next_moves_suggested: how many moves (0 is an explicit "none"), and whether one of them is "Move to Done" (the moves themselves are not kept). */
  offered: z.number().int().min(0).optional(),
  offersDone: z.boolean().optional(),
  /** agent.turn_ended: started by a real user message (INSIGHTS-REDESIGN-SPEC §7.1). */
  byUser: z.boolean().optional(),
  /** agent.permission_requested: the tool's name (§7.2). */
  tool: z.string().max(80).optional(),
  /** review_finished: each check's result (AUTO-REVIEW-SPEC §8.3). */
  results: z.array(z.object({ id: z.string(), state: z.string(), kind: z.string().optional(), gating: z.literal(false).optional() })).optional(),
  /** guardrail_learned / guardrail_retired: what changed (GUARDRAILS-SPEC §7.6). */
  guardrail: z.object({ change: z.string(), kind: z.string(), id: z.string() }).optional(),
});
export type FlowEntry = z.infer<typeof flowEntrySchema>;

export function flowEntry(event: FlowEntry & { note?: string; moves?: readonly { moveTo?: string }[] }): FlowEntry {
  const entry: FlowEntry = { id: event.id, at: event.at, taskId: event.taskId, actor: event.actor, action: event.action };
  for (const key of ["from", "to", "reportKind", "outcome", "rule", "agentId", "model", "tool"] as const) if (event[key]) entry[key] = event[key];
  if (typeof event.pick === "number") entry.pick = event.pick;
  if (typeof event.byUser === "boolean") entry.byUser = event.byUser;
  if (event.results?.length) entry.results = event.results.map((r) => ({ id: r.id, state: r.state, ...(r.kind ? { kind: r.kind } : {}), ...(r.gating === false ? { gating: false as const } : {}) }));
  if (event.guardrail) entry.guardrail = { change: event.guardrail.change, kind: event.guardrail.kind, id: event.guardrail.id };
  // An empty list is the session's explicit "no next steps" and stays distinguishable: offered 0.
  const offered = event.moves ? event.moves.length : event.offered;
  if (offered !== undefined) entry.offered = offered;
  if (event.moves ? event.moves.some((m) => m.moveTo === "done") : event.offersDone) entry.offersDone = true;
  return entry;
}

export const HOUR = 3_600_000;
export const DAY_MS = 24 * HOUR;
export const TREND_DAYS = 7;
export const MAX_INSIGHTS = 5;
export const thresholds = {
  reviewCount: 3,
  reviewWaitMs: 24 * HOUR,
  staleMs: 48 * HOUR,
  /** R3: review rounds on an unfinished card (INSIGHTS-REDESIGN-SPEC §3.7). */
  reworkCount: 3,
  inversionMs: 3 * DAY_MS,
  wipMin: 5,
  wipFactor: 2,
  failedTurns: 2,
  failedWindowMs: 24 * HOUR,
  nextUp: 3,
} as const;

// ---- Days in a time zone -------------------------------------------------

/** The IANA zone when the runtime knows it, else undefined (runtime local time). */
export function validZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, tz: string | undefined) {
  const key = tz || "";
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(key, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** `YYYY-MM-DD` of an instant in the zone. */
export function dayKey(ms: number, tz: string | undefined): string {
  const p = parts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export const isDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`));

/** Calendar arithmetic on day keys. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The zone's offset (ms ahead of UTC) at an instant. */
function offset(ms: number, tz: string | undefined) {
  const p = parts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** The first instant of the day in the zone (handles DST shifts). */
export function dayStart(day: string, tz: string | undefined): number {
  const wall = Date.parse(`${day}T00:00:00Z`);
  let guess = wall - offset(wall, tz);
  guess = wall - offset(guess, tz);
  return guess;
}

// ---- Replay ---------------------------------------------------------------

export type Interval = { status: Status; start: number; end: number };
type TaskLike = Pick<Task, "id" | "title" | "status" | "priority" | "createdAt" | "archivedAt" | "workspaceId"> & Partial<Pick<Task, "type" | "tags">>;

/** Retired In progress reads as Development; unknown values are dropped. */
function asStatus(value: string | undefined): Status | null {
  if (value === "in_progress") return "development";
  return (statuses as readonly string[]).includes(value || "") ? (value as Status) : null;
}
const ms = (iso: string) => Date.parse(iso);

export type TaskHistory = {
  task: TaskLike;
  intervals: Interval[];
  /** Its `created` event is gone: the start of its history was cut (§2). */
  incomplete: boolean;
  entries: FlowEntry[];
};

/** Each card's lane intervals, rebuilt from its status changes. */
export function replay(tasks: readonly TaskLike[], entries: readonly FlowEntry[], now: number): TaskHistory[] {
  const byTask = new Map<string, FlowEntry[]>();
  for (const e of entries) {
    const list = byTask.get(e.taskId);
    if (list) list.push(e);
    else byTask.set(e.taskId, [e]);
  }
  return tasks.map((task) => {
    const mine = (byTask.get(task.id) || []).slice().sort((a, b) => a.at.localeCompare(b.at));
    const changes = mine.filter((e) => e.action === "status_changed" && asStatus(e.to));
    const created = ms(task.createdAt);
    let status = asStatus(changes[0]?.from) || (changes.length ? asStatus(changes[0].to)! : task.status);
    let start = created;
    const intervals: Interval[] = [];
    for (const c of changes) {
      const at = Math.max(ms(c.at), start);
      if (at > start) intervals.push({ status, start, end: at });
      status = asStatus(c.to)!;
      start = at;
    }
    const end = task.archivedAt ? Math.min(now, Math.max(start, ms(task.archivedAt))) : now;
    intervals.push({ status: changes.length ? status : task.status, start, end: Math.max(start, end) });
    return { task, intervals, incomplete: !mine.some((e) => e.action === "created"), entries: mine };
  });
}

/** Session run intervals: turn_started → turn_ended per session; an unfinished turn counts only while it is running. */
export function sessionIntervals(entries: readonly FlowEntry[], now: number, running: ReadonlySet<string>) {
  const open = new Map<string, number>();
  const out: { agentId: string; start: number; end: number }[] = [];
  const sorted = entries.filter((e) => e.agentId && (e.action === "agent.turn_started" || e.action === "agent.turn_ended"));
  sorted.sort((a, b) => a.at.localeCompare(b.at));
  for (const e of sorted) {
    const id = e.agentId!;
    if (e.action === "agent.turn_started") {
      if (!open.has(id)) open.set(id, ms(e.at));
    } else {
      const start = open.get(id);
      if (start !== undefined) out.push({ agentId: id, start, end: Math.max(start, ms(e.at)) });
      open.delete(id);
    }
  }
  for (const [id, start] of open) if (running.has(id)) out.push({ agentId: id, start, end: Math.max(start, now) });
  return out;
}

// ---- Output ---------------------------------------------------------------

const count = z.number().int().nonnegative();
export const dayStatsSchema = z.object({
  created: count,
  done: count,
  cancelled: count,
  reopened: count,
  rework: count,
  turns: z.object({ completed: count, failed: count, canceled: count }),
  agentMs: z.number().nonnegative(),
  peakSessions: count,
  questions: count,
  permissions: count,
  ideas: count,
  ideasAccepted: count,
  lanes: z.record(z.string(), count),
  commits: count,
  added: count,
  deleted: count,
});
export type DayStats = z.infer<typeof dayStatsSchema>;
export const averageSchema = z.object({
  created: z.number(),
  done: z.number(),
  rework: z.number(),
  turns: z.number(),
  agentMs: z.number(),
  commits: z.number(),
});
export const insightSchema = z.object({
  rule: z.string(),
  severity: z.enum(["warning", "info"]),
  text: z.string(),
  /** Values behind `text`, so the client can show it in the user's language. */
  args: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  taskIds: z.array(z.string()),
});
export type Insight = z.infer<typeof insightSchema>;
const waitingSchema = z.object({ taskId: z.string(), since: z.string() });
export const projectInsightsSchema = z.object({
  day: z.string(),
  today: z.string(),
  stats: dayStatsSchema,
  average: averageSchema,
  trend: z.array(z.object({ day: z.string(), created: count, done: count, work: count })),
  /** Median time in each lane for stays that ended in the last 7 days (ms). */
  dwell: z.record(z.string(), z.number()),
  review: z.array(waitingSchema),
  blocked: z.array(waitingSchema),
  insights: z.array(insightSchema),
  git: z.object({
    repos: z.number().int(),
    error: z.string().nullable(),
    topFiles: z.array(z.object({ path: z.string(), changes: count, commits: count })),
  }),
  /** Cards whose early history was cut before the flow log existed. */
  incomplete: count,
});
export type ProjectInsights = z.infer<typeof projectInsightsSchema>;

export type Commit = { hash: string; at: string; subject: string; repo: string; files: { path: string; added: number; deleted: number }[] };

// ---- Analysis --------------------------------------------------------------

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const median = (values: number[]) => {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const priorityRank = (p: Task["priority"]) => priorities.indexOf(p);
export function waited(msValue: number) {
  const h = msValue / HOUR;
  if (h < 1) return `${Math.max(1, Math.round(msValue / 60_000))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
const quote = (title: string) => `“${title.length > 60 ? title.slice(0, 59) + "…" : title}”`;
const isReworkChange = (e: FlowEntry) =>
  e.action === "status_changed" && e.from === "in_review" && (isWorkStatus(e.to || "") || e.to === "in_progress");

export type AnalyzeInput = {
  tasks: readonly TaskLike[];
  entries: readonly FlowEntry[];
  now: number;
  tz: string | undefined;
  day?: string;
  /** Agent ids currently running, and the workspaces they run in. */
  runningAgents: ReadonlySet<string>;
  runningWorkspaces: ReadonlySet<string>;
  commits: readonly Commit[];
  repos: number;
  gitError: string | null;
};

/**
 * Drops status changes that rule A1r undid: a message on a card in review
 * resumed it (A1), the turn reported nothing, and it went back (A1r). The pair
 * is not rework and does not restart the time waiting for review.
 */
export function withoutRevertedResumes(entries: readonly FlowEntry[]): FlowEntry[] {
  const drop = new Set<string>();
  const lastChange = new Map<string, FlowEntry>();
  const sorted = entries.filter((e) => e.action === "status_changed").sort((a, b) => a.at.localeCompare(b.at));
  for (const e of sorted) {
    const previous = lastChange.get(e.taskId);
    if (e.rule === "A1r" && previous?.rule === "A1" && previous.from === e.to) drop.add(previous.id).add(e.id);
    lastChange.set(e.taskId, e);
  }
  return drop.size ? entries.filter((e) => !drop.has(e.id)) : [...entries];
}

/** The replay and per-day stats both the page view and the work statistics read. */
export type Prepared = ReturnType<typeof prepare>;
export function prepare(raw: AnalyzeInput) {
  const input = { ...raw, entries: withoutRevertedResumes(raw.entries) };
  const { now, tz } = input;
  const today = dayKey(now, tz);
  const day = input.day && isDay(input.day) && input.day <= today ? input.day : today;
  const histories = replay(input.tasks, input.entries, now);
  const sessions = sessionIntervals(input.entries, now, input.runningAgents);
  const commitDays = new Map<string, Commit[]>();
  for (const c of input.commits) {
    const k = dayKey(ms(c.at), tz);
    const list = commitDays.get(k);
    if (list) list.push(c);
    else commitDays.set(k, [c]);
  }
  const cache = new Map<string, DayStats>();
  const statsFor = (d: string) => {
    let s = cache.get(d);
    if (!s) cache.set(d, (s = dayStats(d, tz, now, histories, input.entries, sessions, commitDays.get(d) || [])));
    return s;
  };
  return { input, now, tz, today, day, histories, sessions, commitDays, statsFor };
}

export function analyze(raw: AnalyzeInput): ProjectInsights {
  return analyzePrepared(prepare(raw));
}

export function analyzePrepared(prepared: Prepared): ProjectInsights {
  const { input, now, tz, today, day, histories, commitDays, statsFor } = prepared;
  const stats = statsFor(day);
  const previous = Array.from({ length: TREND_DAYS }, (_, i) => statsFor(addDays(day, -(i + 1))));
  const mean = (pick: (s: DayStats) => number) => previous.reduce((sum, s) => sum + pick(s), 0) / previous.length;
  const average = {
    created: mean((s) => s.created),
    done: mean((s) => s.done),
    rework: mean((s) => s.rework),
    turns: mean((s) => s.turns.completed + s.turns.failed + s.turns.canceled),
    agentMs: mean((s) => s.agentMs),
    commits: mean((s) => s.commits),
  };
  const trendDays = Array.from({ length: TREND_DAYS }, (_, i) => addDays(day, i - TREND_DAYS + 1));
  const trend = trendDays.map((d) => {
    const s = d === day ? stats : statsFor(d);
    const work = Object.entries(s.lanes)
      .filter(([status]) => isWorkStatus(status))
      .reduce((sum, [, n]) => sum + n, 0);
    return { day: d, created: s.created, done: s.done, work };
  });
  const windowStart = dayStart(trendDays[0], tz),
    windowEnd = Math.min(now, dayStart(addDays(day, 1), tz));
  const stays = new Map<string, number[]>();
  for (const h of histories)
    for (const iv of h.intervals.slice(0, -1))
      if (iv.end >= windowStart && iv.end < windowEnd) {
        const list = stays.get(iv.status);
        if (list) list.push(iv.end - iv.start);
        else stays.set(iv.status, [iv.end - iv.start]);
      }
  const dwell: Record<string, number> = {};
  for (const [status, values] of stays) dwell[status] = median(values)!;

  const live = histories.filter((h) => !h.task.archivedAt);
  const since = (h: TaskHistory) => h.intervals[h.intervals.length - 1].start;
  const waitingIn = (status: Status) =>
    live
      .filter((h) => h.task.status === status)
      .sort((a, b) => since(a) - since(b))
      .map((h) => ({ taskId: h.task.id, since: new Date(since(h)).toISOString() }));

  const files = new Map<string, { changes: number; commits: number }>();
  for (const d of trendDays)
    for (const c of commitDays.get(d) || [])
      for (const f of c.files) {
        const e = files.get(f.path) || { changes: 0, commits: 0 };
        e.changes += f.added + f.deleted;
        e.commits++;
        files.set(f.path, e);
      }
  const topFiles = [...files]
    .map(([path, v]) => ({ path, ...v }))
    .sort((a, b) => b.commits - a.commits || b.changes - a.changes || a.path.localeCompare(b.path))
    .slice(0, 5);

  return {
    day,
    today,
    stats,
    average,
    trend,
    dwell,
    review: waitingIn("in_review"),
    blocked: waitingIn("blocked"),
    insights: suggest(live, histories, input, average.done),
    git: { repos: input.repos, error: input.gitError, topFiles },
    incomplete: histories.filter((h) => h.incomplete).length,
  };
}

export function dayStats(
  day: string,
  tz: string | undefined,
  now: number,
  histories: readonly TaskHistory[],
  entries: readonly FlowEntry[],
  sessions: readonly { start: number; end: number }[],
  commits: readonly Commit[],
): DayStats {
  const start = dayStart(day, tz),
    end = dayStart(addDays(day, 1), tz);
  const inDay = (iso: string) => {
    const t = ms(iso);
    return t >= start && t < end;
  };
  const todays = entries.filter((e) => inDay(e.at));
  const changes = todays.filter((e) => e.action === "status_changed");
  const distinct = (to: string) => new Set(changes.filter((e) => e.to === to).map((e) => e.taskId)).size;
  const ended = todays.filter((e) => e.action === "agent.turn_ended");
  const at = Math.min(now, end - 1);
  const lanes: Record<string, number> = {};
  for (const h of histories) {
    if (ms(h.task.createdAt) > at) continue;
    if (h.task.archivedAt && ms(h.task.archivedAt) <= at) continue;
    const iv = h.intervals.find((i) => i.start <= at && at < i.end) || (at >= h.intervals[h.intervals.length - 1].end ? h.intervals[h.intervals.length - 1] : null);
    if (iv) lanes[iv.status] = (lanes[iv.status] || 0) + 1;
  }
  // Peak concurrency: sweep the session intervals clipped to the day.
  const points: [number, number][] = [];
  let agentMs = 0;
  for (const s of sessions) {
    const o = overlap(s.start, s.end, start, end);
    if (o <= 0) continue;
    agentMs += o;
    points.push([Math.max(s.start, start), 1], [Math.min(s.end, end), -1]);
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0,
    peak = 0;
  for (const [, d] of points) peak = Math.max(peak, (live += d));
  return {
    created: histories.filter((h) => inDay(h.task.createdAt)).length,
    done: distinct("done"),
    cancelled: distinct("cancelled"),
    reopened: changes.filter((e) => (e.from === "done" || e.from === "cancelled") && e.to !== "done" && e.to !== "cancelled").length,
    rework: changes.filter(isReworkChange).length,
    turns: {
      completed: ended.filter((e) => !e.outcome || e.outcome === "completed").length,
      failed: ended.filter((e) => e.outcome === "failed").length,
      canceled: ended.filter((e) => e.outcome === "canceled").length,
    },
    agentMs,
    peakSessions: peak,
    questions: todays.filter((e) => e.reportKind === "question").length,
    permissions: todays.filter((e) => e.action === "agent.permission_requested").length,
    ideas: todays.filter((e) => e.action === "idea_proposed").length,
    ideasAccepted: todays.filter((e) => e.action === "idea_accepted").length,
    lanes,
    commits: commits.length,
    added: commits.reduce((n, c) => n + c.files.reduce((m, f) => m + f.added, 0), 0),
    deleted: commits.reduce((n, c) => n + c.files.reduce((m, f) => m + f.deleted, 0), 0),
  };
}

/** Rules R1–R7 (§5), evaluated at `now`; at most MAX_INSIGHTS, warnings first. */
export function suggest(
  live: readonly TaskHistory[],
  all: readonly TaskHistory[],
  input: Pick<AnalyzeInput, "now" | "runningWorkspaces">,
  averageDone: number,
): Insight[] {
  const { now } = input;
  const out: Insight[] = [];
  const since = (h: TaskHistory) => h.intervals[h.intervals.length - 1].start;
  const running = (h: TaskHistory) => input.runningWorkspaces.has(h.task.workspaceId);
  const finished = (s: Status) => s === "done" || s === "cancelled";

  // R1 review backlog
  const review = live.filter((h) => h.task.status === "in_review").sort((a, b) => since(a) - since(b));
  if (review.length && (review.length >= thresholds.reviewCount || now - since(review[0]) >= thresholds.reviewWaitMs)) {
    const weekAgo = now - TREND_DAYS * DAY_MS;
    const recent = all.flatMap((h) => h.entries).filter((e) => e.action === "status_changed" && ms(e.at) >= weekAgo);
    const into = recent.filter((e) => e.to === "in_review").length,
      out_ = recent.filter((e) => e.from === "in_review").length;
    out.push({
      rule: "R1",
      severity: "warning",
      text: `${review.length} card${review.length === 1 ? "" : "s"} waiting for your review (oldest ${waited(now - since(review[0]))}). Last 7 days: ${into} in, ${out_} out.`,
      args: { n: review.length, waitMs: now - since(review[0]), into, out: out_ },
      taskIds: review.map((h) => h.task.id),
    });
  }
  // R2 stalled work
  const stalled = live.filter((h) => {
    if (!isWorkStatus(h.task.status) || running(h)) return false;
    const last = Math.max(since(h), ...h.entries.map((e) => ms(e.at)));
    return now - last >= thresholds.staleMs;
  });
  if (stalled.length)
    out.push({
      rule: "R2",
      severity: "info",
      text:
        stalled.length === 1
          ? `${quote(stalled[0].task.title)} has had no activity for ${waited(now - Math.max(since(stalled[0]), ...stalled[0].entries.map((e) => ms(e.at))))}. Resume it or move it back.`
          : `${stalled.length} cards in work lanes have had no activity for 2+ days. Resume them or move them back.`,
      args:
        stalled.length === 1
          ? { title: stalled[0].task.title, waitMs: now - Math.max(since(stalled[0]), ...stalled[0].entries.map((e) => ms(e.at))) }
          : { n: stalled.length },
      taskIds: stalled.map((h) => h.task.id),
    });
  // R3 repeated rework
  for (const h of live) {
    if (finished(h.task.status)) continue;
    const n = h.entries.filter(isReworkChange).length;
    if (n >= thresholds.reworkCount)
      out.push({
        rule: "R3",
        severity: "info",
        text: `${quote(h.task.title)} went back from review ${n} times. The request may need clarifying.`,
        args: { title: h.task.title, n },
        taskIds: [h.task.id],
      });
  }
  // R4 priority inversion
  const started = all.flatMap((h) =>
    h.entries
      .filter((e) => e.action === "status_changed" && (isWorkStatus(e.to || "") || e.to === "in_progress") && !isWorkStatus(e.from || ""))
      .map((e) => ({ at: ms(e.at), rank: priorityRank(h.task.priority) })),
  );
  for (const h of live) {
    if ((h.task.status !== "backlog" && h.task.status !== "todo") || priorityRank(h.task.priority) < priorityRank("high")) continue;
    const from = since(h);
    if (now - from < thresholds.inversionMs) continue;
    if (started.some((s) => s.at >= from && s.rank < priorityRank(h.task.priority)))
      out.push({
        rule: "R4",
        severity: "warning",
        text: `${quote(h.task.title)} (${h.task.priority}) has waited ${waited(now - from)} while lower-priority cards started.`,
        args: { title: h.task.title, priority: h.task.priority, waitMs: now - from },
        taskIds: [h.task.id],
      });
  }
  // R5 too much in parallel
  const work = live.filter((h) => isWorkStatus(h.task.status));
  if (work.length >= thresholds.wipMin && work.length > thresholds.wipFactor * averageDone)
    out.push({
      rule: "R5",
      severity: "warning",
      text: `${work.length} cards in progress, but about ${averageDone.toFixed(1)} finish per day. Finish some before starting more.`,
      args: { n: work.length, rate: averageDone.toFixed(1) },
      taskIds: work.map((h) => h.task.id),
    });
  // R6 repeated failures
  for (const h of live) {
    const failed = h.entries.filter((e) => e.action === "agent.turn_ended" && e.outcome === "failed" && now - ms(e.at) <= thresholds.failedWindowMs).length;
    if (failed >= thresholds.failedTurns)
      out.push({
        rule: "R6",
        severity: "warning",
        text: `${quote(h.task.title)} had ${failed} failed turns in the last 24h.`,
        args: { title: h.task.title, n: failed },
        taskIds: [h.task.id],
      });
  }
  // R7 nothing running: what to start
  const todo = live
    .filter((h) => h.task.status === "todo")
    .sort((a, b) => priorityRank(b.task.priority) - priorityRank(a.task.priority) || since(a) - since(b));
  if (todo.length && !live.some(running)) {
    const next = todo.slice(0, thresholds.nextUp);
    out.push({
      rule: "R7",
      severity: "info",
      text: `Nothing is running. Next up: ${next.map((h) => quote(h.task.title)).join(", ")}.`,
      args: { titles: next.map((h) => quote(h.task.title)).join(", ") },
      taskIds: next.map((h) => h.task.id),
    });
  }
  const order = (i: Insight) => (i.severity === "warning" ? 0 : 1);
  return out
    .map((i, index) => ({ i, index }))
    .sort((a, b) => order(a.i) - order(b.i) || a.index - b.index)
    .slice(0, MAX_INSIGHTS)
    .map(({ i }) => i);
}

// ---- Tokens by day (§11) ----------------------------------------------------

export const TOP_TOKEN_TASKS = 5;
export const tokenInsightsSchema = z.object({
  day: z.string(),
  today: z.string(),
  /** Tokens over the period ending on `day` (one day unless the request names a longer one). */
  tokens: tokenUsageSchema,
  /** Mean total tokens per period over the baseline before it (the 7 days before, for a day). */
  average: z.number(),
  trend: z.array(z.object({ day: z.string(), total: z.number(), usage: tokenUsageSchema.optional() })),
  /** Cards that used the most tokens in the period, most first. */
  tasks: z.array(z.object({ taskId: z.string(), tokens: tokenUsageSchema })),
  /** Sessions read, and sessions without a local Claude Code / Codex log. */
  sessions: z.number().int(),
  missing: z.number().int(),
});
export type TokenInsights = z.infer<typeof tokenInsightsSchema>;

/**
 * Sums 15-minute token slots into the zone's days. `span` is the period length
 * in days, `chart` the days on the trend, `baseline` how many earlier periods
 * the average covers (INSIGHTS-REDESIGN-SPEC §7).
 */
export function tokenInsights(input: {
  series: readonly { taskId: string; buckets: ReadonlyMap<number, TokenUsage> | null }[];
  now: number;
  tz: string | undefined;
  day?: string;
  span?: number;
  chart?: number;
  baseline?: number;
}): TokenInsights {
  const { tz, now } = input;
  const span = input.span ?? 1,
    chart = input.chart ?? TREND_DAYS,
    baseline = input.baseline ?? TREND_DAYS;
  const today = dayKey(now, tz);
  const day = input.day && isDay(input.day) && input.day <= today ? input.day : today;
  const slot = (d: string) => Math.floor(dayStart(d, tz) / TOKEN_SLOT_MS);
  const sum = (from: string, to: string, taskId?: string) => {
    const a = slot(from),
      b = slot(addDays(to, 1));
    let out = zeroUsage();
    for (const s of input.series) {
      if (!s.buckets || (taskId && s.taskId !== taskId)) continue;
      for (const [k, tokens] of s.buckets) if (k >= a && k < b) out = addUsage(out, tokens);
    }
    return out;
  };
  const from = addDays(day, 1 - span);
  const tokens = sum(from, day);
  const before = totalTokens(sum(addDays(from, -span * baseline), addDays(from, -1)));
  const trend = Array.from({ length: chart }, (_, i) => addDays(day, i + 1 - chart)).map((d) => {
    const usage = sum(d, d);
    return { day: d, total: totalTokens(usage), usage };
  });
  const tasks = [...new Set(input.series.map((s) => s.taskId))]
    .map((taskId) => ({ taskId, tokens: sum(from, day, taskId) }))
    .filter((t) => totalTokens(t.tokens) > 0)
    .sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens))
    .slice(0, TOP_TOKEN_TASKS);
  return {
    day,
    today,
    tokens,
    average: before / baseline,
    trend,
    tasks,
    sessions: input.series.length,
    missing: input.series.filter((s) => !s.buckets).length,
  };
}
