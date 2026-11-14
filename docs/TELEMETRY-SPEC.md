# Anonymous usage data (telemetry)

Status: **implemented, to ship with 1.7.0** (2026-10-26, card "Telemetry setup"; implementation: `server/telemetry.ts`). `POSTHOG_KEY` was filled in on 2026-10-26 with the project token of the PostHog US project; when the constant is empty nothing is sent. **This fork (hevengo/flowly) has had telemetry permanently off since 2026-10-29: `POSTHOG_KEY` is empty (section 6).** User decisions: use PostHog Cloud (first set to the EU region; on 2026-10-26 the maintainer's project was created in the US region, and the user decided to use the US entry point); the daemon calls the capture HTTP API directly, with no SDK; one heartbeat per day; fields on an allowlist; on by default and can be turned off; honor `DO_NOT_TRACK`. Additional decisions on 2026-10-26:

- Users are told that sending was possible before, and that nothing is sent after turning it off;
- The settings hold only a short description, with no per-field preview; the exact content is defined by the open-source code and this spec;
- No ID reset is offered;
- No IP geolocation; the language distribution needed for i18n is provided by `ui_locale`.
- Added 2026-11-10 (card "PostHog telemetry completion"): §4.3 adds `c_user_actions` (to tell "the daemon is running" from "someone is using it") and `c_reviews` / `c_reviews_failed`. No `$pageview` is added: the Installation Health check of PostHog Web analytics is designed for websites, and Flowly adds no in-UI tracking (§1, §2), so alerts from that check can be ignored. The client platform is still deferred per §10.
- Added 2026-10-26: report errors encountered on the daemon side, with a separate `$exception` event carrying only the error type, a safe error code, the source label and stack frames of Flowly's own code, without the error message or user paths, at most once per day per kind of error (section 11). Client (UI) errors are not reported.

## 1. Purpose and non-goals

Paseo's plugin registry gives no install or update statistics, and npm download counts are mixed with CI and mirrors, so the following three questions cannot be answered today:

1. How many installs still use Flowly and on which version (and, after a new release, how fast people upgrade);
2. Which features are turned on and which are turned off;
3. How often the core loop (creating cards, agent delivery, Next moves, Ideas, Memory) is actually used.

This feature answers only these three questions.

Non-goals:

- Per-event reporting;
- Error messages, and stack frames and paths outside Flowly's own code (section 11 sends only the type, error code and Flowly's own frames);
- Client (UI) tracking, session replay, feature flags;
- Anything that could reconstruct what a user is doing (titles, descriptions, paths, repos, conversations, commands);
- Identifying by user or team;
- Using telemetry data to drive any behavior in the product.

## 2. Overall shape

- **Only the daemon sends.** The client makes no network request and adds no dependency, so the cold-start constraint is unaffected (the Cold start item of AGENTS.md).
- **At most one heartbeat event per day**, `flowly_heartbeat`, whose content is the allowlisted fields of section 4; besides it, only the `$exception` error event of section 11. No other events are sent.
- **Receiver**: a project in PostHog Cloud US region, held by the maintainer. *Discard client IP data* is turned on in the project settings.
- **No SDK**: one `fetch` POST with a 10 s timeout and no retry queue; on failure it waits for the next check (section 3).
- A telemetry failure **does not affect any feature**: it throws no error, shows no prompt and writes nothing into board data.

## 3. When it sends

### 3.1 Preconditions (all must hold to send)

1. The telemetry switch is on (section 5) and it is not forced off by an environment variable (section 6);
2. More than 20 hours have passed since the last **successful** send (`lastSentAt`). 20 hours rather than 24 is so that a machine that boots at a fixed time of day is not pushed to the next day.

Sending does not require that the user has been informed (user decision 2026-10-26). After a plugin upgrade, or after a new user first loads the plugin, sending starts as soon as the two conditions above are met. Informing is done through What's new, the tour and the README (section 7).

### 3.2 Check rhythm

- After the daemon starts (plugin load) it first waits **5 minutes** before the first check, and then checks **once an hour**. The timer must be `unref`ed and cleared when the plugin is unloaded or reloaded.
- One check tries to send at most once. An HTTP 2xx counts as success and writes `lastSentAt` and the end of the counting window (§4.4). Other results (network error, timeout, non-2xx) only log one debug line, and it is tried again in the next hour.
- Nothing is made up while the machine sleeps or the daemon is stopped. After recovery, if the first check meets the conditions, one event is sent covering the whole gap (§4.4).

