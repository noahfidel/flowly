# Search

Status: **reviewed and approved by the user on 2026-10-27, implemented**. Card "Search feature". The direction the user confirmed on 2026-10-27: v1 scans in daemon memory; it searches cards, summaries, agent notes, workpads, ideas, deliverables and project memory; the default is the current project; an agent tool `flowly_search` is provided too.

## 1. Decisions

| Question | Decision | Reason |
|---|---|---|
| Where to search | In the daemon. The client only sends the query and receives the results. | After loading optimization R2 the client no longer holds the full board (LOADING-R2-SPEC), and a phone should not download history (PERFORMANCE-SPEC). |
| What to search with | Scan the data in daemon memory; no disk index, no table changes. | The daemon already caches the whole board (SQLITE-STORAGE-SPEC §5); `summaries.json` and `memory.json` are cached by search by file modification time and size, and re-read only when changed. The in-memory search text is rebuilt by the board revision and the stamps of the two files. Measured on the user's real data on 2026-10-26: about 5.6k records, one full scan takes about 1 ms. |
| No FTS5 | Left to phase two (§10). | Summaries and memory are not in SQLite; trigram tokenization needs keywords of at least 3 characters, so the common two-character Chinese words (for example the words for "search" and "migration") cannot use the index and would still fall back to record-by-record comparison. FTS5 has been verified to work in the Paseo Helper (Node 24.20 / SQLite 3.53.4). |
| Default scope | The current project; switchable to all projects. | |
| What an agent can search | Only its own project, excluding its own card and excluding project memory (memory uses `flowly_recall`). | The two tools each do one thing and do not return duplicates. |

## 2. Search sources

Each source produces some "documents". A hit belongs to one card (except project memory).

