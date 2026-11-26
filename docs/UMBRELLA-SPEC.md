# Umbrellas: one brief, contract and decisions feed for a family of cards

Status: **approved by Noah, 2026-11-25 (rulings D1-D23 in §16).** Nothing here is built yet. Contract only; progress goes to `docs/PROGRESS.md`. Amends `docs/CARD-LINKS-SPEC.md` §9 (membership only, ruling D13), `docs/DISPATCHER-SPEC.md` §5.8 (relay targets, and Flowly now tells member agents the `[contract]` rule) and `docs/PROJECT-MEMORY-SPEC.md` (a second, umbrella-scoped feed).

An **umbrella** is a named body of work inside one board group: a title, a brief every member card reads, a contract (the handoff shapes between members), a feed of decisions, findings and open questions, an acceptance list for the whole scope, an optional Linear project, and its member cards. A card belongs to at most one umbrella. Membership is a shared context, not a hierarchy: an umbrella never moves, starts, blocks, finishes or wraps up a card.

Vocabulary: *umbrella* (this object; the UI word, ruling D1), *member* (a card in it), *sibling* (another member of the same umbrella), *brief* (the shared goal document), *contract* (the handoff shapes section), *feed* (the umbrella's entries, §2.3), *integration card* (the member that runs the umbrella's end-to-end check, §11). "Epic" stays the Shortcut connector item type (`CONNECTORS-SPEC` §15) and "group" stays a board group (`BOARD-GROUPS-SPEC`).

## 0. Why

Two real families need it.

- **Harness on Flowly (light-version trial, 2026-11-18).** Run with what Flowly had: a shared tag, `related` links, a hand-kept charter file attached to each card as an input, cross-card decisions saved as tagged project memory, and the dispatcher's `[contract]` relay (DISPATCHER-SPEC §5.8, charter v7). What went wrong:
  1. The pieces were folded into one card, so there were no siblings to link or relay between; nothing in Flowly suggested the family shape.
  2. The `verify` piece lived in another project (the harness), so the `related` link was refused (same-project only, `CARD-LINKS-SPEC` §2.3) and the relay, which only follows `related` links, could not reach it.
  3. Agents learned the `[contract]` marker only from the charter file; a card without the input never marked anything.
  4. The charter was a file outside every repo: no revision, no "changed since you last read it", no single owner; it was never found again after the trial.
  5. Decisions went into project memory, which every card in the repo competes for (8 entries, 2,400 characters, scored by words and tags), so a family decision could be crowded out on a sibling, and showed up on unrelated cards.
  6. The relay's memory of what it already relayed is in-memory only and is lost on reload.
- **Zenlytic "Context that stays fresh" (Linear project P-ZEN-391, a 6-week Shape Up pitch).** ZEN-9283, ZEN-9284 and coming cards (a correction detector, real PRs from suggestions). Rulings and ideas made on one card do not reach the next card's agent unless copied into project memory (repo-wide, not this scope), and there is nowhere to keep the brief: goal, pitch link, decisions so far, open follow-ups.

What an umbrella adds over links and tags: a shared, versioned document with unread tracking; a scoped feed that every member reads in full; an explicit contract-change step; membership the dispatcher can compute from instead of guessing; and a place on the board to see the whole scope.

## 1. Decisions taken by this spec (routine)

These are implementation choices inside the requested scope. Product rules are the rulings in §16.

- **R1: stored on the board.** Umbrellas and feed entries are new board collections (`umbrellas`, `umbrellaEntries`) with `.default([])`, so the SQLite store keeps them with no schema bump (`collectionsOf`).
- **R2: membership lives on the card** (`task.umbrella`), not as links, so "at most one umbrella" is a field and not a constraint across rows.
- **R3: one read for agents.** `flowly_get_task` gains one `umbrella` block (§3); an agent needs no extra call to see the brief, contract, feed and siblings.
- **R4: unread by what was shown.** The artifact read mark (one timestamp per session, set only when a card has artifacts) is not enough: it would never be set on a member without artifacts, and it would mark entries left out by the budget as read. A separate store, `umbrella-reads.json` (outside the board, like `artifact-reads.json`), keeps per session and umbrella the brief and contract revisions last returned in full and the ids of feed entries actually returned. It is written whenever `get_task` returns a non-null `umbrella`.
- **R5: nothing is relayed that a card asks.** Questions, permission requests and blockers never cross to siblings, through the feed or the dispatcher (DISPATCHER-SPEC §5.5 invariant). An open question in the feed is an *umbrella-level* question raised for the user, not a card's ask (§2.3).
- **R6: Flowly only reads Linear.** A Linear project link is read through the connector; Flowly never writes to it (§10).

## 2. Model

### 2.1 Umbrella

```ts
Umbrella {
  id: string;
  groupId: string;              // board group it lives in (D2)
  title: string;                // 1-120
  brief: { text: string; revision: number; updatedAt: string; updatedBy: Actor; source?: string };
                                // markdown ≤ 20,000; source = optional link/path the user keeps it in (D4)
  contract: { text: string; revision: number; updatedAt: string; updatedBy: Actor };
                                // markdown ≤ 10,000: handoff shapes between members
  acceptance: { id: string; text: string; done: boolean; by: Actor; at: string }[];  // ≤ 20, each ≤ 300
  integrationTaskId?: string;   // the member that runs the end-to-end check (§11)
  linearProject?: { url: string; key?: string; name?: string };  // read-only reference (§10)
  status: "open" | "closed";    // closed by the user only (§11)
  createdBy: Actor; createdAt: string; updatedAt: string;
  revision: number;             // bumped by the user's and the dispatcher's edits; checked by umbrellas.update
  feedRevision: number;         // bumped by every feed write (agent or user); never checked, so an agent entry never refuses a panel edit
  operationId?: string;         // the creating agent's idempotency key digest (flowly_create_umbrella replay)
  archivedAt: string | null;
}
Actor = { kind: "human" } | { kind: "agent"; agentId: string; taskId?: string } | { kind: "dispatcher"; agentId: string }
```

