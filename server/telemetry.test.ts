import { afterEach, expect, test } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bucket, countWindow, forcedOff, heartbeatProperties, modelTable, POSTHOG_KEY, TelemetryService, uiLocale, type TelemetrySnapshot } from "./telemetry";
import { FLOWLY_VERSION } from "../shared/version";
import type { FlowEntry } from "../shared/insights";
import pkg from "../package.json";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function dir() {
  const root = await mkdtemp(join(tmpdir(), "flowly-telemetry-"));
  roots.push(root);
  return root;
}

const snapshot: TelemetrySnapshot = {
  flowlyVersion: FLOWLY_VERSION,
  language: "auto",
  deviceLocale: "zh-CN",
  aiLanguage: "interface",
  features: { memory: true, insights: true, ideas: true, artifacts: true, outsideSessions: false, autoStatus: true, autoWrapup: false, archiveOnDelete: false, workflowInsights: false, summary: true, autoReview: false },
  projects: 3,
  guardrails: 7,
  cardsOpen: 12,
};

const event = (action: string, at: string, extra: Partial<FlowEntry> = {}): FlowEntry => ({ id: `${action}-${at}-${Math.random()}`, at, taskId: "t1", actor: "agent", action, ...extra });

/** The exact §4 whitelist (window_days only after a gap of more than 7 days). */
const expectedKeys = [
  "$process_person_profile", "$geoip_disable", "flowly_version", "node_major", "os", "arch", "ui_language", "ui_locale", "ai_language",
  "f_memory", "f_insights", "f_ideas", "f_artifacts", "f_outside_sessions", "f_auto_status", "f_auto_wrapup", "f_archive_on_delete", "f_workflow_insights", "f_summary", "f_auto_review",
  "projects", "cards_open", "c_guardrails",
  "c_cards_created", "c_turns", "c_deliveries", "c_next_moves", "c_next_moves_picked", "c_ideas_proposed", "c_ideas_accepted", "c_ideas_dismissed", "c_memory_proposed", "c_memory_confirmed", "c_wrapups", "c_reviews", "c_reviews_failed", "c_user_actions", "models",
].sort();

function harness(directory: string, options: { env?: NodeJS.ProcessEnv; apiKey?: string; enabled?: () => Promise<boolean>; status?: number; throws?: boolean; now?: () => number; events?: FlowEntry[] } = {}) {
  const calls: { url: string; body: { api_key: string; event: string; distinct_id: string; properties: Record<string, unknown> } }[] = [];
  let enabled = true;
  const service = new TelemetryService({
    directory,
    env: options.env ?? {},
    apiKey: options.apiKey ?? "phc_test",
    now: options.now ?? (() => NOW),
    enabled: options.enabled ?? (async () => enabled),
    snapshot: async () => snapshot,
    activity: async () => ({ events: options.events ?? [], memoryConfirmedAt: [] }),
    fetch: (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (options.throws) throw new Error("offline");
      return { ok: (options.status ?? 200) < 300 } as Response;
    }) as unknown as typeof fetch,
  });
  return { service, calls, setEnabled: (on: boolean) => (enabled = on) };
}

test("version constant matches package.json", () => {
  expect(FLOWLY_VERSION).toBe(pkg.version);
});

test("§9-1, §9-2: a due check sends exactly one heartbeat to PostHog US with exactly the whitelisted keys", async () => {
  const { service, calls } = harness(await dir());
  expect(await service.check()).toBe("sent");
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://us.i.posthog.com/i/v0/e/");
  expect(calls[0].body.event).toBe("flowly_heartbeat");
  expect(calls[0].body.api_key).toBe("phc_test");
  expect(Object.keys(calls[0].body.properties).sort()).toEqual(expectedKeys);
  expect(calls[0].body.properties.$process_person_profile).toBe(false);
  expect(calls[0].body.properties.$geoip_disable).toBe(true);
  expect(calls[0].body.properties.projects).toBe("2-5");
  expect(calls[0].body.properties.cards_open).toBe("6-20");
  // Active guidelines across unarchived projects, bucketed like the other snapshot counts (GUARDRAILS-SPEC §10).
  expect(calls[0].body.properties.c_guardrails).toBe("6-20");
  expect(calls[0].body.properties).not.toHaveProperty("f_auto_review_llm");
  // Not due again for 20 h.
  expect(await service.check()).toBe("not-due");
  expect(calls).toHaveLength(1);
});

