# Card type: agent fill-in (CARD-TYPE-SPEC)

## 1. Goal

A card's type (feature / bugfix / research / refactor / docs / chore) is an optional field. For a card with no type, the agent working in it fills it in after understanding the task; a type that is already set (whether by a person or by an agent) is not changed by the agent.

## 2. Agent tool `flowly_set_type`

- Input: `expectedRevision`, `request` (copied verbatim from get_task), `type` (one of the six above; any other value is `INVALID_INPUT`).
- The card has no type: write the type, task revision +1 (so an older form a person has open hits a revision conflict and cannot clear the type back to empty), record the event `type_set` (actor=agent, note is the type id), receipt action=`type`.
- The card already has the same type: change nothing, the receipt `eventId` is empty, the revision does not change.
- The card already has a different type: reject with `TYPE_ALREADY_SET`, change nothing. The agent should not retry with another type.
- The other checks are the same as for the other write tools (signature, revision, expiry, archived, Done/Cancelled rejected, an exact replay returns the original receipt).
- CLI: `set-type <type> --request-file <snapshot>`. HTTP API action `type`.

## 3. UI

The activity list shows `type_set` as "Set the task type" (translated), and the note shows the localized type name. A person can still change the type at any time in the form and the drawer.

## 4. Onboarding

No new tour copy or tip: this is agent-side behavior, and all a person sees is that the card now has a type.

## 5. Acceptance

- `server/agent-service.test.ts`: set when missing and +revision, replay, a different already-set value rejected, the same value unchanged, a value set by a person is not replaced, an invalid value rejected.
- `server/tool-server.test.ts`: the MCP tool list includes `flowly_set_type`.
- The skill text (`server/skill-source.ts` and `skills/paseo-ultra-kanban/SKILL.md` kept identical) says when to call it.
