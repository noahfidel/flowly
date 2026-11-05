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
2. none of the card's artifacts (inputs or outputs) is a Linear item: an artifact whose `external.provider` is
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