| Source `source` | Taken from | Fields searched | Weight |
|---|---|---|---|
| `card` | `tasks` | title, description, tags, type | title 6, tags 5, description 3, type 1 |
| `summary` | `summaries.json`, only the **latest version** per card | state, target, recap, next | 4 |
| `note` | records in `events` that are `status_changed` and `progress_reported` with a non-empty `note` (both people and agents count) | note | 2 |
| `workpad` | `workpads` | acceptance items, the description/command/evidence of checks, questions | 2 |
| `idea` | `ideas`, all statuses (open / accepted / dismissed) | title, detail, rationale, context | title 4, the rest 2 |
| `artifact` | `artifacts` | title, note, target (link or path), the key of an external item (an external item's title is the deliverable title) | 3 |
| `memory` | `memory.json`, only `active` | title, body, keywords, tags | 4 |

Ideas and deliverables follow the Ideas and Artifacts switches in Settings respectively, and are not searched when switched off; project memory is not searched when it is off globally or off for that project.

Not searched: session transcripts (they belong to Paseo, which has no search interface), `agentReceipts`, system events (`workspace_auto_archived` and so on), old summary versions, candidate/dismissed/archived memory, backups in `removed/`, archived projects.

Card scope: all cards in the project, including Done, Cancelled and archived cards (ranked lower, §3.3).

## 3. Query and results

### 3.1 Query syntax

- Empty after trimming whitespace: return an empty result, no error. At most 200 characters.
- `#tag` filters by the board's existing rules (reusing `parseTagSearch`/`tagMatches` of `shared/tags.ts`, the prefix `module/` counts too): keep only cards carrying those tags; memory is filtered by its own tags.
- The rest is split into words by whitespace; `"a phrase with spaces"` counts as one word.
- A card is selected when: **every word** appears in some document of that card (they may be spread across different sources). A memory entry is judged individually.
- Comparison is case-insensitive, and full-width and half-width ASCII characters are treated as the same. Pure substring matching, no word segmentation and no synonyms.

### 3.2 Hit snippets

- Each field containing at least one word counts as one hit. At most 3 hits are returned per card, chosen by weight and then by time (newest first).
- A snippet takes the original text, centered on the first matching word, about 40 characters before and after, total length at most 160 characters; a truncated end gets `…`. Line breaks are squeezed into spaces.
- `ranges` gives the position of each matching word in the snippet (`[start, end)`, by UTF-16 index), which the client uses to make them bold.

### 3.3 Sorting

Cards are compared in this order:

1. The highest hit weight (larger first).
2. Card status: unfinished (not Done/Cancelled and not archived) first, then Done/Cancelled, last archived.
3. The most recent activity time (the newest of the card's `updatedAt` and the times of its hit documents, newest first).

Memory entries form a separate group, after the cards, sorted by weight and then by `confirmedAt`.

### 3.4 Count

- By default at most 30 cards, with a cap of 50; at most 10 memory entries. When exceeded, `truncated: true`.
- The first version has no paging: when there are too many results, ask the user to add words.

## 4. RPC: `search.query`

An ordinary request-response, read-only, no polling.

```ts
input = {
  query: string,                 // ≤200
  projectId: string | null,      // null = all unarchived projects
  sources?: Source[],            // omitted or empty = all; Source = "card"|"summary"|"note"|"workpad"|"idea"|"artifact"|"memory"
  limit?: number,                // 1–50, default 30
}
output = {
  cards: Array<{
    taskId, projectId, projectTitle, workspaceId,
    title, status, type?, archived: boolean, updatedAt,
    hits: Array<{ source, refId?, field, snippet, ranges: [number, number][], at?, status? }>,  // ≤3; status only for idea
  }>,
  memory: Array<{ id, projectId, kind, title, snippet, ranges }>,                    // ≤10
  truncated: boolean,
  partial: Array<"summaries" | "memory">,   // these files could not be read this time, and the result lacks them
}
```

- `refId`: the id of the idea, artifact or event; `field`: the name of the matching field (such as `title`, `recap`, `evidence`), for the client to label the source.
- `projectId` pointing to a project that does not exist or is archived: error `Project not found.` (the same ordinary error as the other board RPCs).
- Input that does not fit the structure above (query over 200 characters, `limit` out of range, unknown `source`): RPC input validation fails.
- When the board cannot be read (`STORAGE_BUSY` and so on), the error is returned as is, consistent with the other board RPCs.
- When `summaries.json` or `memory.json` cannot be read, **no error**: the other sources return as usual, and `partial` says which one is missing.

## 5. UI

### 5.1 Entry

- **Search page**: like Ideas, Insights and Guardrails, once opened it replaces the board area (`page = "search"`), the same on desktop and phone.
- Ways to open:
  - The desktop header gains a search icon button (the `Search` icon, accessibility label `Search (S)`), next to the filter button.
  - The shortcut `S` (the blocking conditions of SHORTCUTS-SPEC §2.1 as before). `⌘K` is not used: combinations with Cmd/Ctrl are left to the host by convention.
  - No Command Center entry (QUICK-TASK-SPEC §7); the intent `search` as a screen param is still valid (the contract of SHORTCUTS-SPEC §2.4).
  - Phone: the same header search icon (the compact layout's header already has a filter button, and it sits next to it).
  - When text has been typed in the board filter popover, an extra row **Search everywhere** appears, and clicking it opens the Search page with that text.
- Pressing the icon again or `Esc` closes it and returns to the board.

### 5.2 Page

- Top: the search box (`TextBox`, auto-focused on open, `commitDelay` 250 ms), and to its right a scope toggle **This project / All projects**.
- Below it a row of source filters: Cards, Summaries, Notes, Workpads, Ideas, Deliverables, Memory (changed back to Memory on 2026-10-29, GUARDRAILS-SPEC §7.4 D10), multi-select; selecting none equals selecting all.
- Result list:
  - Card row: title, lane name, type; with all projects add the project name; an archived card is marked Archived.
  - Below the card row are the hit rows (a hit on the card title itself no longer gets its own row, since the title is already on the card row): the source name (Summary / Note / Workpad / Idea / Deliverable) + the snippet, with the matching words in bold and the theme accent color. An Idea hit carries its status (Dismissed and so on).
  - Memory is a separate group, with the group title Memory; clicking a result opens that project's Memory page.
- States: with an empty query nothing is shown; with no results show **No results**; when the cards reach the cap and `truncated`, one line **Showing the first 30 cards** at the end of the list (not shown when only memory is truncated); with `partial`, one line at the top **Summaries could not be read** / **Memory could not be read**. No explanatory text is added.
- The scope and source filters are remembered only for this opening; the query text is not persisted.
- Animation: while a request is in progress the old results stay and fade to half transparency (about 120 ms); each time new results arrive, the whole result list fades in and moves up slightly (shared `Enter`, about 220 ms). The selected state of filter items changes immediately. With system Reduce Motion on, none of these animate.

### 5.3 Clicking

- Card row: opens this card's sidebar. When the card is in another project, switch to that project first (reusing the opening path of card links, `client/session-link.ts`).
- Hit row: also opens the sidebar, then positions to the matching entry (DRAWER-SPEC "Focus from search"):

  | Hit source | Section | Positions to |
  |---|---|---|
  | `summary` | Progress | the section itself (there is only one latest summary) |
  | `note` | Activity | that event |
  | `workpad` | Workpad | that acceptance item, check or question (`refId` is the item id) |
  | `idea` | Ideas | that idea; a closed idea first expands "Closed" |
  | `artifact` | Artifacts | that deliverable |
  | `card` | none | only opens the sidebar (the description is right at the top) |

  Within the positioned entry, the matching words themselves get an accent-color background and a bold accent color (the whole entry is no longer outlined), kept until the sidebar closes; when the hit is in a truncated or folded part, that entry is expanded (notes without a line limit, checks showing the full command and output, summaries and ideas opening Show more, deliverables showing the full link or path, items 6 and 7 of DRAWER-SPEC "Focus from search").

  The section is expanded only for this opening and does not change the user's saved expansion preference. When the target is outside the currently shown range (Activity lists only the latest 12, Workpad/Artifacts are paged), first extend the range to it; if it has not rendered within 1.5 seconds, fall back to the section itself. After scrolling to the target, when there is no word to mark (a card field hit, a fall back to the section) give it an accent-color outline for about 1.6 seconds; with system Reduce Motion on, jump directly with no scroll animation.
- Memory row: opens the Guardrails page.
- The Search page stays open, and the results are still there after closing the sidebar.

### 5.4 Requests and performance

- A request is sent 250 ms after typing stops; when a new request is sent, the result of the old request is discarded (react-query uses `[projectId, query, sources]` as the key, keeping the previous page of results until the new results arrive).
- No polling and no refresh in the background; reopening the Search page queries once again.
- One response is at most 50 cards × 3 snippets × 160 characters, within a few tens of KB.
- The Search page component and result rows are `React.memo`; the page unmounts when closed and leaves no subscription.

## 6. Agent tool: `flowly_search`

Read-only, needs only the identity, no `request`, and changes no card status or revision.

```ts
input = {
  query: string,           // 1–200, syntax as §3.1
  sources?: Source[],      // without "memory"
  limit?: number,          // 1–20, default 10
}
output = {
  cards: Array<{
    taskId, title, status, type?, tags: string[], archived: boolean, updatedAt,
    summary?: string,      // state + recap of the latest summary, at most 400 characters
    hits: Array<{ source, snippet }>,   // ≤3, same as §3.2
  }>,
  truncated: boolean,
}
```

- Scope: the project of the caller's card; excluding the caller's own card.
- It carries the latest summary because an agent has no tool to read other cards, and a snippet plus the summary is usually enough to judge whether to refer to that card.
- Tool description (English):
  > Search earlier cards in this project: their titles, descriptions, summaries, progress notes, workpads, ideas and deliverables (PR links, Jira keys, file paths). Use it when you start on an area to find related or duplicate work and how it was verified. Project memory is not included; use flowly_recall for it. Read-only; no request needed.
- CLI: `search --query <words> [--sources a,b] [--limit n]` (no request file needed); HTTP `/api` gains a `"search"` read action.
- The skill text (the SKILL.md generated by `server/skill-source.ts`) adds one sentence in Details after the `flowly_recall` item:
  > Use flowly_search to find earlier cards in this project (summaries, notes, workpads, ideas, deliverables) when you start on an area or before proposing an idea that may already exist.
- Not added to turnChecklist, and not hinted in get_task.

## 7. Privacy

- Search runs entirely in the local daemon. Logs record only the duration and the result count, not the query content.
- No new usage data field is added.
- An agent can read the notes and snippets of other cards in the same project through `flowly_search`; this is the same project scope as the links and ideas it sees in get_task today, and does not cross projects.

## 8. New user onboarding and copy

- One-time tip `search`: appears once when the current project has more than 10 unarchived cards and no card is open, ranked after card-display. Copy: *Find past cards, notes, workpads and deliverables with the search button or S.*
- The More features list on the last page of the welcome tour gains an item: *Search past cards, summaries, notes and deliverables.*
- The What's new entry for the new version: *Search past cards, summaries, notes, workpads, ideas and deliverables. Agents can search them too.*
- The README highlights gain a line. All new copy is added to all language catalogs (I18N-SPEC); agent-side text stays English.

## 9. Errors

| Case | Result |
|---|---|
| Empty query | Empty result, no error |
| Query over 200 characters, `limit` out of range, unknown `source` | RPC input validation fails; the agent tool returns `INVALID_INPUT` |
| `projectId` does not exist or is archived | `Project not found.` |
| Board storage unavailable | The storage error is returned as is (`STORAGE_BUSY` and so on) |
| The summaries or memory file cannot be read | No error, `partial` marks it |
| Agent tool: invalid identity | The same error as the other `flowly_*` read tools |

## 10. Not in v1

- An FTS5 index. Open a separate card when either happens: the daemon no longer caches the whole board; or a single search exceeds 50 ms on real data. Then use the same database, build a trigram FTS5 table updated in the write transaction together with the changed rows, with 1–2 character words going through record-by-record comparison.
- Searching session transcripts, paging, advanced syntax (`type:`, `status:`, dates), saved searches.

## 11. Acceptance

**Implementer self-test** (before delivery): `npm run typecheck`, `npm test`, and the following focused tests:

1. Every source can hit its own fields; content that is not searched (receipts, system events, old summary versions, non-active memory, archived projects) does not appear.
2. Multiple words spread across different sources of the same card can hit; a missing word means no hit; a quoted phrase matches as a whole; `#tag` and prefix filtering are consistent with the board.
3. Case and full-width/half-width ASCII are treated as the same; Chinese words of one character and two characters can both hit.
4. A snippet is at most 160 characters, `ranges` point at the matching words in the snippet; at most 3 hits per card.
5. Sorting: weight → unfinished/finished/archived → time; memory after the cards.
6. `limit` and `truncated`; `projectId: null` crosses projects and excludes archived projects; an unknown or archived project reports `Project not found.`; illegal input is rejected.
7. When the summaries or memory file is corrupt, the other results return as usual, with `partial` correct.
8. `flowly_search`: searches only this project, excludes its own card, has no memory, carries the latest summary within 400 characters; the CLI `search` and HTTP `"search"` return the same result.
9. Performance: on synthetic data scaling the user's data up 10 times (about 50k events), a single daemon search takes at most 50 ms.
10. The new tip's rule is covered in `client/onboarding-logic.test.ts`; the i18n test passes.

**Real UI test** (per AGENTS.md using `docs/promo/shot-lib.mjs`, on the Tinylink demo project): on desktop and compact layouts open the Search page, type, switch scope, filter sources, open a card (including across projects), the `S` shortcut, Esc to close. Evidence goes in `docs/verification/search-<date>/`.

**Independent milestone acceptance** (before merge, run by a `claude/claude-haiku-5-5` session that did not write the code): rerun the checks above on the implementation commit.