test("§9-1: the first check runs 5 minutes after start", async () => {
  const { service, calls } = harness(await dir());
  const { vi } = await import("vitest");
  vi.useFakeTimers();
  try {
    service.start();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    // The check itself does real file I/O; let it finish without starting another.
    vi.useRealTimers();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  } finally {
    service.stop();
    vi.useRealTimers();
  }
});

test("§9-3: off sends nothing; turning it back on keeps the install id", async () => {
  let now = NOW;
  const root = await dir();
  const { service, calls, setEnabled } = harness(root, { now: () => now });
  await service.check();
  const id = calls[0].body.distinct_id;
  setEnabled(false);
  now += 30 * HOUR;
  expect(await service.check()).toBe("off");
  expect(calls).toHaveLength(1);
  setEnabled(true);
  expect(await service.check()).toBe("sent");
  expect(calls[1].body.distinct_id).toBe(id);
});

test("turning it back on starts the window then, and keeps that start across checks that do not send", async () => {
  let now = NOW;
  const root = await dir();
  const { service, setEnabled } = harness(root, { now: () => now });
  await service.check();
  setEnabled(false);
  now += HOUR;
  await service.check();
  setEnabled(true);
  now += HOUR;
  const reEnabledAt = new Date(now).toISOString();
  expect(await service.check()).toBe("not-due");
  now += HOUR;
  expect(await service.check()).toBe("not-due");
  expect(JSON.parse(await readFile(join(root, "telemetry.json"), "utf8")).windowStart).toBe(reEnabledAt);
});

test("§9-4: DO_NOT_TRACK, FLOWLY_TELEMETRY=0 and NODE_ENV=test send nothing", async () => {
  for (const env of [{ DO_NOT_TRACK: "1" }, { FLOWLY_TELEMETRY: "0" }, { FLOWLY_TELEMETRY: "off" }, { NODE_ENV: "test" }]) {
    const { service, calls } = harness(await dir(), { env });
    expect(service.forcedOff()).toBe(true);
    expect(await service.check()).toBe("off");
    expect(calls).toHaveLength(0);
  }
  expect(forcedOff({ DO_NOT_TRACK: "0" })).toBe(false);
  expect(forcedOff({})).toBe(false);
});

test("§6: this fork ships without a PostHog key, so nothing is sent and no install id is created, setting on or not", async () => {
  expect(POSTHOG_KEY, "telemetry is hard-off in this fork: keep POSTHOG_KEY empty (TELEMETRY-SPEC §6)").toBe("");
  const root = await dir();
  const { service, calls } = harness(root, { apiKey: POSTHOG_KEY, enabled: async () => true });
  expect(service.builtOff()).toBe(true);
  expect(service.forcedOff()).toBe(false);
  expect(await service.check()).toBe("off");
  expect(await service.reportError("test", Object.assign(new Error("boom"), { code: "EBOOM" }))).toBe(false);
  expect(calls).toHaveLength(0);
  expect(await readdir(root)).toEqual([]);
});

test("§9-5: network errors and 500s neither throw nor move lastSentAt, and retry on the next check", async () => {
  const root = await dir();
  const failing = harness(root, { status: 500 });
  expect(await failing.service.check()).toBe("failed");
  const offline = harness(root, { throws: true });
  expect(await offline.service.check()).toBe("failed");
  const state = JSON.parse(await readFile(join(root, "telemetry.json"), "utf8"));
  expect(state.lastSentAt).toBe("");
  const ok = harness(root);
  expect(await ok.service.check()).toBe("sent");
  expect(ok.calls).toHaveLength(1);
});

