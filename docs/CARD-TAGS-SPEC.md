# Custom card tags (Tags)

Status: design confirmed by the user on 2026-10-18 (an agent cannot delete tags a person added, 12 per card, an agent changing tags does not change the task revision, the vocabulary is computed from cards); implemented. Card task `11122d9a`. For verification see [verification/card-tags.md](verification/card-tags.md).

## 1. Purpose

`type` (TASK-TYPE-SPEC) answers "what kind of work is this", with six fixed values. Tags answer "where does this work land and in what direction": a feature module (`drawer`, `session-composer`, `i18n`), an optimization direction (`performance`, `a11y`, `mobile`), a cross-cutting theme (`security`, `onboarding`). The values grow out of the project itself, and both people and agents can tag.

Principles:

- Tags are **free text + a per-project vocabulary**: no need to create a tag before using it; the vocabulary is computed from the tags already on this project's cards, to prompt reuse and avoid a flood of synonyms.
- Tags are used only for **display, filtering and search**: they change no business status, trigger no automatic action and enter no status rule.
- An agent tags **its own card** through a dedicated tool; it cannot change other cards, and cannot delete tags a person added.
- Prepared for future search: a tag is a normalized exact-match field (§7).

## 2. Data

### 2.1 Fields

`taskSchema` gains an optional field:

```
tags?: Array<{
  tag: string,                 // the normalized value (§2.2)
  by: "human" | "agent",
  agentId?: string,            // when by=agent
  at: timestamp,
}>
```

- A missing value reads as an empty array; old cards need no migration, and the board version is unchanged (same as `type`).
- Array order is display order (by order of adding). `tag` is unique within a card.
- The source is recorded for the permission rule in §4 and to tell agent-added tags apart in the UI; search and filtering look only at `tag`.
- A person editing an agent-added tag (keeping it in the form) does not change its source; if a person deletes it and adds it back, it becomes `human`.

`shared/model.ts` adds `tagLimits = { length: 32, perTask: 12, perCall: 12, suggestions: 50 }`, `normalizeTag()` and `tagSchema`.

### 2.2 Normalization

Input uses the same `normalizeTag` (`shared/tags.ts`) on the client and the server:

1. NFKC, trim leading and trailing whitespace, lowercase (`toLocaleLowerCase("en")`, independent of the device language).
2. Remove a leading `#` (convenient for pasting from the search box or a conversation).
3. Collapse runs of whitespace and `_` into `-`; merge consecutive `-`, and remove a leading or trailing `-`.
4. Allowed characters: Unicode letters and digits, `-`, `.`, `/`. Chinese and other non-Latin tags work directly (for example Chinese tags meaning "drawer" or "performance").
5. Length 1–32 (counted in characters).

Non-compliant input is an error and is not silently rewritten into another value: `Tags can only use letters, numbers, "-", "." and "/".`, `Tags can be at most 32 characters.`.

`/` is used as an optional hierarchy prefix (`module/drawer`, `perf/startup`). v1 does not interpret hierarchy, and supports prefix matching only in filtering and search (§6.4, §7).

### 2.3 Project vocabulary

Not stored separately. The server computes `{ tag, count, lastUsedAt }` from the tags of this project's **unarchived** cards, sorted by count descending and then lastUsedAt descending, taking the first 50:

- The client computes it itself from the existing etag board read, adding no RPC and no polling.
- `flowly_get_task` returns `projectTags` (the same first 50), so the agent prefers reusing existing spellings.

Renaming, merging and deleting tags are in §9 (not in v1).

### 2.4 Events and revision

- A person changing tags in the create/edit form: this is an ordinary `edited`, increasing the task revision by the existing rules.
- A person adding/removing a single tag directly in the sidebar, or an agent changing tags with the tool: **increases only the board revision, not the task revision** (same as artifacts). This way an agent tagging does not invalidate the request/revision held by other sessions on the same card, and does not conflict with an edit form that is open.
- Each actual change records one event `tags_changed`, with the note `+drawer +performance −old-tag`; the actor is human or agent (with agentId). A non-change (adding a duplicate, removing a tag that does not exist) records no event.

### 2.5 Concurrent merge

The edit form saves a whole set of tags, but an agent may have added tags after the form was opened. To avoid silently dropping them, the tags of `tasks.update` are handled with a three-way merge:

- The client submits `tags` (the final set in the form) and `tagsBase` (the set seen when the form was opened).
- Server: `result = current − (base − tags) + (tags − base)`, keeping the current order, with additions appended at the end.
- When the merge exceeds 12, reject: `A card can have at most 12 tags.`

## 3. Human RPC

