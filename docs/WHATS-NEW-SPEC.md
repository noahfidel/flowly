# What's new window after an update

Status: **implemented, ships with 1.6.0** (design confirmed 2026-10-22, history paging added 2026-10-24 per W4, changed to left/right paging on 2026-10-26 per W5, ships with 1.7.0; §13) (card "Pop up a 'What's new' notice after a plugin update", follow-up of "Redesign the onboarding flow").

## 1. Purpose

ONBOARDING-SETUP-SPEC D7 decided that existing users are not shown the new tour automatically, so existing users do not see the settings the tour added: the global switches of Memory / Insights, and Progress / Next moves / Ideas for external sessions (D3: kept off for people who did not go through the new tour). A one-time tip (ONBOARDING-SPEC §5) can only say one sentence when a scene appears, and is not suited to explaining a version's changes in one go.

This feature: after a plugin upgrade, the first time an existing user opens the board, a short window pops up that lists the changes in this version that **existing users cannot discover themselves**, one sentence each, optionally with a button (open settings / see the tour again), closable in one click, shown only once per version.

Anti-goals: the full changelog (a matter for the README / release notes); popping up for every version; interrupting new users; adding polling or server state for it.

## 2. When it pops up

On the board full-screen page (not inside a workspace panel), it pops up when **all** conditions are met:

1. The onboarding settings are loaded (`ready`) and the board is loaded;
2. `welcomeSeen = true` (an existing user. Someone with `welcomeSeen = false` either sees the first tour right away or is silently marked as an existing user right away, and is judged again at the next render);
3. The entry table has an entry with a version **greater than** `whatsNewSeen` (a version with no entry → no popup);
4. Nothing is blocking: no other dialog, open card, tour, or the tip bubble next to the settings button. When blocked it waits, and pops up after the blocking thing is closed.

When the settings fail to load or are invalid it does not pop up (a silent failure, consistent with the tour).

**New users do not get it**: when the first tour (the automatically popped-up one) is closed in any way, `welcomeSeen = true` and `whatsNewSeen = the latest entry's version` are saved **in the same write**. The tour already covered these settings, so a new user does not see them again right after the tour. Opening the tour manually does not write `whatsNewSeen`.

**Silently marked existing users** (ONBOARDING-SPEC §1, with projects but `welcomeSeen = false`, meaning an old version without a tour was installed): after marking, `welcomeSeen = true` and `whatsNewSeen` is still empty, so they see What's new. This is right: they are exactly the people to be told.

## 3. Shown only once

- A new host setting field `onboarding.whatsNewSeen: string` (default `""`, max 20) stores the version last seen.
- When the window is **closed in any way** (Got it, Esc, clicking the scrim, clicking an entry button) it writes `whatsNewSeen = the latest entry's version in the window`. Like other `useOnboarding` writes: shown optimistically, merged and retried on a version conflict. When the write fails the window pops up again the next time the board opens (acceptable).
- Version comparison is numeric by `major.minor.patch` (`1.10.0 > 1.9.0`); `""` is less than everything.
- The setting is stored per host, so a second device also gets it once (consistent with the tour, accepted).

## 4. History versions: latest by default, can page back to 1.5.0 (user decision 2026-10-24, replaces W2)

The entry table is a **list of versions, newest first**, down to **1.5.0**, and earlier ones are not included (W4).

- The automatic popup looks only at the **latest version that has entries** (`latestRelease`): it pops up only if it is newer than `whatsNewSeen`; on close it records its version. Pages of old versions do not make the window pop up again.
- The window always opens on the latest version's page. There is an arrow on each side of the version number: ‹ pages to an older version, › pages to a newer version, and at the end the matching arrow turns gray (W5). Paging does not change `whatsNewSeen`.
- Upgrading across versions (1.5 → 1.8): it opens automatically on the 1.8 page, and the user can page back to see 1.7, 1.6, ….
- When a minor or major version (x.Y.0, X.0.0) is released, an item is added at the front of the list; a patch version (x.y.Z) does not add one (user decision 2026-10-27); old version entries are kept (no longer "new overwrites old"). At most 7 entries per version (`WHATS_NEW_MAX_ITEMS`), to keep a page from being too long.