### 2.2 Membership (on the card)

```ts
task.umbrella?: { id: string; role?: string /* ≤ 40, e.g. "feature map" */; order?: number; joinedAt: string; by: Actor }
```

`role` is the member's owned pipeline stage ("feature map → harness verification → evidence gallery → Linear comment"); `order` sorts the pipeline. A card in another group than its umbrella is refused (`UMBRELLA_OUT_OF_GROUP`), and an archived card cannot join one (`ARCHIVED`); a project moved to another group drops its cards' membership after a confirm that names the umbrellas affected (§9).

### 2.3 Feed entries

```ts
UmbrellaEntry {
  id: string; umbrellaId: string;
  kind: "decision" | "ruling" | "finding" | "convention" | "pitfall" | "question" | "contract_change";
  title: string;                // ≤ 120
  body: string;                 // ≤ 2,000
  status: "active" | "superseded" | "open" | "answered" | "proposed" | "accepted" | "rejected" | "withdrawn";
  sourceTaskId?: string;        // the member it came from
  quote?: string;               // kind=ruling: the user's words, ≤ 500
  supersedes?: string;
  answer?: string;              // kind=question: the user's answer; kind=contract_change: the resolver's note (D19)
  change?: { before: string; after: string; reason: string; baseRevision: number; conflict?: boolean };  // kind=contract_change (§5)
  by: Actor; createdAt: string; updatedAt: string;
}
```

- `decision`, `finding`, `convention`, `pitfall`: what a member learned that siblings need; active at once (as project memory is).
- `ruling`: a product rule the user made. An agent may record one only when the user gave it in that card's chat, quoting it (D5); the UI shows who recorded it.
- `question`: an umbrella-level open question for the user ("do suggestions open PRs or drafts?"). It is not a card's ask and does not mark any card "Needs you"; the umbrella panel shows the open count.
- `contract_change`: §5.
- Ideas are not feed entries: an idea row (existing `ideas` collection) gains `umbrellaId?`, and the umbrella's ideas are derived from that field, so accept/dismiss stays where it is today and nothing drifts.

### 2.4 Limits

| What | Limit |
|---|---|
| Umbrellas per group (open) | 50; closed and archived do not count. Checked on create and reopen only: umbrellas that follow their projects to another group (§9) are never refused, so a group may then hold more than 50 |
| Members per umbrella | 30 |
| Feed entries per umbrella | 300 `active` or `open`; superseded, answered, rejected, accepted and withdrawn are kept but not counted, and `proposed` contract changes count only against their own limit below |
| Feed writes per member session | 20 per hour (`UMBRELLA_RATE_LIMIT`) |
| Brief / contract | 20,000 / 10,000 characters |
| Pending contract changes per umbrella | 10 |
| Sibling relay messages per dispatcher | 60 per hour, apart from `flowly_message_card`'s 30 (D21) |

## 3. What a member's agent reads

`flowly_get_task` gains `umbrella`, `null` when the card has none:

```ts
umbrella: {
  id, title, status, role /* null when none */, integration: boolean,  // this card's role; true when it is the integration card
  brief: { text, revision, updatedAt, unread: boolean, truncated: boolean },
  contract: { text, revision, updatedAt, unread: boolean },
  feed: { id, kind, title, body, status, sourceTaskId, sourceTitle, quote?, by, at, unread, answer? }[],
                                                           // answer: only on an entry returned under D19 (counted in the budget); quote: a ruling's
                                                           // quoted words (counted in the budget); sourceTaskId/sourceTitle
                                                           // null when no card wrote it; a contract change's body is its reason
  openQuestions: number, pendingContractChanges: number,
  siblings: { taskId, projectId, projectTitle, title, laneName, status, role, order, archived }[],
                                                           // laneName from the sibling's own project's lanes
  acceptance: { id, text, done }[],                        // id: what flowly_update_umbrella_acceptance takes (integration card, §11)
  ideas: { id, title, status, sourceTaskId }[],            // the umbrella's open ideas, newest first, at most 30
  ideasMore: number,                                       // open ideas left out by that cap
  linearProject?: { url, name? },
  truncatedFeed: number,                                   // entries left out
  unreadLeftOut: number                                    // unread entries left out (only when unread alone exceed the budget)
}
```

- **Budget.** Brief up to 8,000 characters (`truncated: true` and the full text through `flowly_get_umbrella`); feed: unread entries first, then every active `ruling`, then open `question` and `proposed` contract changes, then `decision`, `convention`, `pitfall`, `finding` newest first, until 6,000 characters; the rest is counted in `truncatedFeed`. Superseded, answered, rejected and withdrawn entries are left out, with one exception (D19): a question the user answered, or a contract change the user rejected, is returned once to the card it came from (`sourceTaskId`), as an unread entry with `answer`; once returned it counts as read and is left out again. Other members never get it. Siblings ≤ 30; open ideas ≤ 30, newest first, the rest counted in `ideasMore`. Today the response has no overall cap; this block is capped on its own so a large umbrella cannot crowd out the card.
- **Read marks.** Kept per session outside the board (`umbrella-reads.json`): the brief and contract revisions read in full and the entry ids shown (1,000 newest per umbrella). An entry returned under D19 is also recorded under its id and status, so an asker that saw its question while it was open still gets the answer once.
- **Unread (R4).** `brief.unread`/`contract.unread` when the current revision is newer than the one this session last got in full and the change was not made by this session; a feed entry is unread until it has been returned to this session once. A truncated brief does not record its revision as read. Entries created by this session are never unread to it. The `turnChecklist` item "handle unread inputs" covers it: an unread brief or contract is read before work.
- **First instructions** of a new member session add one line: the umbrella title, the member's role, "the brief, contract and feed are in flowly_get_task.umbrella", and the `[contract]` rule (fixing trial failure 3).
- **Project memory is unchanged.** `memoryForTask` keeps choosing project notes; umbrella notes are in the feed, outside its budget (§6).