| Method | Input | Behavior |
| --- | --- | --- |
| `tasks.create` | adds optional `tags: string[]` | Normalize, de-duplicate and write, source `human` |
| `tasks.update` | adds optional `tags: string[]` and `tagsBase: string[]` (must be given together) | Merge per §2.5; giving only one is a schema error |
| `tasks.tags` | `{ taskId, add?: string[], remove?: string[] }` | Add/remove a single tag from the sidebar; no task revision needed, only the board revision increases per §2.4 |

A person can delete any tag, including agent-added ones. When the card or project is archived a write is rejected: `Archived cards can't be changed.`

## 4. Agent side

### 4.1 Tool

Add the MCP tool `flowly_set_tags` (the CLI provides a matching `tags` subcommand: `tags --request-file <f> --add drawer,performance --remove old-tag`), following the existing signature request + expectedRevision protocol, idempotent, without changing the task revision:

```
{ expectedRevision, request,
  add?: string[],      // ≤ 12
  remove?: string[] }  // ≤ 12
```

- At least one of `add` and `remove` must be non-empty; the same value cannot appear on both sides.
- Normalization rules are the same as §2.2; if any value is non-compliant the whole call is rejected, with no partial write.
- Adding an existing tag again is a no-op (the source is unchanged).
- `remove` can remove only agent-added tags (any session can, since sessions on the same card share work). Removing a tag a person added is rejected: `Only the user can remove tags they added.`; removing a tag that does not exist is a no-op.
- Returns `{ receipt, tags, current }`, where `current` is like the other write tools, the refreshed get_task content.

The `task` of `flowly_get_task` carries `tags`, and a new top-level `projectTags`.

Tool description (written into the description and the skill):

> Tag this card with the functional areas it touches and the improvement directions it serves (for example a module like "drawer" or "session-composer", or a direction like "performance", "a11y", "mobile"), so the user can filter and search cards later. Tags are not the task type, status or priority; do not repeat those. Reuse a tag from projectTags in get_task when one fits instead of inventing a synonym. Use 1–4 short lowercase tags, add them once you understand the scope, and adjust them if the scope changes. You can only remove tags an agent added.

### 4.2 Session context

`sessionContext` adds `Tags: drawer, performance` after the `Task type` line (only when there are tags). An ordinary follow-up does not attach it, following the "send only the user's own text" convention.

### 4.3 Ideas

`flowly_propose_idea` gains optional `tags: string[]` (≤ 12, same normalization). When a card is created from an idea, the form is pre-filled with these tags, and after the card is created the source is `human` (the user confirmed them). `ideaSchema` gains `tags?: string[]`.

### 4.4 Skill

`skills/paseo-ultra-kanban/SKILL.md` and `server/skill-source.ts` add one item: after understanding the scope, use `flowly_set_tags` to give this card 1–4 module/direction tags, preferring to reuse `projectTags`.

## 5. Errors

| Case | Error |
| --- | --- |
| Illegal character | `Tags can only use letters, numbers, "-", "." and "/".` |
| Too long / empty | `Tags can be at most 32 characters.` / `A tag can't be empty.` |
| More than 12 | `A card can have at most 12 tags.` |
| Agent deletes a person's tag | `Only the user can remove tags they added.` |
| add and remove overlap | `A tag can't be both added and removed.` |
| Archived card | `Archived cards can't be changed.` |

Daemon and tool errors stay in English. When an illegal tag appears in storage, board validation fails but the data file is kept and not reset (same as other fields).

## 6. UI

### 6.1 Tag editor (shared by the form and the sidebar, `client/tag-input.tsx`)

After user feedback (2026-10-18, their words translated: "Why do I have to click + before I can delete?"), it became a one-line editor with no edit mode:

- Tags are shown as chips, each with a permanent × on its right (on desktop semi-transparent normally and solid when hovering the chip, always shown on touch), and clicking × deletes it.
- At the end is a dashed **+ Add tag** chip (**+ Add** when tags already exist); clicking it turns into an inline input in place and focuses it. Enter, comma or clicking a suggestion adds, and after adding the input stays open for continuous typing; Esc, Enter on empty input, or blur on empty input closes it; Backspace on an empty input deletes the last tag. On blur with uncommitted text, the input is kept and the text is not lost.
- While the input is open, suggestions are listed below: with nothing typed, "Used in this project" (the project's common tags), after typing, "Matching" (prefix matches first), at most 8.
- Input: on desktop the same height as a chip (24pt); on touch 36pt, 14pt font, vertical padding 0 (Android's default padding clips the text, phone screenshot of 2026-10-18).
- At 12 the add entry is no longer shown, and the limit is indicated. A normalization error is shown below.

In the form, this editor sits below Type, titled Tags.

### 6.2 Card

The meta row shows tags after the priority/type pills: neutral small-text chips (no icon, prefix `#`), at most 2, with the rest shown as `+N`. With no tags it takes no space. When the card is too narrow only `+N` is shown.

### 6.3 Sidebar (drawer)

Below the Status / Priority / Type buttons is one row with the tag editor (§6.1), with a tag icon at the start of the row; there is no separate edit button or edit mode. Agent-added tags carry a robot icon (accessibility label "Added by an agent"). Clicking a chip's text adds that tag to the board filter (§6.4).

Each add/remove is shown immediately (optimistic update) and saved through `tasks.tags`; when saving fails it reverts to the tags on the board and shows an error below. Success shows no toast: the chip itself is the feedback. When the card or project is archived it is read-only, with no × and no add entry; an archived card with no tags does not show this row. While the sidebar is closing (going back) it only stops responding to clicks, with the × and the add entry staying in place, to avoid chip reflow jitter.

Details & workspace gains a Tags row.

### 6.4 Filter and search

- The filter panel gains **Tags**: a multi-select of the vocabulary, showing a card on matching any (OR); an option ending in `/` (such as `module/`, appearing automatically when the vocabulary has hierarchical tags) matches by prefix. Saved in the board view setting `filterTags: string[]` (default `[]`, at most 20), counted in the filter badge, cleared by Reset filters.
- The existing search box: plain text matches the title, description and tags together; a word in the form `#drawer` matches a tag exactly, `#module/` matches by prefix, and several `#` words are ANDed.

### 6.5 Onboarding

- The welcome tour's feature page gains one sentence: "Tag cards by module or direction — agents tag their own cards too — then filter and search by tag."
- A new one-time tip `tags`: shown the first time an agent-added tag appears on the board, "Agents tag their cards by module and direction. Click a tag to filter by it."; its `nextTip` priority is after ideas. Update `client/onboarding-logic.test.ts` and the ONBOARDING-SPEC tip table; README highlights are synced.

All new copy goes into all language catalogs in `shared/i18n/`.

## 7. Future search

This spec does only local filtering inside the board, but the fields are designed for search:

- A tag is a normalized exact value, so a search index can use `tag` directly as a keyword field with no tokenization.
- Query syntax reserved: `#tag` exact, `#prefix/` prefix, `-#tag` exclude (the v1 search box implements only the first two).
- In cross-project search, aggregate by tag value, and same-named tags in different projects count as the same keyword.
- The `tags_changed` event keeps the add/remove history, usable later for "what changed recently in this module".

## 8. Where the implementation lands

- `shared/tags.ts`: `normalizeTag`, `parseTagInput` (split by comma/whitespace), `mergeTags` (§2.5), `projectTagStats`.
- `shared/model.ts`: `taskSchema.tags`, `ideaSchema.tags`, `tagLimits`.
- `shared/rpc.ts` / `server/service.ts` / `server/store.ts`: the `tasks.create/update` fields, `tasks.tags`, the event `tags_changed`.
- `shared/tools.ts` / `server/tool-server.ts` / `server/cli-source.ts`: `flowly_set_tags`, the `tags` subcommand, `get_task.projectTags`.
- `shared/scope.ts`: the Tags line of `sessionContext`.
- `shared/settings.ts`: `filterTags`.
- `client/forms.tsx`, `client/board.tsx`, `client/drawer.tsx`: §6; the new `client/tag-input.tsx` (shared by the form and the sidebar, memoized, the suggestion list computed only while typing).

## 9. Not in v1

- Project-level tag management (rename, merge, delete, bulk rewrite of all cards) and tag colors. The vocabulary is only a statistics result; if a flood of synonyms appears in use, add a management page.
- Hierarchy expansion of tags / tree filtering.
- Per-tag statistics (Insights).
- A cross-project or global search UI.

## 10. Verification

- Unit: each rule of `normalizeTag` (case, `#`, whitespace/underscore, Chinese, illegal characters, length); the `mergeTags` three-way merge (a tag an agent added after the form was opened is kept, one a person deleted is not revived); the limit; the vocabulary statistics exclude archived cards and sort correctly.
- store / service: a form edit increases the task revision; `tasks.tags` and the tool increase only the board revision; the event note and "no change records no event"; archived rejection; an illegal stored value does not reset the file.
- tool-server: `flowly_set_tags` idempotent replay, whole-call rejection with no partial write, an agent cannot delete a person's tag, add/remove overlap, the `tags` and `projectTags` of `get_task`; the CLI `tags` subcommand.
- `sessionContext` contains the Tags line when there are only tags; ideas carry tags and pre-fill the new-card form.
- Settings: `filterTags` default `[]`, the limit; board filter OR and prefix; search `#tag` AND.
- onboarding-logic: the `tags` tip rule.
- typecheck, full `npm test`; per AGENTS.md use a full-access `codex/gpt-6-luna` session for post-install tool and UI acceptance, with results recorded in `docs/verification/card-tags.md`.
