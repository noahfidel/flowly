import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { localeCodes } from "../shared/i18n";
import type { FlowEntry } from "../shared/insights";
import { FLOWLY_VERSION } from "../shared/version";
import { exceptionReport } from "./error-report";

/**
 * Anonymous daily heartbeat to PostHog Cloud US (TELEMETRY-SPEC). Only the daemon sends, at
 * most one `flowly_heartbeat` a day, with the whitelisted properties built below and nothing
 * else. Failures are silent: no retries queue, the next hourly check tries again.
 */

export const POSTHOG_ENDPOINT = "https://us.i.posthog.com/i/v0/e/";
/**
 * The main switch. Empty: nothing is sent, no install id is created, and Settings shows usage data
 * off and locked. This fork keeps it empty for good (TELEMETRY-SPEC §6); `server/telemetry.test.ts`
 * fails when a key comes back, e.g. from an upstream merge.
 */
export const POSTHOG_KEY = "";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const FIRST_CHECK_DELAY = 5 * 60_000;
export const CHECK_INTERVAL = HOUR;
/** 20 h rather than 24 so a machine opened at the same time every day is not pushed to the next one (§3.1). */
export const SEND_EVERY = 20 * HOUR;
const MAX_WINDOW = 7 * DAY;
const REQUEST_TIMEOUT = 10_000;
const COUNT_CAP = 10_000;
const MAX_MODELS = 10;
/** Error reports (§11): each kind once per UTC day, at most this many a day. */
export const MAX_ERRORS_PER_DAY = 20;
const modelKey = /^[a-z0-9._-]+\/[a-zA-Z0-9._:-]+$/;

/** DO_NOT_TRACK, FLOWLY_TELEMETRY=0 and tests switch it off whatever the setting says (§6). */
export function forcedOff(env: NodeJS.ProcessEnv): boolean {
  const dnt = env.DO_NOT_TRACK?.trim();
  if (dnt && dnt !== "0") return true;
  if (["0", "off", "false"].includes((env.FLOWLY_TELEMETRY ?? "").trim().toLowerCase())) return true;
  return env.NODE_ENV === "test";
}

/** Counts are sent as buckets, never exact (§4.5). */
export function bucket(n: number): string {
  if (n <= 0) return "0";
  if (n === 1) return "1";
  if (n <= 5) return "2-5";
  if (n <= 20) return "6-20";
  if (n <= 100) return "21-100";
  return "100+";
}

/** The language the interface actually shows (§4.2): the chosen one, else the device's, else "". */
export function uiLocale(language: string, deviceLocale: string): string {
  const known = (code: string) => (localeCodes as readonly string[]).includes(code);
  if (language !== "auto") return known(language) ? language : "";
  return known(deviceLocale) ? deviceLocale : "";
}

export type WindowCounts = {
  c_cards_created: number;
  c_turns: number;
  c_deliveries: number;
  c_next_moves: number;
  c_next_moves_picked: number;
  c_ideas_proposed: number;
  c_ideas_accepted: number;
  c_ideas_dismissed: number;
  c_memory_proposed: number;
  c_memory_confirmed: number;
  c_wrapups: number;
  c_reviews: number;
  c_reviews_failed: number;
  c_user_actions: number;
  models: Record<string, number>;
};