## 4. Tools and RPCs

### 4.1 Card session tools (card credential; only on a member card)

| Tool | Input | Does |
|---|---|---|
| `flowly_add_umbrella_entry` | `{expectedRevision, request, kind: decision\|finding\|convention\|pitfall\|question\|ruling, title, body, quote?, supersedes?}` | Appends to the card's umbrella feed. `ruling` needs `quote` (≤ 500, the user's words from this card's chat) (D5). |
| `flowly_propose_contract_change` | `{expectedRevision, request, after, reason, baseRevision}` | Records a `contract_change` in `proposed` (§5). Never edits the contract. |
| `flowly_update_umbrella_acceptance` | `{expectedRevision, request, acceptance: {id, done}[], note}` | Integration card only (§11): ticks umbrella acceptance items; `NOT_INTEGRATION_CARD` otherwise. |
| `flowly_withdraw_umbrella_entry` | `{expectedRevision, request, id}` | Withdraws this card's own proposal or marks its own entry superseded. |
| `flowly_propose_idea` | adds `umbrella: true` | The idea gets `umbrellaId`; shown to siblings in `get_task.umbrella.ideas`. |
| `flowly_remember` | adds `scope: "project" \| "umbrella"` (default `project`) | `umbrella` writes a feed entry instead of a project note (§6): `decision`, `convention`, `pitfall` keep their kind, `contact` is refused (`UMBRELLA_KIND`; contacts are project-wide), `tags` and `keywords` are dropped, `supersedes` must name a feed entry. `MEMORY_DISABLED` does not apply to the umbrella scope. |
| `flowly_create_card` | adds `umbrella?: "inherit" \| "none"` (default `inherit` from a member, D11) | The follow-up joins the creator's umbrella; so does a card made from an idea with `umbrellaId` or from a member's idea. An umbrella that can't take it (closed, archived, full, another group) leaves the card out and the result's `notice` says why; the card is never refused for it. |

Events on the writing card (no card revision change): `umbrella_entry_added` (note `kind: title`), `umbrella_ruling_added` for a ruling, `umbrella_entry_withdrawn`; a new card that joins records `umbrella_joined`. Withdrawing an entry that is already closed is `INVALID_INPUT`.

Errors: `NOT_IN_UMBRELLA`, `UMBRELLA_CLOSED`, `UMBRELLA_KIND`, `UMBRELLA_OUT_OF_GROUP`, `UMBRELLA_LIMIT`, `UMBRELLA_RATE_LIMIT`, `CONTRACT_STALE` (baseRevision behind; re-read), `NOT_INTEGRATION_CARD`, and `AGENT_CARDS_DISABLED` when *Agents create and edit cards* is off (§12, D10; there is no separate umbrella switch).

### 4.2 Board tools (card sessions and sessions outside cards; the user's ask)

`registerCardTools` gives board tools to card sessions and sessions outside cards alike, so these tools are what a member agent can do beyond §4.1. Rule: **no agent tool edits an existing brief, contract, acceptance list or integration card**; those change only in the UI, or through the dispatcher after the user's yes in its chat (D5). A member changes the contract only by proposing (§5).

- `flowly_list_umbrellas {}`: the open umbrellas of the caller's project's group. No `groupId` input; another group is never listed.
- `flowly_get_umbrella {umbrellaId}`: full brief, contract, feed and members; `answer` is included only on the caller's own card's entries (D19). An umbrella of another group returns `UMBRELLA_OUT_OF_GROUP`. Sibling titles, lanes and project names from other projects of the same group are visible by design.
- `flowly_create_umbrella {title, brief?, linearProject?, idempotencyKey}`: in the caller's project's group; `brief` is only the initial text.
- `flowly_set_umbrella {taskId, umbrellaId|null, role?, order?}`: a card of the caller's project; for a card already in that umbrella an omitted `role` or `order` keeps the stored value and `null` clears it, while joining or moving to another umbrella starts with only what the call sends; adding an existing card to an umbrella or moving it out follows D11; in a card session the user's ask in that card's chat counts as the yes, as for `flowly_update_card`, with no permission prompt (D23). The umbrella's integration card cannot be moved or removed by an agent (D5, `INVALID_INPUT`).

Gated by *Agents create and edit cards* (as `flowly_create_card`).

### 4.3 Dispatcher tools

