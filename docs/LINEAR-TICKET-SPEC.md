# Linear ticket for every card (project setting)

A per-project setting that asks the agent to make sure each card has a Linear ticket before it starts the work.
Flowly itself stays read-only towards trackers: it never creates, edits or comments on a Linear issue. The
agent does that with its own Linear tools (for example the Linear MCP server), and links the ticket to the card
through the existing artifact tool. (User decision 2026-11-05: this fork lets the agent create the ticket; the
daemon gains no Linear write code.)

## 1. Settings

On the project (project form, next to **Card workpad** and the other per-project switches):

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `linearTicket` | boolean, optional | absent = off | **Make sure there's a Linear ticket** |
| `linearTeam` | string, optional, ≤ 80 characters | absent | **Linear team**: a team name or key the agent creates tickets in |
| `linearSkipTypes` | array of card types, optional | absent = `["research"]` | **Skip the Linear ticket for these card types** |

- `linearSkipTypes` (user decision 2026-11-14): cards of a listed type get no block by default (§2). Absent means
  `["research"]`, for new projects and for existing ones, so a research card is not asked for a ticket while every
  other type is. `[]` skips no type. The store keeps the types deduplicated, in the order of the card types
  (`feature`, `bugfix`, `research`, `refactor`, `docs`, `chore`); unknown values are refused by the schema.
  A card without a type is never skipped by this list.
- The project form shows the list while the switch is on, under the team field: one switch per card type, labelled
  with the translated type name, under the heading **Skip the Linear ticket for these card types**. An unchanged list
  sends nothing. Turning the project switch off keeps the list.
- The team field is shown only while the switch is on. Its value is trimmed and folded to one line; an empty
  value removes the field. Turning the switch off keeps the team for next time.
- `projectEdit` takes the three fields (`linearSkipTypes` replaces the whole list); the store writes them like `workpad` (`linearTeam: ""` deletes it).
- Labels are translated; the instruction text the agent receives stays English.

## 2. When the block is added

The block is part of the card's session context (`sessionContext`): the text Flowly builds for a new session's
first instructions (`tools.prepare-session`, every session started from a card), for **Send Kanban work
instructions** (`tools.prepare-existing`) and for `tasks.context`. `flowly_get_task` does not return this text,
so the block reaches the agent at session start. It is added only when all of these hold:

1. the project has `linearTicket: true`;
2. the card wants the ticket: `task.linearTicket` is `true` (forced on, §5), or it is unset and the card's type is
   not in the project's `linearSkipTypes` (§1); `task.linearTicket: false` never wants it
   (1 and 2 are one shared rule, `linearTicketWanted` in `shared/linear-ticket.ts`, also used for the default of the
   dispatcher's card confirm, DISPATCHER-SPEC §5.2);
3. none of the card's artifacts (inputs or outputs) is a Linear item: an artifact whose `external.provider` is
   `linear`, or whose target is an http(s) URL on `linear.app` (or a subdomain of it).

Otherwise nothing is added. The user's prompt and ordinary follow-ups are never changed (the first message stays
exactly what the user typed). Once a ticket is linked, the next context no longer carries the block.

## 3. The block

One function (`linearTicketLines` in `shared/linear-ticket.ts`) owns the wording; whether the block is added at all
is answered by `linearTicketWanted` (§6). It tells the agent, before it
starts the work:

1. search Linear with its own Linear tools (for example `list_issues`) for an existing ticket that matches the card;
2. if none fits, create one: in the configured team when one is set; otherwise in the team the card, the
   repository or Linear makes clear, and ask the user once when it cannot tell. Follow the
   `eng-conventions:linear-tickets` skill when it is available;
3. link the ticket to the card with `flowly_add_artifact` (role `input`, target the ticket URL), and name the
   ticket ID in its first progress report;
   - while agent artifacts are turned off (Settings → AI features; the tool would return `ARTIFACTS_DISABLED`),
     the block does not ask for the link. Instead step 1 starts the search with the card's title, since an
     earlier session of the card may have created a ticket it could not link, and says to reuse it; a new
     ticket is titled like the card where possible, and its ID and URL go in the first progress report;