/** Window counts from the untrimmed flow logs and memory confirmations, `[start, end)` (§4.3). */
export function countWindow(events: readonly FlowEntry[], memoryConfirmedAt: readonly string[], start: number, end: number): WindowCounts {
  const inside = (at: string) => {
    const t = Date.parse(at);
    return t >= start && t < end;
  };
  const c: WindowCounts = {
    c_cards_created: 0,
    c_turns: 0,
    c_deliveries: 0,
    c_next_moves: 0,
    c_next_moves_picked: 0,
    c_ideas_proposed: 0,
    c_ideas_accepted: 0,
    c_ideas_dismissed: 0,
    c_memory_proposed: 0,
    c_memory_confirmed: 0,
    c_wrapups: 0,
    c_reviews: 0,
    c_reviews_failed: 0,
    c_user_actions: 0,
    models: {},
  };
  const models = new Map<string, number>();
  for (const e of events) {
    if (!inside(e.at)) continue;
    if (e.actor === "human" || (e.action === "agent.turn_ended" && e.byUser)) c.c_user_actions++;
    switch (e.action) {
      case "created": c.c_cards_created++; break;
      case "agent.turn_ended":
        c.c_turns++;
        if ((e.pick ?? -1) >= 0) c.c_next_moves_picked++;
        if (e.model) models.set(e.model, (models.get(e.model) ?? 0) + 1);
        break;
      case "status_changed": if (e.actor === "agent" && e.to === "in_review") c.c_deliveries++; break;
      case "next_moves_suggested": if ((e.offered ?? 0) > 0) c.c_next_moves++; break;
      case "idea_proposed": c.c_ideas_proposed++; break;
      case "idea_accepted":
      case "idea_adopted": c.c_ideas_accepted++; break;
      case "idea_dismissed": c.c_ideas_dismissed++; break;
      case "memory_proposed": c.c_memory_proposed++; break;
      case "wrapped_up": c.c_wrapups++; break;
      case "review_finished":
        if (!e.results?.length) break;
        c.c_reviews++;
        if (e.results.some((r) => r.gating !== false && r.state === "failed")) c.c_reviews_failed++;
        break;
    }
  }
  c.c_memory_confirmed = memoryConfirmedAt.filter(inside).length;
  for (const key of Object.keys(c) as (keyof WindowCounts)[]) {
    if (key !== "models") c[key] = Math.min(COUNT_CAP, c[key] as number);
  }
  c.models = modelTable(models);
  return c;
}

/** Valid `provider/model` keys only, at most 10; the rest folds into "other" (§4.3). */
export function modelTable(counts: ReadonlyMap<string, number>): Record<string, number> {
  let other = 0;
  const valid: [string, number][] = [];
  for (const [key, n] of counts) {
    if (modelKey.test(key)) valid.push([key, n]);
    else other += n;
  }
  valid.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out: Record<string, number> = {};
  for (const [key, n] of valid.slice(0, MAX_MODELS)) out[key] = Math.min(COUNT_CAP, n);
  for (const [, n] of valid.slice(MAX_MODELS)) other += n;
  if (other > 0) out.other = Math.min(COUNT_CAP, other);
  return out;
}

/** What the daemon knows about its settings and board when a heartbeat is due (§4.2). */
export type TelemetrySnapshot = {
  flowlyVersion: string;
  language: string;
  deviceLocale: string;
  aiLanguage: string;
  features: {
    memory: boolean;
    insights: boolean;
    ideas: boolean;
    artifacts: boolean;
    outsideSessions: boolean;
    autoStatus: boolean;
    autoWrapup: boolean;
    archiveOnDelete: boolean;
    workflowInsights: boolean;
    summary: boolean;
    /** Some active project has Auto review on (AUTO-REVIEW-SPEC). */
    autoReview: boolean;
  };
  projects: number;
  /** Active guidelines across unarchived projects (GUARDRAILS-SPEC §10). */
  guardrails: number;
  cardsOpen: number;
};