The same reads, plus `flowly_set_umbrella` and `flowly_create_umbrella` with the dispatcher's usual group check (`PROJECT_OUT_OF_GROUP`, checked again in the write transaction) and a user confirm on create and on adding an existing card (never preapproved, like `flowly_create_card`; since a tool is either preapproved or not, every `flowly_set_umbrella` call prompts, a removal included). `flowly_resolve_contract_change {id, accept|reject, note}` only after the user's answer in the dispatcher chat (D6); it is preapproved, because that answer is the approval (D16). `flowly_update_umbrella {id, revision, title?, brief?, contract?, acceptance?, integrationTaskId?, linearProject?}` edits an umbrella of its group after the user's yes in its chat, and every call shows a permission prompt (never preapproved, D5, D15). New tools raise `dispatcherToolNames`; the charter text (§8) raises `dispatcherCharterVersion`. Ruling (Noah, 2026-11-25): `flowly_create_card` with an explicit `umbrellaId` is refused (`UMBRELLA_CLOSED`, `UMBRELLA_LIMIT` or `UMBRELLA_OUT_OF_GROUP`) when that umbrella cannot take the card; §4.2's "a notice instead" applies only to an inherited umbrella. Replaying a `flowly_create_card` key with another `umbrellaId`, or a `flowly_create_umbrella` key with another title or brief, is `REQUEST_REUSED`. The confirm previews what the user approves: the new brief and contract text (whitespace collapsed to one line, at most 300 characters, cut with "…"), and for the acceptance list its item count and the first item, bounded the same way; every confirm line is one line and cut to its schema maximum.

### 4.4 RPCs (`shared/rpc.ts`, schema-validated)

`umbrellas.list {groupId}`, `umbrellas.get {id}`, `umbrellas.create {groupId, title, brief?, briefSource?, linearProject?}`, `umbrellas.update {id, revision, title?, brief?, briefSource?, contract?, acceptance?, integrationTaskId?, linearProject?}` (the user's edits) (REVISION_CONFLICT on a stale revision; `acceptance` is `{id?, text}[]`, text and order only: an existing id keeps the `done`, `by` and `at` the server has, a new item starts not done, so a save never undoes a tick), `umbrellas.tick-acceptance {id, itemId, done}` (the panel's checkbox: one item, applied to the umbrella as it is now, no revision check, `NOT_FOUND`, `UMBRELLA_CLOSED`; like an agent's tick it bumps `feedRevision` and never `revision`), `umbrellas.set-member {taskId, umbrellaId|null, role?, order?, onlyIfFree?}` (in the card's own umbrella, omitted `role` or `order` keeps, `null` clears, as `flowly_set_umbrella`; `onlyIfFree`: join only a card in no umbrella; in this umbrella already is a no-op, in another `REVISION_CONFLICT`; *Create from related cards* sends it so a stale proposal never moves a card), `umbrellas.entry.update {id, status, answer?}` (answer a question, accept/reject a contract change with an optional note in `answer`, supersede), `umbrellas.entry.create {umbrellaId, kind: decision|convention|pitfall|finding, title, body}` (the user's own entry, used by *Create from related cards*, §12), `umbrellas.close {id, revision}` / `umbrellas.reopen {id, revision}`, `umbrellas.archive {id, revision}` (like close: members stay, it stays readable, writes are refused with `UMBRELLA_CLOSED`, and it leaves the lists; D18), `umbrellas.linear-project {id}` (read-only, §10). All writes serialize through the store and validate input; the user's edits bump `revision`, feed writes bump `feedRevision` (§2.1).

The board receives umbrellas as summaries in the board overview (id, group, title, status, member count, open questions, pending changes, `revision`, `feedRevision`, archive time, Linear project), never brief, contract or entries; the panel and drawer section read one umbrella with `umbrellas.get` and read it again when that umbrella's `revision` or `feedRevision` changes, with no polling.

## 5. Contract changes

1. A member calls `flowly_propose_contract_change` with the full new contract text and the revision it read. Flowly stores `contract_change` `proposed` with a computed `before`.
2. **Conflict detection (Flowly, not guessed by the dispatcher):** a proposal whose `baseRevision` is behind the current contract is refused `CONTRACT_STALE`, and the agent rereads and proposes again (D17). A proposal that shares its `baseRevision` with another pending one is stored, and both are marked `conflict: true`; an accept marks the pending proposals it leaves behind `conflict: true`. Accepting a pending proposal whose `baseRevision` is behind the current contract is refused `CONTRACT_STALE` (D20), in the panel and through `flowly_resolve_contract_change`; the user rejects it or the agent proposes again on the current revision.
3. The dispatcher hears it as a stop (a new stop kind, `contract_proposed`, EVENT-BUS-SPEC §2) with the conflict flag and the members whose role the change mentions. Its charter: never accept on its own; put the change, its reason and any conflict to the user with AskUserQuestion in the dispatcher chat (accept / reject / ask the proposer to merge), and call `flowly_resolve_contract_change` only with the user's answer. The user can also accept or reject on the umbrella panel.
4. Accepted: the contract text becomes `after`, `revision + 1`, every other member sees `contract.unread`, and live siblings get one relay line (§8). Rejected: the proposing card's next `get_task` returns the entry once, with status `rejected` and the note in `answer`, and after that it counts as read (D19, §3); other members never get it.
5. A change that also sets a product rule ("suggestions never open PRs without review") is a `ruling` question for the user, not something the dispatcher or an agent decides.

Every change needs the user's accept, additive ones included (D6); the dispatcher never accepts on its own.

## 6. Umbrella memory

`flowly_remember scope=umbrella` (and `flowly_add_umbrella_entry`) write a feed entry, shown to every member through `get_task.umbrella.feed`, never to cards outside the umbrella. They stay out of project memory's 200-note cap and `memoryForTask` budget, so the trial's crowding-out (failure 5) cannot happen. Superseding works as for project notes, with two guards (D22): an agent supersedes a `ruling` only with a new `ruling` carrying the user's quote (`UMBRELLA_KIND` otherwise), and an open `question` only from the card that asked it (`INVALID_INPUT` otherwise; the user's answer closes it); the user's own supersede in the panel is not limited. When the umbrella closes, its `decision`, `convention` and `pitfall` entries are offered to the user as project memory ("keep these for the repo?"), each one ticked off by the user; nothing moves silently. Umbrella memory is the feed, one store with its own budget, not tagged project notes (D7).