### 3.3 Local state

Stored in `telemetry.json` under plugin-data (daemon side, atomic write; when invalid the original file is kept and treated as the first time):

```json
{ "installId": "uuid-v4", "lastSentAt": "ISO time or empty", "windowStart": "ISO time" }
```

- `installId` is generated the first time sending is needed (`crypto.randomUUID()`), **not derived from machine information**, and never changed afterwards. No reset entry is offered (user decision 2026-10-26); deleting `telemetry.json` gives a new ID.
- Turning telemetry off **does not delete** `installId`. After it is turned on again the same ID is reused, to avoid double counting.

## 4. What is sent (allowlist)

### 4.1 Request

```
POST https://us.i.posthog.com/i/v0/e/
Content-Type: application/json

{
  "api_key": "<PostHog project key, starts with phc_, write-only, kept in a source constant>",
  "event": "flowly_heartbeat",
  "distinct_id": "<installId>",
  "timestamp": "<send time ISO>",
  "properties": {
    "$process_person_profile": false,
    "$geoip_disable": true,
    ... the fields of 4.2 and 4.3
  }
}
```

- `$process_person_profile: false`: handled as an anonymous event, and PostHog builds no person profile.
- `$geoip_disable: true`: no IP geolocation (user decision 2026-10-26: when doing i18n, looking at the language the UI is actually used in, that is `ui_locale` of §4.2, is more accurate than inferring a country from the IP, and leaves no city-level location).
- The entry address must match the project's region: a US project uses `us.i.posthog.com`, an EU project uses `eu.i.posthog.com`. The capture endpoint returns 200 for any token; whether the region or token is right can be checked with `POST https://<region>.i.posthog.com/flags/?v=2`: when the token or region is wrong it returns `authentication_failed`.

### 4.2 Environment and settings (sent every time)

| Field | Value | Notes |
|---|---|---|
| `flowly_version` | The constant of `shared/version.ts`, with a test ensuring it equals the version in `package.json` | |
| `paseo_version` | Not sent with the heartbeat; sent only with `$exception` (section 11.3) | |
| `node_major` | The major version of `process.versions.node`, such as `24` | |
| `os` | `process.platform`: `darwin` / `linux` / `win32` / the raw value otherwise | |
| `arch` | `process.arch` | |
| `ui_language` | The value of the `language` setting (`auto` or a language code) | Whether the user picked a language manually |
| `ui_locale` | The language code the UI is actually using: when `language` is not `auto` take it; when it is `auto` take `device-language.locale` (the language of the last device that opened it); when neither exists send `""` | Only values in `localeCodes` are taken, any other value is sent as `""` |
| `ai_language` | The value of the `ai-language` setting | |
| `f_memory` / `f_insights` | The `features` setting | Boolean |
| `f_ideas` / `f_artifacts` | The `ideas` setting | Boolean |
| `f_outside_sessions` | `native-session.outside` | Boolean |
| `f_auto_status` | `auto-status.autoStatus` | Boolean |
| `f_auto_wrapup` / `f_archive_on_delete` | The `wrap-up` setting | Boolean |
| `f_workflow_insights` | `workflow-insights.enabled`, with Insights on (Workflow insights is a host-level switch, not per project) | Boolean |
| `f_summary` | `task-summary.summaryEnabled` | Boolean |
| `f_auto_review` | Whether any non-archived project has Auto review on (`project.autoReview.enabled`, AUTO-REVIEW-SPEC) | Boolean |
| `projects` | The number of non-archived projects, bucketed per §4.5 | |
| `c_guardrails` | The total number of active guidelines in non-archived projects (`kind: "guideline"`, `state: "active"` in `guardrails.json`, GUARDRAILS-SPEC §10), bucketed per §4.5; numbers only, no text | A snapshot at send time, not a window count |
| `cards_open` | The number of cards in all projects that are non-archived and not in Done/Cancelled, bucketed per §4.5 | |

A new setting **does not** enter the heartbeat automatically. To add a field, this table must be changed first.

### 4.3 Counts (within the window)

The window is `[windowStart, send time)`. The data comes from `flow/<projectId>.jsonl`, not from the events in `board.json` (only 100 per card are kept, see this pitfall in the project memory), plus the memos in `guardrails.json`. The numbers of all projects are added together:

| Field | What is counted |
|---|---|
| `c_cards_created` | `created` events |
| `c_turns` | `agent.turn_ended` events |
| `c_deliveries` | `status_changed` started by an agent with `to = in_review` |
| `c_next_moves` | The number of times `next_moves_suggested` has non-empty moves |
| `c_next_moves_picked` | `agent.turn_ended` carrying `pick` |
| `c_ideas_proposed` / `c_ideas_accepted` / `c_ideas_dismissed` | `idea_proposed` / `idea_accepted` and `idea_adopted` / `idea_dismissed` |
| `c_memory_proposed` / `c_memory_confirmed` | `memory_proposed` events / memos in `guardrails.json` whose state is active and that became active within the window (`stateAt`). A memo takes effect as soon as it is written (GUARDRAILS-SPEC D2), so it is now the number of memos newly in effect within the window, with the key name kept |
| `c_wrapups` | `wrapped_up` |
| `c_reviews` / `c_reviews_failed` | `review_finished` carrying `results` / the number of times one of them has a gating item (`gating` is not `false`) with `state = failed` (AUTO-REVIEW-SPEC) |
| `c_user_actions` | Events with `actor = human`, plus `agent.turn_ended` with `byUser` (a message sent by the user). `> 0` means someone actually used this install within the window, and it is the basis of DAU (§8) |
| `models` | A count table of `agent.turn_ended.model`, for example `{"claude/claude-sonnet-5-5": 12}` |

Limits on `models`:

- A key must match `^[a-z0-9._-]+/[a-zA-Z0-9._:-]+$`; those that do not match go into `"other"`;
- At most 10 keys are kept, and the rest are merged into `"other"`.

### 4.4 Window

- At the first send, `windowStart` takes `max(the moment telemetry was turned on, send time − 24 h)`.
- After a successful send, `windowStart` is updated to this send time.
- When the gap is longer than 7 days, only the latest 7 days are counted, and a field `window_days` (days rounded up) is added. An ordinary heartbeat with no gap does not carry this field.

### 4.5 Buckets

Quantities are always sent as buckets and never as exact values: `"0"`, `"1"`, `"2-5"`, `"6-20"`, `"21-100"`, `"100+"`.

Window counts (§4.3) are sent as exact integers. A single count is capped at 10 000, and anything above is sent as 10 000.

### 4.6 Never sent

The following is never sent:

- IDs, titles, descriptions and labels of projects, cards and sessions;
- Any path, repo name or remote, branch name;
- Messages, prompts, summaries, commands, artifacts;
- The type or address of a connector;
- Host name, user name, email, IP (the client sends no IP; the PostHog project settings discard IP), time zone;
- Environment variables, tokens.

## 5. Settings

- A new host setting `telemetry` (`shared/settings.ts`): `{ enabled: boolean, default true }`.
- Placed in **Settings → General**, as its own group **Usage data**, with only one switch **Send anonymous usage data**. The description line (it concerns privacy, so it is kept under the UI text rule) gives only a short description and does not list fields: *Once a day: versions, which features are on and usage counts. On errors: where in Flowly's code. Never your content, paths or code.* No per-field preview is offered (user decision 2026-10-26: the project is open source, what is sent is defined by `server/telemetry.ts` and this spec, and the Telemetry section of the README links to these two).
- When forced off by an environment variable (section 6), the switch shows as off and cannot be operated, and the description line becomes *Turned off by DO_NOT_TRACK on this computer.* The client learns this state through the RPC `telemetry.status` (returning `{ forcedOff: boolean, builtOff: boolean }`, with schema validation).
- When the build has no key (`builtOff`, section 6) it likewise shows as off and cannot be operated, and the description line is *Turned off in this build.*, which takes priority over the previous one.
- Turning it off takes effect **immediately**: from the next check nothing is sent, including the act of turning it off itself. After turning it on again, sending continues as usual.
- When the daemon reads the settings it uses the `*Values()` parsing functions (stored values may lack fields).

## 6. Environment variables

They take effect only in the environment of the **daemon process** (the environment Paseo inherits when it starts the daemon), and any one of them forces it off and takes priority over the settings:

- `DO_NOT_TRACK` is non-empty and not equal to `0` (the https://consoledonottrack.com convention);
- `FLOWLY_TELEMETRY=0` (or `off` / `false`).

**Master switch**: when `POSTHOG_KEY` in `server/telemetry.ts` is empty, neither the heartbeat nor `$exception` is sent and no `telemetry.json` is generated, regardless of settings and environment variables. This fork (hevengo/flowly) keeps it empty from 2026-10-29 (user decision: permanently turn telemetry off, the settings page shows it as off and not operable; the texts of the README, OVERVIEW and What's new 1.7.0 are not changed). `server/telemetry.test.ts` fails when the key is not empty; if the key comes back when merging from upstream, empty it again.

Two other cases are never sent either, so that development and test data do not get mixed into the statistics:

- `NODE_ENV=test`;
- The plugin is installed from a local path (`paseo plugin install "$PWD"`). The plugin server cannot get its own install source, so this is not detected automatically; the local-installation note of AGENTS.md requires the maintainer to set `FLOWLY_TELEMETRY=0` for the daemon.

## 7. Informing

| Place | Content |
|---|---|
| What's new (the version that introduces telemetry, `client/whats-new.ts`) | One item: *Flowly now sends anonymous usage data: once a day, versions, which features are on and usage counts; on errors, where in Flowly's code. Never your content, paths or code. You can turn it off in Settings.*, with an **Open settings** button that opens General |
| The last page of the first tour, Ready when you are (`client/onboarding.tsx`) | The same switch (`UsageDataGroup`) is placed under More features, with the text of section 5, on by default. The Built in page is about features running on every card, so telemetry does not belong there |
| README (English, Chinese) | A new **Telemetry** section: a few sentences summarizing what is sent and what is not, how to turn it off (settings or `DO_NOT_TRACK=1`), where the data is stored (PostHog US), and links to this spec and `server/telemetry.ts` |
| ONBOARDING-SPEC | Records the line newly added on the last page. No one-time tip is added: What's new already covers existing users, and the tour covers new users |

All new texts go into all the catalogs of `shared/i18n/` (I18N-SPEC).

## 8. Maintainer side (not in the plugin code)

- The PostHog project (US region), with *Discard client IP data* turned on and the data retention period at the default of the free tier.
- Key maintenance:
  - `POSTHOG_KEY` in `server/telemetry.ts` is the project's project token (`phc_…`), which can only write events and cannot read data, is designed to be public, ships with the npm package, and needs no user configuration.
  - Do not commit a personal API key (`phx_…`); the plugin does not use it either.
  - Set a usage limit (billing limit) in PostHog, to prevent someone flooding events and using up the quota or causing charges.
  - Change it only when the key is abused: first reset the project token in the PostHog project settings, then change `POSTHOG_KEY` and release a new version. The cost is that installs on old versions stop reporting until the user upgrades.
  - The capture endpoint returns 200 for any key; whether the key is right must be seen on the PostHog Activity page, by whether events arrive.
- Suggested dashboards, all based on `flowly_heartbeat`, counting distinct `distinct_id` per day:
  - Version distribution: grouped by `flowly_version`;
  - Upgrade curve: the share of each version after a new release;
  - Feature enable rate: the share of each `f_*`;
  - Usage frequency: the median and P90 of each `c_*`, and DAU/WAU.
  - Active: running installs = the distinct `distinct_id` of `flowly_heartbeat` per day; **active users (DAU)** = those among them with `c_user_actions > 0`. A heartbeat is sent every 20 h or more, so an install occasionally has two on one day, and counting by distinct `distinct_id` is enough; the scale of feature use is the per-day sum of the corresponding `c_*`, and the distinct `distinct_id` with `c_* > 0`.
- PostHog's **Web analytics** (`$pageview`, Installation Health) does not apply: Flowly has no web tracking, and all charts use Product analytics (Trends / SQL) based on `flowly_heartbeat`.
- Dashboard: the **Flowly** dashboard of PostHog project 688543 (created 2026-10-26). Added 2026-11-10: running installs vs active users, core behavior counts, core behavior user counts, Ideas acceptance rate / Next moves click rate, Auto review failure rate (trend charts have the test-account filter on, and SQL charts exclude test IDs in WHERE).
- Excluding test installs: add the HogQL filter `distinct_id != '<installId>'` to the test account filters in the project settings and tick it by default; trend charts turn on *Filter out internal and test users*, and SQL charts write the same condition in WHERE. Events build no person profile (`$process_person_profile: false`), so cohort and person-property filters do not work; a `distinct_id` filter of `type: event` matches an event property and does not work either. Already excluded: the Coder test machine `0d645af4-…` (its Usage data switch is also turned off).
- Restoring bundle line numbers of error frames: `node scripts/map-bundle-lines.mjs --flowly <version or --ref commit> --paseo <Paseo version> <line number>...` (a line number can be written as `104683`, `:104683:10` or `flowly-bundle.js:104683`). The script rebuilds the server bundle using the `compileTarget` options of Paseo 0.13 `compiler.js` (bundle, cjs, platform node, target node20, treeShaking, external modules the same as `SERVER_HOST_MODULES`) plus the 3-line header of `wrapCommonJsBundle`, with the esbuild version Paseo depends on (specify with `--esbuild`), then uses the source map of the same build to look up the file and line of `server/*.ts`, and checks it against the `// server/xxx.ts` module comments in the bundle; the build without a source map and the output with a source map must be identical character for character, otherwise it errors. `--paseo` takes the `paseo_version` of the event. The source comes from the `v<version>` tag (or `--ref`, `--dir`) with `npm ci`. Line numbers are valid only when the version, the dependencies and Paseo's esbuild are all the same: the `flowly_version` in an event is only a version number, and a commit under development may carry the same version, so when they do not match try the corresponding commit with `--ref`, and `--grep <text>` can list the lines in the bundle that contain that text to check function names. The example events of 2026-10-26 (`:104683 listDirectories`, `:102566 directory`) map to `server/directories.ts:16` and `server/service.ts:142` under `13f9905` + Paseo 0.13.0 + esbuild 0.25.12.
- Looking up errors for a Paseo version: HogQL `select properties.paseo_version, count() from events where event = '$exception' group by 1` (old events lack this key, so it is empty).
- The project key can only write and cannot read, so there is no problem putting it in the source. Someone may forge data, and this is accepted: the data is for reference only.

## 9. Acceptance criteria

1. When the switch is on and more than 20 h have passed since the last successful send, the daemon sends **exactly one** request 5 minutes after start: to `https://us.i.posthog.com/i/v0/e/`, with `event = flowly_heartbeat`, and the key set of `properties` exactly matching section 4. Use a fetch stub plus a unit test to assert the key set, and any extra key fails.
2. When the user has not yet seen the tour or What's new, as long as the switch is on, it sends as usual.
3. After the switch is turned off, there is no request at any later check; after it is turned on again sending resumes, with the original `installId` reused.
4. With `DO_NOT_TRACK=1`, `FLOWLY_TELEMETRY=0` and `NODE_ENV=test` there is no request in each case, and the settings page shows the forced-off state.
5. On network failure, timeout or a 500 response: no error is thrown, `lastSentAt` is not changed, it retries an hour later; consecutive failures do not cause extra sends.
6. `ui_locale`: when `language` is a fixed language send that language; when `auto` send `device-language.locale`; when neither exists send `""`.
7. Count test: build a flow log that contains events outside the window, and only events within the window are counted; illegal keys in `models` go into `other`, with at most 10 keys.
8. When `telemetry.json` is corrupt, keep the original file and regenerate the state, without crashing.
9. The client bundle adds no dependency; `npm run typecheck` and `npm test` pass, including the i18n catalog check.
10. README, What's new, the tour and ONBOARDING-SPEC are updated in sync (AGENTS.md Onboarding upkeep).

## 10. Possibly added later (not in this version)

- Client (UI) errors;
- Client platform (web / desktop / iOS / Android): requires the client to tell the daemon through an existing RPC, to be added once the need is proven;
- An active feedback entry;

Before any of these is added, section 4 and the informing text must be changed first.

## 11. Error reporting

2026-10-26 user decision: a separate event + a sanitized stack, daemon side only. Implementation: `server/error-report.ts` (sanitizing, collection points) and `TelemetryService.reportError` (`server/telemetry.ts`).

### 11.1 Preconditions

The same as the heartbeat: the switch is on, it is not forced off by an environment variable (section 6), and `POSTHOG_KEY` is non-empty. It does not require any time since the last heartbeat, and does not require that the user has seen the informing (same as section 3).

### 11.2 Collection points

| Source | `source` | Notes |
|---|---|---|
| An error thrown by an RPC handler | `rpc <rpc name>`, such as `rpc task.update` | Wrapped around `server.handle`, reported and then thrown as is, so the result the caller sees is unchanged. **Expected errors are not reported**, that is, replies the handler deliberately returns to the caller: `ToolError`, `MemoryError`, `StoreInvalidError`, `ExternalError`, `ZodError`, and ordinary `Error`s without a system error code (such as "Task not found.", version conflicts), and the "failures outside Flowly" below. Program errors such as `TypeError`, and errors with a system error code (`ENOENT`, `SQLITE_BUSY`), are reported as usual; when a user-supplied path does not exist (folder browsing, creating a project) or an image file in a session has been deleted, the handler instead throws an ordinary `Error` ("Expected an existing directory.", "The image file no longer exists."), no longer carrying `ENOENT` |
| A background task failure | The log label with the trailing colon removed, such as `Kanban auto wrap-up failed` | The original `console.error(label, message)` is changed everywhere to `logFailure(label, error, context?)`: the log output is unchanged, and it reports once more. The label is a fixed string; things that go only into the log, such as ids and paths, are put in the `context` parameter and not reported. The failure state of the storage layer (`fail()`) has no error object and is reported as `StorageError`, with `value` being the storage error code. There is no bare `console.error` left in daemon code, checked by `server/error-report.test.ts` |
| An uncaught exception | `uncaught` | `process.on("uncaughtExceptionMonitor")`, without changing the crash behavior; removed when the plugin is unloaded. The whole daemon process shares this event, so it is reported only when the stack has Flowly's own frames. When the process exits right after, the request may not get out in time, which is best effort |

Errors before plugin startup finishes (the telemetry service is established) are not reported.

**Failures outside Flowly** (`outsideError`, `server/error-report.ts`) are only logged and not reported, both in RPC and in `logFailure` (2026-10-27, card "Telemetry error analysis": of the 34 events in the first two days about half belonged to this kind, which code cannot fix):

- `DaemonConnectionError`: the connection to the Paseo daemon was dropped (a request in flight while the daemon restarts). The host's client is a separate piece of code, so it is judged by `name`;
- `LocalDaemonUnavailable`: the local connection (`server/local-daemon.ts`) has no address (Paseo's supervisor is restarting the daemon, and `listen` in `paseo.pid` is `null`), no `paseo.pid` (the daemon is not running), `paseo.pid` is still empty or half-written after retries (Paseo rewrites this file in place, see step 1 of WORKSPACE-RESTORE-SPEC), the daemon does not answer the connection (timeout, refused, connection closed; a client with auto-reconnect turned off throws an ordinary `Error` here), or there is no local credential. The daemon rejecting the local credential (`DaemonAuthenticationError`) and errors where the Paseo version lacks a required method after connecting are reported as usual (2026-11-10, card "Recent error investigation");
- `SummaryModelError`: all summary models failed or none was available (a provider problem; the error is shown on the card or in the insights).

### 11.3 Event content (allowlist)

`event = "$exception"`, `distinct_id` is the same as the heartbeat (`installId` of `telemetry.json`; when the file does not exist yet it is created per section 3.3; the heartbeat and multiple errors arriving at the same time share the same creation, so an install has only one `installId`). The key set of `properties` is fixed as:

| Key | Content |
|---|---|
| `$process_person_profile` | `false` |
| `$geoip_disable` | `true` |
| `$exception_list` | One item: `{ type, value, mechanism: { handled, synthetic: false }, stacktrace: { type: "raw", frames } }` |
| `$exception_fingerprint` | The first 32 hex characters of the SHA-256 computed from `type`, `value`, `source` and the file, function name and line number of each frame |
| `source` | The source of section 11.2; `other` when it does not match `^[\w .,;:'/-]{1,80}$` |
| `flowly_version`, `node_major`, `os`, `arch` | The same as section 4 |
| `paseo_version` | The version number of the Paseo daemon (such as `0.13.0`), `""` when it cannot be obtained |

- `paseo_version`: the plugin SDK does not provide the host version (`COMPAT(sdk-paseo-version)`), so `server/paseo-version.ts` opens one short connection (the same as `server/local-daemon.ts`, the local-connection exception of AGENTS.md) and reads the `server_info.version` the daemon sends at connection time, keeping only values that match `^\d+\.\d+\.\d+(?:[-+.][\w.-]{1,20})?$`. After success it is cached in memory until the daemon restarts; when it cannot be obtained (cannot connect, no credential, format mismatch) `""` is sent and the next error tries again, without affecting reporting. Bundle line numbers depend on the Paseo version (its bundled esbuild and wrapper header), so use this value as `--paseo` when restoring line numbers.
- `type`: `error.name`, used only when it fits the identifier format (`^[A-Za-z_$][\w$]{0,60}$`), otherwise `Error`; `NonError` when what was thrown is not an `Error`.
- `value`: `error.code` when it matches `^[A-Z][A-Z0-9_]{1,40}$` (such as `ENOENT`, `SQLITE_BUSY`), otherwise `""`. **The error message is never sent**: messages often hold paths, titles or commands.
  - Exception: for `DaemonRpcError` (a Paseo RPC returning an error, `@getpaseo/client`; the host's client is a separate copy, so it is recognized by `name`) it is `request type:error code` (such as `fetch_agent_timeline_request:agent_refresh_failed`), taken from its `requestType` and `code` fields, lowercased, and kept only if the whole part matches `^[a-z][a-z0-9_.]{0,59}$`, otherwise that part is empty (no cutting or deleting characters to build an identifier); with no error code it is only the request type. Its message holds the server's error text and is likewise not sent (2026-11-10, card "Recent error investigation").
- `handled`: `false` for an uncaught exception, `true` otherwise.
- `frames`: only frames of Flowly's own files are kept, at most 20, ordered with the earliest call first. "Own files" means files under the plugin directory and not inside `node_modules`; the plugin directory is derived at run time from the stack frames of `server/error-report.ts` itself (when loaded from source it is the parent of `server/`, when loaded packaged it is the directory of the package file), so it does not depend on how Paseo loads. Paseo 0.13 compiles the plugin server into one esbuild bundle and runs it with `eval` (`bundle-evaluator.js`, with no file name and no source map), and then the frame form is `eval at evaluateBundle (…), <anonymous>:line:column`: the plugin directory is recorded as bundle mode, the `filename` of such frames is fixed as `flowly-bundle.js`, `lineno`/`colno` are positions inside the bundle, and function names are kept as usual (found in the Coder end-to-end test of 2026-10-26). The eval frames of other plugins have the same form and cannot be told apart, and can only appear in uncaught exceptions, and this is accepted. Each frame has only `filename` (a path relative to the plugin directory, such as `server/service.ts`), `function` (kept only if it matches `^[\w$.<> ]{1,80}$`, otherwise `""`), `lineno`, `colno`, `in_app: true` and `platform: "node:javascript"`. The plugin directory itself and any path outside the plugin are not sent.

### 11.4 Frequency

- The same fingerprint is sent at most once per UTC day, and at most 20 events per UTC day (`MAX_ERRORS_PER_DAY`). Counting is only in memory and restarts after a daemon restart (the user preferred the simplest scheme).
- A failed send is not retried. The request times out at 10 s; a failure does not affect the caller and writes no board data.

### 11.5 Acceptance

1. Sanitizing (bundle mode): an `eval at evaluateBundle (…), <anonymous>` frame is recorded as `flowly-bundle.js`, keeping the function name and position, with no path at all.
1. Sanitizing: build a stack containing files inside the plugin (source paths and `file://` URLs), `node_modules` inside the plugin, `node:internal` and user paths outside the plugin; only the two frames inside the plugin remain, with relative paths and reversed order; the whole event has no user path and no error message (`server/error-report.test.ts`).
2. The rules of `type`, `value` and `source` are as in section 11.3; a non-`Error` is `NonError`.
3. The same error is sent only once per day; 30 different errors send only 20 events; the next day starts over.
4. Nothing is sent when the switch is off or with `DO_NOT_TRACK=1`; an uncaught exception without Flowly's own frames is not sent.
7. `paseo_version`: when obtained it is sent with the event and cached; when it cannot be obtained the first time `""` is sent, and a new value is used once it is obtained later; a thrown error in the lookup does not affect reporting (`server/error-report.test.ts`).
5. RPC wrapping: program errors of synchronous and asynchronous handlers are reported and thrown as is; a `ToolError` is only thrown and not reported; normal return values are unchanged.
6. The key set of `properties` exactly matches section 11.3, and `distinct_id` equals the `installId` of `telemetry.json`; on a fresh install multiple errors reported at the same time use the same `installId`.
8. Failures outside Flowly (`DaemonConnectionError`, `LocalDaemonUnavailable`, `SummaryModelError`) are not reported through either the RPC wrapping or `logFailure`, and the log is as usual; other background failures are reported as usual (`server/error-report.test.ts`).