test("§9-6: ui_locale is the chosen language, else the device's, else empty", () => {
  expect(uiLocale("ja", "zh-CN")).toBe("ja");
  expect(uiLocale("auto", "zh-CN")).toBe("zh-CN");
  expect(uiLocale("auto", "")).toBe("");
  expect(uiLocale("auto", "xx-YY")).toBe("");
});

test("§9-7: counts only the window; invalid model keys fold into other, at most 10 keys", () => {
  const start = NOW - 24 * HOUR;
  const inside = new Date(NOW - HOUR).toISOString();
  const before = new Date(start - HOUR).toISOString();
  const events = [
    event("created", inside),
    event("created", before),
    event("agent.turn_ended", inside, { model: "claude/claude-sonnet-5-5", pick: 0 }),
    event("agent.turn_ended", inside, { model: "Not A Model" }),
    event("status_changed", inside, { to: "in_review" }),
    event("status_changed", inside, { to: "in_review", actor: "human" }),
    event("next_moves_suggested", inside, { offered: 2 }),
    event("next_moves_suggested", inside, { offered: 0 }),
    event("idea_adopted", inside),
    event("wrapped_up", inside),
    event("review_finished", inside, { results: [{ id: "a", state: "failed", gating: false }, { id: "b", state: "passed" }] }),
    event("review_finished", inside, { results: [{ id: "b", state: "failed" }] }),
    event("review_finished", inside),
    event("edited", inside, { actor: "human" }),
    event("edited", before, { actor: "human" }),
    event("agent.turn_ended", inside, { byUser: true }),
  ];
  const c = countWindow(events, [inside, before], start, NOW);
  expect(c).toMatchObject({ c_cards_created: 1, c_turns: 3, c_next_moves_picked: 1, c_deliveries: 1, c_next_moves: 1, c_ideas_accepted: 1, c_wrapups: 1, c_memory_confirmed: 1, c_reviews: 2, c_reviews_failed: 1, c_user_actions: 3 });
  expect(c.models).toEqual({ "claude/claude-sonnet-5-5": 1, other: 1 });
  const many = new Map(Array.from({ length: 12 }, (_, i) => [`p/m${i}`, 12 - i] as [string, number]));
  const table = modelTable(many);
  expect(Object.keys(table)).toHaveLength(11);
  expect(table.other).toBe(2 + 1);
});

test("a gap of more than 7 days counts only the last 7 and adds window_days", async () => {
  const root = await dir();
  await writeFile(join(root, "telemetry.json"), JSON.stringify({ installId: "6f1d3f1e-8a1c-4d7f-9a59-1d2f7c9b3c11", lastSentAt: new Date(NOW - 10 * 24 * HOUR).toISOString(), windowStart: new Date(NOW - 10 * 24 * HOUR).toISOString() }));
  const old = new Date(NOW - 9 * 24 * HOUR).toISOString();
  const recent = new Date(NOW - HOUR).toISOString();
  const { service, calls } = harness(root, { events: [event("created", old), event("created", recent)] });
  await service.check();
  expect(calls[0].body.properties.c_cards_created).toBe(1);
  expect(calls[0].body.properties.window_days).toBe(10);
});

test("§9-8: an invalid telemetry.json is kept aside and replaced", async () => {
  const root = await dir();
  await writeFile(join(root, "telemetry.json"), "{not json");
  const { service, calls } = harness(root);
  expect(await service.check()).toBe("sent");
  expect(calls).toHaveLength(1);
  const files = await readdir(root);
  expect(files.some((f) => f.startsWith("telemetry.json.invalid-"))).toBe(true);
  expect(JSON.parse(await readFile(join(root, "telemetry.json"), "utf8")).installId).toBe(calls[0].body.distinct_id);
});

test("buckets", () => {
  expect([0, 1, 2, 5, 6, 20, 21, 100, 101].map(bucket)).toEqual(["0", "1", "2-5", "2-5", "6-20", "6-20", "21-100", "21-100", "100+"]);
  expect(Object.keys(heartbeatProperties(snapshot, countWindow([], [], 0, 1)))).not.toContain("window_days");
});