## 7. Board

- **Filter.** The Filters modal gains *Umbrella* (single choice, plus "No umbrella"), stored in each group's filter (`groupFilters`) and the global filter (`filterUmbrella`), counted in the filter badge. (`projectFilters` only remembers each group's chosen project, so it holds no umbrella.) On a group board it covers every project's cards.
- **Card face.** A quiet umbrella chip in `CardMeta` after the type (title cut to 20 characters, the role after a dot when set); a new `cardFields` id `umbrella` so it can be hidden. Not the `Layers` icon (Shortcut epics).
- **Umbrella panel.** A board toolbar menu *Umbrellas* lists the group's open umbrellas (member count, open questions, pending changes). Opening one shows: title and Linear chip; brief (markdown, editable by the user); contract; the pipeline (members by `order` with role, lane and project); the feed with filters by kind, the open questions with an answer box; the acceptance list; Close. Pending contract changes with Accept / Reject come with card 4 and Ready to close with card 6 (§17). A member row opens the card. On an open umbrella the user also gets *New umbrella* in the list (title, optional brief, in the shown board group), a title edit, a Linear project edit in the header beside the chip (a project URL or a `P-<TEAM>-<n>` key sets it, empty clears it, other text is refused, §10), *Add cards* (a picker of the group's live cards not in this umbrella, searched by title, with an optional role; a card in another umbrella is marked as moving), remove, role and move up/down on each pipeline row, and an integration card chooser (a member or none); each editor saves against the revision it was opened on, so an edit made meanwhile is refused and reloaded rather than overwritten.
- **Card drawer.** A new movable section *Umbrella* (`drawer-sections`): role, a link to the panel, when the brief and contract last changed (unread is tracked per agent session, R4, so the user sees change dates, not unread markers), the last 5 feed entries. The Quick links row adds the umbrella chip after the Linear issue.
- **Group by.** A board toggle *Group by umbrella* splits each lane into bands, one per umbrella with a shown card in that lane (members only, by umbrella title) and a last band "No umbrella"; each band has its own header, every lane keeps its own scroll, and bands are not aligned across lanes (D24). Phones stack the same bands inside each lane page. No group-by exists today (lanes are statuses, sort is the only grouping-like control), so it is the largest UI piece and ships in a later card (card 8), after the filter, chip, panel and drawer section (D8).
- Lanes stay statuses: an umbrella is never a lane (a lane per umbrella would break the workflow-lane model of `BOARD-GROUPS-SPEC` §5).

## 8. Dispatcher

- **Assignment (D11).** A card created from a member (follow-up, `flowly_create_card` by a member session, or an accepted member idea) joins the umbrella. When the dispatcher creates a card the user describes as part of a family, it proposes the umbrella in the create confirm. Adding an *existing* card or moving it between umbrellas is a user decision (confirm in the dispatcher chat or the UI).
- **Relay targets.** `contractRelayTargets` becomes the union of `related`-linked cards (today) and live siblings, each once, never the source, within the group. Live = not archived, not Done/Cancelled, with a live session (unchanged). The cap `relayTargetLimit` rises from 10 to 30 (the member limit); if both sets together exceed it, siblings come first by `order`, then related cards, and the relay line says how many were left out. Relay messages (a `flowly_message_card` call that names the relayed event and goes to one of that relay's targets) take from their own budget of 60 per hour per dispatcher, apart from `flowly_message_card`'s 30 (D21).
- **What is relayed (D12).** (a) `[contract]`-marked results and deliveries, as today; (b) accepted contract changes ("contract r5 accepted: …"); (c) new `ruling` entries. Not relayed as messages: other feed entries and member deliveries; siblings see them through `get_task` unread marks on their next turn. Never relayed: questions, permission requests, blockers (unchanged).
- **Persistence.** The relayed-event memory moves from process memory to the board (per group, last 500) so a reload does not relay twice (trial failure 6).
- **Charter.** One section on umbrellas: read `flowly_get_umbrella` before planning a family's next card; propose the umbrella on create; never accept a contract change or record a ruling without the user's answer; relay only what the relay line carries. `dispatcherCharterVersion` +1, so running dispatchers show the Replace warning.

## 9. Board groups, scope and export

- **Scope (D2).** An umbrella lives in one board group and may hold cards from any of the group's projects. This covers the harness case (two projects, one group) without cross-project links. Cards in other groups cannot join; the dispatcher's `PROJECT_OUT_OF_GROUP` stays as is, and a dispatcher only sees umbrellas of its group. Cross-group umbrellas are not in this version.
- **Projects change group.** Three paths move projects: the UI's project move (`projects.set-group`), **Delete group** (all its projects go to the default group) and the dispatcher's `flowly_manage_groups` set-members (confirmed by the user on every call). One rule for all three, applied inside the same write: an umbrella whose member projects *all* end up in one group moves with them (`groupId` updated, nothing lost); otherwise the cards that left its group leave the umbrella (membership cleared, a `left` activity event) and the umbrella keeps its feed entries with `sourceTaskId`, showing the card as "moved out". The UI confirm and the dispatcher's confirm text name each umbrella that would lose members. An umbrella whose group is deleted and that has no members left moves to the default group. A dangling `groupId` is repaired to the default group on read, as for projects.
- **Project archive / remove.** Archiving keeps memberships (archived cards show as archived siblings). Remove (PROJECT-REMOVE-SPEC) clears the membership of its cards in the backup and in the umbrella; an umbrella with no members left is kept (the user may archive it).
- **Card delete / archive.** Delete clears membership; feed entries keep `sourceTaskId` and show "deleted card". Archive keeps it. Wrap up never touches the umbrella.
- **Board export.** `board.export-markdown` per project gains a section per umbrella that has a member in it: title, Linear link, brief (first 2,000 characters), members in that project, and the members elsewhere as `title (project)` only. Without `projectId` (all live projects) each umbrella with a member in those projects is listed once, after the projects; an umbrella with no member in the exported projects is never listed. A group dispatcher's first message (built from the same export over its group's projects) lists its group's umbrellas by title and members only, without the brief. `storage.export-json` includes the collections. Project-remove backups include the umbrellas their cards were in, by id and title.