/** The heartbeat's properties: exactly the §4 whitelist. */
export function heartbeatProperties(s: TelemetrySnapshot, counts: WindowCounts, windowDays?: number) {
  return {
    $process_person_profile: false,
    $geoip_disable: true,
    flowly_version: s.flowlyVersion,
    node_major: Number(process.versions.node.split(".")[0]),
    os: process.platform,
    arch: process.arch,
    ui_language: s.language,
    ui_locale: uiLocale(s.language, s.deviceLocale),
    ai_language: s.aiLanguage,
    f_memory: s.features.memory,
    f_insights: s.features.insights,
    f_ideas: s.features.ideas,
    f_artifacts: s.features.artifacts,
    f_outside_sessions: s.features.outsideSessions,
    f_auto_status: s.features.autoStatus,
    f_auto_wrapup: s.features.autoWrapup,
    f_archive_on_delete: s.features.archiveOnDelete,
    f_workflow_insights: s.features.workflowInsights,
    f_summary: s.features.summary,
    f_auto_review: s.features.autoReview,
    projects: bucket(s.projects),
    c_guardrails: bucket(s.guardrails),
    cards_open: bucket(s.cardsOpen),
    ...counts,
    ...(windowDays !== undefined ? { window_days: windowDays } : {}),
  };
}

const stateSchema = z.object({
  installId: z.string().uuid(),
  lastSentAt: z.string().default(""),
  /** Start of the counting window; "" while telemetry is off (counting restarts when it is turned on). */
  windowStart: z.string().default(""),
});
export type TelemetryState = z.infer<typeof stateSchema>;

/** `telemetry.json` in the plugin data folder: atomic writes; an unreadable file is kept aside and replaced (§3.3). */
export class TelemetryStateFile {
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "telemetry.json");
  }
  /** null: no file yet (first run). */
  async read(): Promise<TelemetryState | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return stateSchema.parse(JSON.parse(text));
    } catch {
      await copyFile(this.path, `${this.path}.invalid-${Date.now()}`).catch(() => undefined);
      return null;
    }
  }
  async write(state: TelemetryState) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

export type TelemetryDeps = {
  directory: string;
  env: NodeJS.ProcessEnv;
  apiKey: string;
  endpoint?: string;
  now?: () => number;
  fetch?: typeof fetch;
  /** Tests only: the folder whose files count as Flowly's own frames (§11). */
  pluginRoot?: string;
  /** The Paseo version for error reports (§11.3); "" when unknown. Asked again after an empty answer. */
  paseoVersion?(): Promise<string>;
  /** The `telemetry` setting; unreadable settings count as on (the default). */
  enabled(): Promise<boolean>;
  snapshot(): Promise<TelemetrySnapshot>;
  /** Flow-log entries of every project, and when each active note became active. */
  activity(): Promise<{ events: FlowEntry[]; memoryConfirmedAt: string[] }>;
};

export type CheckResult = "sent" | "off" | "not-due" | "failed";