4. if it has no Linear tools, say so in one line and carry on with the card. The block never blocks the work.

## 4. Acceptance

- Off (absent or `false`): no block, whatever the card's artifacts.
- On with a Linear item linked (by connector or by `linear.app` URL): no block.
- On without one: the block appears in the session context, after the card's inputs/outputs; it names the team
  when one is set and the ask-once rule when not.
- With agent artifacts off: no `flowly_add_artifact` step; the search starts with the card's title and reuses
  a match. Search before create holds in both cases.
- The project form saves and reloads both fields; an unchanged form sends neither.
- Flowly's daemon gains no Linear write call.
- A card with `linearTicket: false` gets no block while the other cards of the same project keep it; a card with
  the field unset inherits the project's switch and its type rule.
- Default skip list (absent): a `research` card with the field unset gets no block; a `feature`, `bugfix`,
  `refactor`, `docs` or `chore` card, or one without a type, gets it.
- A card of a skipped type with `linearTicket: true` gets the block; a card of any type with `linearTicket: false`
  does not; a project with the switch off gives no card the block, whatever the card's field or type.
- A card set back to inherit follows its type again (a research card gets no block by default).

## 5. Per-card override

A card can override what the project and its type decide (user decision 2026-11-13: opt out; extended 2026-11-14:
a card of a skipped type can be forced on). A card can never turn the ask on in a project whose switch is off.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `task.linearTicket` | boolean, optional | absent = follow the project and the card's type | `false`: no block for this card; `true`: the block even when the card's type is skipped |

- Writes: `false` and `true` are stored as given; `null` removes the field (the card follows the project and its
  type again). In `tasks.update` (`taskEdit.linearTicket`) and `flowly_update_card` an omitted field changes nothing.
  At creation (`taskInput.linearTicket`, `flowly_create_card`) `true` and `false` are stored and omitted (or `null`)
  stores nothing.
- The field has an effect only while the project's switch is on. It may be stored in any project; it is kept when the
  project's switch, its skip list or the card's type change. `true` on a card whose type is not skipped changes
  nothing until its type or the list changes.
- A card with a linked Linear item gets no block either way (§2), so the field changes nothing for it.
- Set at creation: the New card form, `tasks.create`, and `flowly_create_card` (card sessions, sessions outside
  cards and the dispatcher). The dispatcher's call is confirmed by the user first (DISPATCHER-SPEC §5.2): **Create
  with Linear ticket** sends `linearTicket: true` when the card's type default is off (a skipped type such as research)
  and drops the field otherwise; **Create without Linear ticket** sends `linearTicket: false` when the type default
  is on and drops the field otherwise.
- Edited afterwards: the card form (`tasks.update`) and `flowly_update_card` (a change is listed as `linearTicket`
  in `changed` and in the `edited` event's note). Editable in any lane the card form and `flowly_update_card` already
  allow; it only matters for sessions and work instructions started after the change.
- The card view of the card tools (`flowly_get_card`, `flowly_create_card`, `flowly_update_card`) shows
  `linearTicket: false` or `true` when the card stores one and leaves it out otherwise.
- Card form: while the project's switch is on, a **Make sure there's a Linear ticket** switch next to **Delivery**.
  It shows what the card gets: the stored value when there is one, otherwise the default for the type chosen in
  the form (off for a skipped type, on for the others; it follows the Type choice while the card stores nothing).
  On save, a switch equal to that type default sends nothing for a new card and `null` for a card that stored a
  value; a switch that differs sends its value. An unchanged card sends nothing. Hidden in a project with the switch
  off.

## 6. Shared decision

`linearTicketWanted(project, card)` in `shared/linear-ticket.ts` is the one answer to "does this card get the
Linear step": it takes the project's `linearTicket` and `linearSkipTypes`, the card's `type` and `linearTicket`, and
the card's artifacts, and returns true only when §2 holds. `linearTicketLines` uses it, and so does any surface
that shows the default (for example a confirm step at card creation). `linearTicketTypeDefault(project, type)`
returns what a card of that type gets with its field unset (false when the project's switch is off).