## 10. Linear

- Flowly only reads Linear. `linearProject` is a project URL (`https://linear.app/<ws>/project/<slug>`) or a project key (`P-<TEAM>-<number>`, e.g. P-ZEN-391); any other text is refused where it is entered. The connector gains a read-only `project(id:)` query, given the slug id ending the URL's slug or the key as given (Linear documents the id as UUID, slug id or human-readable identifier; archived projects are found too), and returns name, status, target date, url and the first 100 issues (identifier/title/state); a full page shows a "first 100" line. The read uses the Linear connection whose workspace is the URL's `/<ws>/` segment (else each working Linear connection in turn while the project is not found). The panel reads again when the umbrella's member set changes. It never writes a status, comment or issue.
- The panel shows the project chip and, from one read while the panel is open, **issues in the project without a card in the umbrella** ("ZEN-9301 Correction detector — no card"); a row's *Make card* fills New task with the issue linked (as the Linear board does today) and the umbrella set. The list ships with the link (D9).
- A member's own Linear issue stays the card's `flowly_set_linear` input; an issue whose project is the umbrella's Linear project is suggested as a member, never added on its own.

## 11. Umbrella acceptance and the integration card

- The umbrella's `acceptance` list is its end-to-end definition of done (e.g. "a correction made in chat appears in the next session's context within one hour"). The user owns it; agents may propose items as `finding` entries.
- One member may be the **integration card** (`integrationTaskId`). Its `get_task.umbrella.integration` is `true` and its first instructions add: run the umbrella's acceptance end to end against what the siblings delivered, tick items with `flowly_update_umbrella_acceptance` (integration card only; a tick with evidence in the note), and report the result on the umbrella feed as a `finding`.
- An umbrella never moves cards and is never closed automatically. The panel shows **Ready to close** when the umbrella has a member, every member is Done or Cancelled and every acceptance item is ticked (an empty list is met); the user closes it. Ready to close ignores archived members. After Close the panel lists the entries §6 offers, each with its own *Keep for the project* button: one project note per tap (`guardrails.create`, kind `note`, title and body cut to the memory limits), kept in the project of the card that wrote the entry, else the first member's project; an entry whose project already holds a live note of the same kind and title shows Kept without a second save; the Kept marks of this session live in the open view only. A closed umbrella refuses new members and feed writes (`UMBRELLA_CLOSED`) and stays readable.

## 12. Migration and switches

