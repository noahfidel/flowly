# Task type — 2026-10-15

Incremental spec. A card can carry a task type (what kind of work it is), alongside priority.

## Types

| Value | Label | Icon |
| --- | --- | --- |
| `feature` | Feature | Puzzle (was Sparkles; Sparkles now marks AI content, AI-MARK-SPEC) |
| `bugfix` | Bug fix | Bug |
| `research` | Research | FlaskConical |
| `refactor` | Refactor | Shapes |
| `docs` | Docs | FileText |
| `chore` | Chore | Wrench |

The list is fixed in `shared/model.ts` (`taskTypes`); no per-project customization in this increment.

## Data contract

- `task.type` is optional. Absent means "no type": every card created before this change, and new cards where the user leaves it unset. No board version bump or migration; older plugin builds ignore the field only if they do not strip it (zod `object` strips unknown keys on parse, so a downgrade drops types — acceptable, nothing else depends on them).
- `tasks.create` accepts optional `type`. `tasks.update` accepts `type`: a value sets it, `null` clears it, absent leaves it unchanged. Changing only the type is an ordinary `edited` event and bumps the task revision like other human edits.
- Agent tools do not change the type. `flowly_get_task` returns it inside `task`. The session context given at session creation / work instructions includes `Task type: <Label>` when set.

## UI

- Create/Edit task form: a **Type** choice (None + the six types) below Priority. Default None.
- Order everywhere (user 2026-10-15): priority first, then the optional type tag — every card has a priority, the type is optional.
- Card: priority and type render as one group of same-shape pills (20 pt, icon + label) at the start of the meta row, before session signals. The type pill and Low priority are neutral (muted tint); Urgent/High keep their accent tint. Normal priority and untyped cards add no pill.
- Drawer: Status, Priority, then a Type property button (shows "No type" when unset).
- Drawer dropdowns (user follow-up 2026-10-15 "in the side bar, changing status and tag should open a dropdown right next to the button" (translated)): Status, Type and Priority each open a dropdown anchored just below their own button (desktop web, the board's plugin context menu; the current value is checked). Choosing a value saves it immediately with the card's revision (CAS) and a success toast; choosing the current value does nothing. Type offers No type + the six types; Priority lists Urgent → Low. On phones/native the same entries open as the existing bottom sheet. This replaces the drawer's Status modal and the Type/Priority → Edit form shortcut; Edit still changes all fields.
- Details & workspace: a Type row.
- Filters: a **Type** filter (All, the six types) remembered in the board view settings (`filterType`), counted in the filter badge and cleared by Reset filters.

## Errors

- An unknown type value is rejected by schema validation (RPC input). A stored invalid value makes the board fail validation like any other invalid field; the data file is preserved, not reset.

## Verification

- Focused tests: store edit sets/clears the type and keeps it on unrelated edits; session context includes the type line only when set; board-view settings accept `filterType` and default to `all`.
- Typecheck and full `npm test`.