## 5. The window

- A plugin `Modal` (the same component and the same entrance motion as the tour), titled "What's new", title icon `FlowlyMark`, the same component on desktop and phone, max width ~440.
- One row per entry: an icon (`Icon`) + one sentence (md), and on the right an optional button (a secondary button in `Chip` style); on a narrow screen the button moves below the text.
- The line under the title is "‹ Flowly {version} ›" (the entry table's version with the trailing `.0` removed; with only one version there are no arrows).
- The footer has only one primary button **Got it**.
- Entry button: first closes the window (recorded as seen), waits about 450 ms (`useAfterModalClose`, so two Modals do not switch in the same frame), then performs the action:
  - `settings`: opens the given page of Settings (`openSettingsAt(section)`);
  - `tour`: opens the welcome tour manually (not first-time mode, writes no external session draft).
- While open, the tip banner is not shown; after it closes, tips appear as usual by priority.

### 5.0 Paging (§4, W5)

The version row: `[‹] Flowly 1.7 [›]`, the same form as the date paging of the Insights daily summary (`IconButton` ChevronLeft / ChevronRight, accessibility labels "Older release" / "Newer release"). The left arrow pages to an older version and the right arrow to a newer version; on the oldest / newest page the matching arrow is disabled. When paging, the entries slide in from the paging direction (`Enter`, horizontal 16 pt: paging to older enters from the left, paging to newer enters from the right; no displacement under Reduce Motion); the first page when the window opens does not slide. Each open returns to the latest page. The footer has only **Got it**.

### 5.1 Opening again (user decision 2026-10-22)

Add a row **What's new** to the Settings → General → Welcome tour group (shown only when there are entries): like "Show welcome tour", it first closes Settings and opens the same window after about 450 ms; when opened manually, if `whatsNewSeen` is already the latest it is unchanged, otherwise it is likewise recorded as seen.

## 6. Entry table

Pure data goes in `client/whats-new.ts` (without React); the copy is marked with `msg()` and `t()` at render, and goes into all 9 language catalogs:

```ts
export interface WhatsNewItem { icon: string; text: string; action?: { label: string; to: "settings"; section: SettingsSection } | { label: string; to: "tour" } | { label: string; to: "auto-review" } }
export const whatsNew: { version: string; items: WhatsNewItem[] }[] = [ /* newest first, earliest 1.5.0 */ ];
```

Write the version number as **the version that ships these changes**. An entry writes a user-visible new feature or change of this version, one sentence each; what can be switched or adjusted in settings gets **Open settings** (landing on the matching settings page), and tour-related ones get **Take the tour**.

### 1.8.0

| Icon | Copy | Button |
| --- | --- | --- |
| `Search` | Search past cards, summaries, notes, Workpads, ideas and deliverables; agents can search too ([SEARCH-SPEC](SEARCH-SPEC.md) §8) | — |
| `ShieldCheck` | Auto review checks every delivery before it reaches you and sends it back to the agent when it falls short. On for new projects. ([GUARDRAILS-SPEC](GUARDRAILS-SPEC.md) §10) | **Turn on for this project** (`to: "auto-review"`: the current project's Edit project, with the Auto review block at the top and the switch already on; after saving, the daemon recognizes the commands; replaces AUTO-REVIEW-SPEC's `review-analysis`) |
| `Undo2` | Flowly learns from what you send cards back for: the second card with the same problem turns it into a project guideline, checked on every delivery it applies to. | — |
| `BookMarked` | Memory no longer needs confirming; what agents remember takes effect at once and retires by itself when unused. | — |

### 1.7.0 (v1.6.0..v1.7.0, all updates in [release-notes/v1.7.0](release-notes/v1.7.0.md))

| Icon | Copy | Button |
| --- | --- | --- |
| `CalendarDays` | Insights redesign: a year of activity, daily summaries you can page through day by day, and the process of each completed card (review rounds, waiting, tokens) ([INSIGHTS-REDESIGN-SPEC](INSIGHTS-REDESIGN-SPEC.md)) | — |
| `Sparkles` | Insights drafts skills from cards, and they are added to the project only with your consent; on by default, can be turned off in settings | Open settings → AI features |
| `Gauge` | The board opens and refreshes faster, especially noticeable on phones: it reads only the overview and the open card ([LOADING-R2-SPEC](LOADING-R2-SPEC.md)) | — |
| `MonitorSmartphone` | Settings are full screen on phones; Settings → Cards can turn off the shimmer animation | Open settings → Cards |
| `Database` | When Paseo supports it, the board is stored in a local SQLite database and backed up daily; Settings → Storage can restore a backup or export as JSON ([SQLITE-STORAGE-SPEC](SQLITE-STORAGE-SPEC.md)) | Open settings → Storage |
| `Activity` | Anonymous usage data: once a day the version, enabled features and usage counts; on errors only the location in Flowly code is reported; can be turned off in settings ([TELEMETRY-SPEC](TELEMETRY-SPEC.md)) | Open settings → General |

### 1.6.0 (the user confirmed releasing 1.6.0 on 2026-10-24; the part of v1.5.0..main already merged)

| Icon | Copy | Button |
| --- | --- | --- |
| `Brain` | Project memory: decisions and pitfalls confirmed on one card are carried into the sessions of later cards, and completed cards can propose new ones | — |
| `SlidersHorizontal` | Project memory and Insights each have a switch that applies to all projects | Open settings → AI features |
| `MessagesSquare` | Progress / suggested next steps / Ideas also work for non-Flowly sessions; off for existing users, and when on, a summary model runs once per turn | Open settings → AI features |
| `ListOrdered` | Several summary models can be chosen with a fallback priority | Open settings → Models |
| `ShieldCheck` | New sessions can start with a default permission mode (global or per project) | Open settings → Models |
| `PlugZap` | Azure DevOps work items can be card inputs | Open settings → Connections |
| `CircleHelp` | The welcome tour can set the language and AI features in one place | Take the tour |

### 1.5.0 (v1.4.0..v1.5.0)

| Icon | Copy | Button |
| --- | --- | --- |
| `Activity` | Workflow insights (must be turned on): from the commands agents ran, it suggests scripts, preparation steps and rules worth keeping | Open settings → AI features |
| `Sparkles` | One AI output language decides the language of everything the AI writes | Open settings → AI features |
| `ListChecks` | The agent first sets the card's type, tags and workpad before starting work | — |
| `GitPullRequest` | The agent can add its own PR to the card's outputs, and new review comments are marked unread | — |
| `FileText` | Card descriptions are shown as Markdown | — |

## 7. Decision logic (pure functions, `client/onboarding-logic.ts` or `client/whats-new.ts`)

- `compareVersions(a, b)`.
- `whatsNewDecision({ settingsStatus, boardLoaded, welcomeSeen, whatsNewSeen, release, blocked })` → `"wait" | "show" | "none"`: not ready → wait; `!welcomeSeen` → none; no entry or `release.version ≤ whatsNewSeen` → none; blocked → wait; otherwise show.
- `whatsNewVersion(release)`: the version written when the first tour closes and when the window closes; `""` when there is no entry.
- `latestRelease`: the first version in the list that has entries, passed to the two functions above; `stepRelease(index, ±1, count)`: paging, stopping at both ends.

## 8. Data contract

- `onboardingSettings` in `shared/settings.ts` adds `whatsNewSeen: z.string().max(20).default("")`; the schema version is unchanged (`onboardingSettingsValues()` already fills in defaults, and old data reads as `""`).
- No board, RPC, tool, skill or daemon changes; agent-facing text is unchanged.

## 9. Onboarding upkeep rule (one more item for AGENTS.md "Onboarding upkeep")

When releasing a minor or major version that contains user-visible changes that **existing users will not run into themselves in use** (a new setting, a switch whose default differs for existing users, an entry point that moved), add an entry for that version in `client/whats-new.ts` (≤ 7 items, one sentence each), at the front of the list (old versions are kept, down to 1.5.0). A feature that can be met naturally in some scene still uses a one-time tip and does not go into What's new. A patch version (x.y.Z) never adds an entry (user decision 2026-10-27). When neither is needed, say so in the delivery note.

## 10. Acceptance

- Unit (`client/onboarding-logic.test.ts` or `client/whats-new.test.ts`):
  - **Shown only once**: `whatsNewSeen` equal to the latest version → none; the version written on close = the latest entry.
  - **No entry, no popup**: the entry table is empty, or the latest entry ≤ `whatsNewSeen` → none.
  - **New users do not get it**: `welcomeSeen = false` → none; the patch from closing the first tour contains both `welcomeSeen` and the latest version.
  - Version comparison `1.10.0 > 1.9.0`; blocked → wait; settings not ready → wait.
  - The entry table itself: the version format is valid, newest first and strictly decreasing, the oldest is 1.5.0, 1–7 entries per version, each copy is non-empty.
  - Only the latest version decides the automatic popup; paging stops at both ends.
- i18n completeness (`npm test`).
- `npm run typecheck` and `npm test` pass.
- Real UI (reload the plugin, screenshots with `docs/promo/shot-lib.mjs`, desktop + narrow screen): with this machine's `whatsNewSeen` at `""` → pops up once; after Got it, re-entering the board does not pop up again; Settings → General → What's new can open it again; "Open settings" lands on AI features; "Take the tour" opens the tour without freezing. Evidence goes in `docs/verification/`.

## 11. Doc sync

ONBOARDING-SPEC (a new section pointing to this spec; the data contract adds the field), ONBOARDING-SETUP-SPEC D7 ("raised as a separate idea" → point to this spec), AGENTS.md Onboarding upkeep, PROGRESS.md, SPEC-OUTLINE.md.

## 12. Decisions I made (can be overturned)

1. **Use the entry table's version number, not the running plugin version**. Entries ship with the code, and what is in the table is already released; there is no need to bundle `package.json` into the client, and a patch version with no entry will not cause a wrong popup. Cost: an entry's version number must match the release number: it decides whether it pops up automatically and is stored into `whatsNewSeen` on close. If it is written higher than the actual release number, later entries for those versions will no longer pop up automatically, so check before release. A host that reloads the dev build locally before release records this version early, which affects only the dev machine (it can be reopened from settings).
2. ~~When crossing versions, list all unseen versions~~ → the user changed it to show only the latest version (§4).
3. Entry buttons only open settings or the tour, and do not switch features on or off directly in the window.
4. Silently marked old-version existing users also see What's new.
5. A new user is recorded as having seen the latest version when the first tour closes.

## 13. User decisions (2026-10-22)

| # | Decision |
| --- | --- |
| W1 | Can be opened again after closing: Settings → General gets a What's new row (§5.1). |
| W2 | When upgrading across versions, show only the latest version, new overwriting old (§4). I pointed out that settings changes in the intermediate versions would be missed, and the user still chose this. |
| W3 | The first entry is first done as 1.5.0 as a demo to see the effect (§6); the entry content follows the 3 items of §6. Void from 2026-10-24: 1.6.0 is officially released, with its entries in §6. |
| W4 | 2026-10-24: What's new can show history versions, shows the latest by default, can page to older versions, starting from v1.5.0, with earlier ones not handled (§4, replaces W2). |
| W5 | 2026-10-26 (card "v1.7.0 release"): navigation changes to paging left/right directly to see each version's changelog: the ‹ › on both sides of the version number replace the footer's version button (§5.0). |