- No board version bump: new collections default to `[]`, `task.umbrella` is optional.
- Switch (D10): no new setting; agent writes sit behind the existing *Agents create and edit cards* switch (`AGENT_CARDS_DISABLED`). There is no `UMBRELLAS_DISABLED` error.
- **From the light version.** A one-time, user-run action on the panel, *Create from related cards*: pick a card, Flowly proposes its connected `related` component (same tag, same group) as members and asks for a brief; an attached charter file can be pasted into the brief (Flowly does not read files on its own). The start card is picked from the shown group's live cards in no umbrella; the proposal is all ticked, the start card always included, at most 30 members in all. Memory notes whose project is one of the proposed members' (the start card's included) and that carry a tag the start card shares with at least one other proposed member are offered (from the proposal, so unticking a card never drops a ticked note; none without another proposed member), unticked for copying into the feed, one tick each (decision, convention and pitfall keep their kind, any other kind becomes a finding). Create runs `umbrellas.create`, `umbrellas.set-member` per card, then `umbrellas.entry.create` per note; the first failure stops it without undoing what was made and names what was not added. Links and tags stay as they are.
- `evidence.json` and `get_task.evidence` do not exist (EVIDENCE-GALLERY-SPEC rejected them); umbrella acceptance evidence is the integration card's output artifacts.

## 13. Not in this version

- Status rollup, progress percentages, cascading start/move/archive/delete/wrap-up (CARD-LINKS §9 still holds for everything but membership).
- Cards in two umbrellas; umbrellas inside umbrellas; cross-group umbrellas.
- Cards messaging each other; relaying any card's questions, permission requests or blockers.
- Writing to Linear (project status, comments, issue creation).
- An umbrella as a lane.

## 14. Onboarding, What's new, telemetry, i18n

- Tour: one line in *More features*: "Umbrellas (epics): group cards for one body of work under a shared brief and decisions feed." (D1: "epic" appears once here, for discoverability.)
- Tip `umbrella-first`: shown when a card first has two or more `related` siblings with the same tag ("Several related cards? Put them under one umbrella so they share a brief."). Tip table, `tipIds`, `tipText`, `nextTip` and a test.
- What's new: one sentence in the release that ships the panel.
- Telemetry: `f_umbrellas` (count of open umbrellas, bucketed) and `c_umbrella_entries` in the heartbeat (TELEMETRY-SPEC §4); telemetry stays off in this fork either way.
- i18n: every new UI string in all catalogs; agent-facing text and daemon errors stay English. Card-display, drawer-section and filter catalogs gain their entries.

## 15. Acceptance

- A card in an umbrella sees the brief, contract, feed (rulings first), open ideas and siblings with lanes and roles in `flowly_get_task.umbrella`; a card outside sees `null`.
- Editing the brief or accepting a contract change marks it unread for every other member's session, and read after that session's next `get_task`.
- A member's `flowly_remember scope=umbrella` entry appears on every sibling and on no card outside the umbrella; it never appears in project memory.
- `flowly_propose_contract_change` never changes the contract; two proposals on the same base are flagged as a conflict; only the user's accept (UI or dispatcher chat) applies one.
- A card can be in at most one umbrella; a card from another group is refused with `UMBRELLA_OUT_OF_GROUP`; a dispatcher cannot see or change an umbrella of another group.
- The Filters modal filters by umbrella across a group board's projects; the card face shows the chip and it can be hidden; the umbrella panel shows members by role and lane, the feed, open questions, pending changes and acceptance.
- A follow-up created from a member joins its umbrella; adding an existing card needs the user.
- A `[contract]` result on a member is relayed once to each live sibling and related card, never to the source, never twice across a plugin reload; a question or blocker on a member is never relayed.
- The Linear project chip shows the project's name read from Linear; Flowly makes no write call to Linear.
- The per-project export lists each umbrella with members in that project and names members elsewhere by title and project.
- Nothing about an umbrella changes a card's lane, session, workspace or wrap-up.
- The user's answer to an umbrella question, or a rejected contract change with its note, reaches the asking or proposing card once and no other member (D19); accepting a proposal behind the current contract is refused `CONTRACT_STALE` (D20); relays to siblings take from their own 60-per-hour budget, leaving `flowly_message_card`'s 30 untouched (D21).

## 16. Rulings

Noah accepted every recommendation of the draft on 2026-11-25. Rejected options stay listed so a later change knows what was weighed.

- **D1: name.** (a) *Umbrella* in UI, tools and docs; (b) *Epic*, matching Linear/Jira habits but colliding with Shortcut epics in connectors, catalogs and agent text; (c) *Initiative*/*Bet*. Ruling (Noah, 2026-11-25): (a): *Umbrella* in UI, tools and docs, with "epic" mentioned once in the tour line for discoverability.
- **D2: scope.** (a) one project; (b) one board group, any of its projects; (c) across groups. (a) misses the harness family (two projects); (c) breaks the per-group dispatcher boundary (`PROJECT_OUT_OF_GROUP`) and per-group filters. Ruling (Noah, 2026-11-25): (b): one board group, any of its projects. Cross-project `related` links are not needed for families; the idea "Decide on cross-project related links for card families" stays open only for one-off links.
- **D3: one umbrella per card.** (a) at most one; (b) several. Ruling (Noah, 2026-11-25): (a): at most one umbrella per card.
- **D4: where the brief lives.** (a) markdown stored in Flowly with a revision (optional `source` link to the user's own file); (b) a file artifact the umbrella points to (the trial's way); (c) a Linear project document. (b) and (c) have no revision Flowly can trust for unread and break on another machine or without a connection. Ruling (Noah, 2026-11-25): (a): markdown stored in Flowly with a revision, with an optional `source` link.
- **D5: who edits the brief and contract, who records rulings.** (a) the user only, in the UI; (b) the user, plus the dispatcher after the user's yes in its chat; member agents append feed entries and propose contract changes but never edit the brief or contract; an agent records a `ruling` only with the user's words quoted from its own chat; (c) any member agent edits. Ruling (Noah, 2026-11-25): (b): the user, plus the dispatcher after the user's yes in its chat; member agents append and propose only; an agent records a `ruling` only with the user's words quoted from its own chat.
- **D6: contract change approval.** (a) the user accepts every change; (b) the dispatcher accepts changes that only add fields or sections, the user accepts the rest; (c) proposals apply at once and are only reported. Ruling (Noah, 2026-11-25): (a): the user accepts every contract change in this version.
- **D7: umbrella memory.** (a) the feed is the umbrella memory (one store, separate budget, §6); (b) project memory notes tagged `umbrella:<id>`, boosted in `memoryForTask` for members. (b) reuses code but keeps the trial's crowding-out and leaks to non-members through recall. Ruling (Noah, 2026-11-25): (a): the feed is the umbrella memory.
- **D8: board view in the first version.** (a) filter, card chip, panel and drawer section first; *Group by umbrella* bands in a later card; (b) all at once; (c) filter and chip only. Ruling (Noah, 2026-11-25): (a): filter, card chip, panel and drawer section first; *Group by umbrella* bands in a later card.
- **D9: Linear project.** (a) a read-only link plus the "issues without a card" list; (b) link only; (c) none. Ruling (Noah, 2026-11-25): (a): a read-only link plus the "issues without a card" list.
- **D10: switch.** (a) no new switch, agent writes behind *Agents create and edit cards*; (b) a group setting *Umbrellas* (off by default). Ruling (Noah, 2026-11-25): (a): no new switch; agent writes sit behind *Agents create and edit cards*.
- **D11: dispatcher assignment.** (a) follow-ups and member ideas inherit the umbrella automatically, an existing card joins only with the user's yes; (b) every membership change needs the user; (c) the dispatcher assigns freely. Ruling (Noah, 2026-11-25): (a): follow-ups and member ideas inherit the umbrella automatically; an existing card joins only with the user's yes.
- **D12: what the dispatcher relays.** (a) `[contract]` news, accepted contract changes and new rulings, as messages to live siblings; everything else only through unread marks; (b) also every member delivery ("results to siblings" read literally); (c) nothing as messages, unread marks only. (b) spends the 30-per-hour message budget on noise and interrupts running siblings. Ruling (Noah, 2026-11-25): (a): `[contract]` news, accepted contract changes and new rulings as messages to live siblings; everything else through unread marks.
- **D13: reversing CARD-LINKS §9.** The 2026-10-16 ruling rules out parent-child and cross-project links, and an umbrella is a container that spans projects. Ruling (Noah, 2026-11-25): amend both CARD-LINKS §9 items for umbrella *membership* only; the bans on rollup, status linking and cascades stay, and card links stay same-project. This changes the 2026-10-16 ruling; `docs/CARD-LINKS-SPEC.md` §9 records the amendment.
- **D14: closing.** (a) the user closes, and on close is offered to copy decisions to project memory one by one; (b) close automatically when all members are Done and acceptance is ticked. Ruling (Noah, 2026-11-25): (a): the user closes; on close, decisions are offered for project memory one by one.
- **D15: a dispatcher tool to edit the brief and contract.** D5 lets the dispatcher edit them after the user's yes, but no tool did. (a) `flowly_update_umbrella`, never preapproved; (b) no tool, the panel only. Ruling (Noah, 2026-11-25): (a).
- **D16: preapproving the resolve call.** (a) `flowly_resolve_contract_change` is preapproved, since the user's answer to the dispatcher's question is the approval; (b) a second permission prompt. Ruling (Noah, 2026-11-25): (a).
- **D17: a proposal on an old contract revision.** (a) refused `CONTRACT_STALE`; (b) stored with a conflict flag. Ruling (Noah, 2026-11-25): (a).
- **D18: archiving an umbrella.** (a) like closing: members stay, it stays readable, writes are refused, and it leaves the lists; (b) archiving also clears every membership. Ruling (Noah, 2026-11-25): (a).
- **D19: answers and rejections reaching the asker.** §3 left answered and rejected entries out of the feed while §5 promised the proposer the note. (a) the asking or proposing card's next `get_task` returns that entry once, with `answer` (the answer or the reject note), then it counts as read; other members don't get it; (b) every member sees answered and rejected entries; (c) only `flowly_get_umbrella` shows them. Ruling (Noah, 2026-11-25): (a).
- **D20: accepting a proposal on an old revision.** After another change is accepted, a still-pending proposal may rest on an older contract. (a) its accept is refused `CONTRACT_STALE` and the agent proposes again; (b) accept applies `after` anyway, dropping the earlier accepted change; (c) accept after a second confirm. Ruling (Noah, 2026-11-25): (a).
- **D21: relay budget.** A relay to up to 30 targets would use `flowly_message_card`'s 30 per hour. (a) sibling relays get their own budget, 60 per hour, apart from the 30; (b) relays share the 30; (c) relays are unlimited. Ruling (Noah, 2026-11-25): (a).
- **D22: who may supersede an entry.** As built, any member agent could supersede any active entry, including a user-quoted ruling and another card's open question. (a) guard rulings and questions: an agent supersedes a `ruling` only with a new `ruling` (which still needs the user's quote), an open `question` only from the card that asked it (otherwise only the user's answer closes it), and any other kind from any member, as with project notes; (b) an agent supersedes only its own card's entries; (c) any member supersedes any entry, as built. The user's own supersede (`umbrellas.entry.update`) is not limited. Ruling (Noah, 2026-11-25): (a).
- **D23: adding an existing card from a card session.** D11 named the dispatcher chat and the UI as where the user says yes; `flowly_set_umbrella` is also a card-session board tool. (a) the user's ask in that card's chat counts, as for `flowly_update_card`, with no permission prompt; (b) a permission prompt on every call from a card session; (c) card sessions cannot change an existing card's membership. Ruling (Noah, 2026-11-25): (a).
- **D24: Group by umbrella layout on desktop.** (a) bands inside each lane, each with its own header and the lane's own scroll, as on phones; (b) swimlanes: one row per umbrella spanning every lane, with one shared board scroll. Ruling (Noah, 2026-11-25): (a); the filter and the umbrella panel show one umbrella's stages at a glance.

## 17. Proposed card split

Each card is one branch and at most one PR; order is the dependency order. Cards 1-3 are the first usable version (the ZEN-9284 shape); 4-8 complete the idea.

1. **Umbrella model and RPCs**: collections, `task.umbrella`, `ideas.umbrellaId`, limits, `umbrellas.*` RPCs (`entry.update` for questions and supersede; contract accept/reject in card 4), store validation, delete/archive/group-change (all three paths)/remove handling, export sections. Tests for limits, group scope and revisions. (Storage/RPC: PR.)
2. **Agent surface**: `get_task.umbrella` block with budgets and `umbrella-reads.json` unread marks, `flowly_add_umbrella_entry`, `flowly_remember scope=umbrella`, `flowly_propose_idea umbrella`, `flowly_create_card` inherit, board tools (§4.2), first-instructions line, skill text (`skills/flowly/SKILL.md`, `server/skill-source.ts`).
3. **Board UI, first part**: Filters entry, card chip and `cardFields` id, drawer section, umbrella panel (brief, contract, pipeline, feed, questions, acceptance, plain Close), i18n, tour line and tip.
4. **Contract changes**: `flowly_propose_contract_change`, conflict detection, `contract_proposed` stop, panel accept/reject, `flowly_resolve_contract_change`.
5. **Dispatcher**: tools and confirms, charter section and version bump, relay targets = siblings ∪ related, rulings and accepted changes relayed, relay memory persisted.
6. **Integration card and acceptance**: `integrationTaskId`, its instructions, `flowly_update_umbrella_acceptance`, Ready to close, close-time memory offer.
7. **Linear project (read-only)**: connector `project` query, chip, "issues without a card" list, suggested members.
8. **Group by umbrella** bands on desktop and phones (D8); the light-version migration action.