export class TelemetryService {
  private readonly file: TelemetryStateFile;
  private readonly now: () => number;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private running: Promise<CheckResult> | null = null;
  constructor(private readonly deps: TelemetryDeps) {
    this.file = new TelemetryStateFile(deps.directory);
    this.now = deps.now ?? Date.now;
  }
  forcedOff() {
    return forcedOff(this.deps.env);
  }
  /** No PostHog key in this build: off whatever the setting or environment says (§6). */
  builtOff() {
    return !this.deps.apiKey;
  }
  /** First check 5 min after load, then hourly (§3.2); timers never keep the daemon alive. */
  start() {
    this.stop();
    const first = setTimeout(() => {
      void this.check();
      const every = setInterval(() => void this.check(), CHECK_INTERVAL);
      every.unref?.();
      this.timers.push(every);
    }, FIRST_CHECK_DELAY);
    first.unref?.();
    this.timers.push(first);
  }
  stop() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
  /** One check; overlapping calls share the run in progress. Never throws. */
  check(): Promise<CheckResult> {
    this.running ??= this.run()
      .catch(() => "failed" as const)
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
  private creating: Promise<TelemetryState> | null = null;
  /** The stored state, or a new one; concurrent callers on a fresh install share one install id. */
  private stateOrCreate(now: number): Promise<TelemetryState> {
    this.creating ??= (async () => {
      const stored = await this.file.read();
      if (stored) return stored;
      const state = { installId: randomUUID(), lastSentAt: "", windowStart: new Date(now - DAY).toISOString() };
      await this.file.write(state);
      return state;
    })().finally(() => {
      this.creating = null;
    });
    return this.creating;
  }
  private paseoVersion = "";
  private errorDay = "";
  private errorsSent = new Set<string>();
  /**
   * Sends one `$exception` event (§11) under the same switches as the heartbeat. Never throws.
   * Uncaught errors are reported only when they pass through Flowly's own code.
   */
  async reportError(source: string, error: unknown, handled = true): Promise<boolean> {
    try {
      if (this.forcedOff() || !this.deps.apiKey) return false;
      const report = exceptionReport(error, source, handled, this.deps.pluginRoot);
      if (!handled && report.frames.length === 0) return false;
      const now = this.now();
      const day = new Date(now).toISOString().slice(0, 10);
      if (day !== this.errorDay) {
        this.errorDay = day;
        this.errorsSent = new Set();
      }
      if (this.errorsSent.has(report.fingerprint) || this.errorsSent.size >= MAX_ERRORS_PER_DAY) return false;
      this.errorsSent.add(report.fingerprint);
      if (!(await this.deps.enabled().catch(() => true))) return false;
      const state = await this.stateOrCreate(now);
      this.paseoVersion ||= (await this.deps.paseoVersion?.().catch(() => "")) ?? "";
      const properties = {
        $process_person_profile: false,
        $geoip_disable: true,
        $exception_list: [
          { type: report.type, value: report.value, mechanism: { handled: report.handled, synthetic: false }, stacktrace: { type: "raw", frames: report.frames } },
        ],
        $exception_fingerprint: report.fingerprint,
        source: report.source,
        flowly_version: FLOWLY_VERSION,
        paseo_version: this.paseoVersion,
        node_major: Number(process.versions.node.split(".")[0]),
        os: process.platform,
        arch: process.arch,
      };
      return await this.post({ event: "$exception", distinct_id: state.installId, timestamp: new Date(now).toISOString(), properties });
    } catch {
      return false;
    }
  }
  /** One capture request; true on a 2xx answer. */
  private async post(event: { event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> }): Promise<boolean> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT);
    timer.unref?.();
    try {
      const response = await (this.deps.fetch ?? fetch)(this.deps.endpoint ?? POSTHOG_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: this.deps.apiKey, ...event }),
        signal: abort.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  private async run(): Promise<CheckResult> {
    const on = !this.forcedOff() && Boolean(this.deps.apiKey) && (await this.deps.enabled().catch(() => true));
    const stored = await this.file.read();
    const now = this.now();
    if (!on) {
      // Off: nothing is sent, and the window restarts when it is turned back on (§5).
      if (stored?.windowStart) await this.file.write({ ...stored, windowStart: "" });
      return "off";
    }
    const base = stored ?? (await this.stateOrCreate(now));
    // A copy, so the comparison below sees whether the window start changed.
    const state: TelemetryState = { ...base };
    if (!state.windowStart) state.windowStart = new Date(now).toISOString();
    if (base.windowStart !== state.windowStart) await this.file.write(state);
    const last = Date.parse(state.lastSentAt);
    if (Number.isFinite(last) && now - last < SEND_EVERY) return "not-due";

    const start = Date.parse(state.windowStart);
    const gap = now - start;
    const from = gap > MAX_WINDOW ? now - MAX_WINDOW : start;
    const [snapshot, activity] = await Promise.all([this.deps.snapshot(), this.deps.activity()]);
    const counts = countWindow(activity.events, activity.memoryConfirmedAt, from, now);
    const properties = heartbeatProperties(snapshot, counts, gap > MAX_WINDOW ? Math.ceil(gap / DAY) : undefined);
    const sent = await this.post({ event: "flowly_heartbeat", distinct_id: state.installId, timestamp: new Date(now).toISOString(), properties });
    if (!sent) return "failed";
    const sentAt = new Date(now).toISOString();
    await this.file.write({ ...state, lastSentAt: sentAt, windowStart: sentAt });
    return "sent";
  }
}
