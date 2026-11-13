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

- The team field is shown only while the switch is on. Its value is trimmed and folded to one line; an empty
  value removes the field. Turning the switch off keeps the team for next time.
- `projectEdit` takes both fields; the store writes them like `workpad` (`linearTeam: ""` deletes it).
- Labels are translated; the instruction text the agent receives stays English.

## 2. When the block is added

The block is part of the card's session context (`sessionContext`): the text Flowly builds for a new session's
first instructions (`tools.prepare-session`, every session started from a card), for **Send Kanban work
instructions** (`tools.prepare-existing`) and for `tasks.context`. `flowly_get_task` does not return this text,
so the block reaches the agent at session start. It is added only when all of these hold:

1. the project has `linearTicket: true`;
2. the card has not opted out (`task.linearTicket` is not `false`, §5);
3. none of the card's artifacts (inputs or outputs) is a Linear item: an artifact whose `external.provider` is
   `linear`, or whose target is an http(s) URL on `linear.app` (or a subdomain of it).

Otherwise nothing is added. The user's prompt and ordinary follow-ups are never changed (the first message stays
exactly what the user typed). Once a ticket is linked, the next context no longer carries the block.

## 3. The block

One function (`linearTicketLines` in `shared/linear-ticket.ts`) owns the wording. It tells the agent, before it
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
  the field unset inherits the project's switch.

## 5. Per-card opt-out

A card can opt out of the project's switch (user decision 2026-11-13: opt out only; a card can't turn the ask on
in a project that has it off).

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `task.linearTicket` | `false`, optional | absent = inherit the project | `false`: this card gets no Linear ticket block |

- Only `false` is stored. Writing `true` removes the field (the card inherits again); a stored `true` (not written
  by this version) is read as inherit.
- The field has an effect only while the project's switch is on. It may be stored in any project; it is kept when the
  project's switch is turned off and on again.
- A card with a linked Linear item gets no block either way (§2), so the field changes nothing for it.
- Set at creation: the New card form, `tasks.create` (`taskInput.linearTicket`, only `false` is taken), and
  `flowly_create_card` (card sessions, sessions outside cards and the dispatcher: `linearTicket: false`; `true` or
  omitted inherits).
- Edited afterwards: the card form (`tasks.update`, `taskEdit.linearTicket`: `false` opts out, `true` inherits again)
  and `flowly_update_card` (same values; a change is listed as `linearTicket` in `changed` and in the `edited` event's
  note). Editable in any lane the card form and `flowly_update_card` already allow; it only matters for sessions and
  work instructions started after the change.
- The card view of the card tools (`flowly_get_card`, `flowly_create_card`, `flowly_update_card`) shows
  `linearTicket: false` when the card opted out and leaves it out otherwise.
- Card form: while the project's switch is on, a **Make sure there's a Linear ticket** switch (on = inherit,
  off = opted out) next to **Delivery**. It is hidden in a project with the switch off. An unchanged switch sends
  nothing.
