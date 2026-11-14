# F3: in-column drag reorder and cross-column placement at a point

Status: incremental spec of 2026-10-15, written before the implementation. Upstream: [UI-UX-SPEC §3](UI-UX-SPEC.md#3-desktop-drag-to-change-status), [MOTION-SPEC](MOTION-SPEC.md), [UI-REFRESH-SPEC](UI-REFRESH-SPEC.md). This document only extends the drop target of desktop dragging; the other drag rules (whole-card mouse drag, the 8 pt threshold, click suppression, non-selectable text, horizontal edge scrolling, cancel conditions) are unchanged.

## 1. Observable behavior

- On desktop (expanded layout, primary mouse button), while dragging a card, a 2 pt accent insertion line is shown in the column under the pointer, between the two cards it would be inserted between (or at the column start / end). The insertion line position follows the pointer immediately, with no easing on the coordinates; it appears/disappears with the shared 120 ms opacity transition and follows Reduce Motion.
- Same-column drag: dropping at a new position changes the order. When the drop position equals the card's original position (the insertion line would sit right next to itself), the insertion line is not shown and releasing writes nothing.
- Cross-column drag: the target column is highlighted (the existing accent overlay), and the insertion line shows the drop position; an empty column shows the existing dashed "Drop to move here" placeholder, with the drop position at the column end. On release the card changes status and position together in one write.
- The insertion position is decided by "comparing the pointer y with the midline of each visible card": if the pointer is above a card's midline, insert before that card; if it is below the midlines of all cards, insert at the column end. The dragged card itself does not take part in the comparison. Column titles, column gaps, the toolbar, the sidebar and anything outside the board are not drop targets.
- The column's vertical scroll offset takes part in hit testing (scrolling the column with the wheel during a drag still gives the right position). The existing behaviors such as horizontal edge auto-scroll and disabling horizontal gesture scrolling during a drag are unchanged.
- The floating preview's subtitle: "Move to <Status>" across columns; "Reorder in <Status>" for a valid same-column drop; otherwise "Drag to reorder or move".
- Success: across columns show the existing native toast "Moved to <Status>"; a same-column reorder shows no toast (the card's position change is the feedback). Failure: show the existing error bar, refresh the board, make no optimistic update and do not automatically retry with a new revision.
- Cancel (responder terminated, pointer cancelled, switching project/filter/layout, the card disappears), dragging out of the board, or during a pending write: write nothing.
- Phone/touch/compact layouts do not install the drag responder, and ordering still uses the action menu's Move up / Move down (`tasks.move`, behavior unchanged).

## 2. Data contract: `tasks.place`

New RPC `tasks.place`, input (strict):

```ts
{ id: string; revision: int > 0; status: Status;
  beforeId: string | null;   // insert before this card
  afterId: string | null }   // insert after this card; at most one of the two is non-null, both empty means column end
```

The client picks the anchor by visible cards: if there is a visible card after the drop position → `beforeId` = the card right after the drop position; if the drop position is the end of a visible column and the column is non-empty → `afterId` = the last visible card; an empty column → both null. The anchor is based on visible cards, so cards hidden by a filter keep their relative order.

Server (`BoardStore.placeTask`, run in the store's serial transaction, atomically replacing the write of board.json):

1. The card does not exist → `Task not found.`; the revision does not match → `Revision conflict: this card changed. Reload before moving.` (CAS, no write).
2. The card or its project is archived → reject, no write.
3. The anchor equals the card itself, the anchor does not exist, belongs to another project or is not in the target status column → `Drop position changed. Reload and try again.`, no write.
4. Target column = the other cards of the same project and target status (including archived cards, so that anchors stay valid when a filter shows archived cards), sorted by `position`, `createdAt`.
5. Same column and the computed insertion index equals the current index → no change, no file write, no revision increase, return the original card.
6. The new `position` is the midpoint of the neighbors before and after; at the column start it is the first card −1, at the column end the last card +1, for an empty column 0. If equal neighbor positions make it impossible to sit strictly in between, first normalize the position of the other cards in the target column to 0..n−1 (change only position, not revision/updatedAt/other fields), then take the midpoint.
7. Change only the moved card's `status` and `position`, `revision` +1, `updatedAt` updated; title, description, priority, workspace, archive, scope and other fields are unchanged; other cards' revisions are unchanged (so no other card's edit draft or agent snapshot is invalidated).
8. When the status changes, record a `status_changed` event (actor human, from/to), consistent with changing status in the sidebar; a same-column reorder records no event.
9. Same column or across columns, there is only one transaction and one atomic write; the board revision goes up by 1 only.

The new card's position in `tasks.create` becomes the target column's maximum position + 1 (0 when the column is empty), so a new card still lands at the column end when fractional/negative positions exist. `tasks.move` (menu move up/down) keeps its original behavior.

## 3. Client structure

- `client/geometry.ts` adds pure functions:
  - `dropSlot(contentY, cards, draggedId)`: by midline returns the insertion index (excluding the dragged card), the `beforeId`/`afterId` anchors and the content-coordinate y of the insertion line.
  - `placementUpdate(task, target, slot, column)`: returns the `tasks.place` input, or null when dragged out of the board, dropped at the same position in the same column, or the same column's list position has not been measured yet (across columns with no measurement, it lands at the column end).
- `client/columns.tsx`: record each card's layout in the column content (`onLayout`), each column's vertical scroll offset and the list's top window coordinate (`measureInWindow` at drag start), compute the slot during the drag and draw an absolutely positioned insertion line (no layout element is inserted, to avoid jitter from card displacement).
- `client/board.tsx`: `onDrop` now calls `tasks.place`, keeping the `doAction` mutual exclusion, the error bar and the refresh.
- No DOM/HTML drag events or global listeners; only React Native primitives and the host theme colors.

## 4. Acceptance

| Item | Expected |
|---|---|
| Hit testing | Above/below the midline, column start, column end, empty column, the dragged card itself excluded, scroll offset, all have pure-function tests |
| Same column no change | Releasing at the original position does not call the RPC; a server request for the same position writes no file and the revision does not change |
| Same-column reorder | One write, changing only that card's position/revision/updatedAt, other cards' revisions unchanged |
| Cross-column placement | One write changes status and position together and records status_changed |
| CAS | An old revision is rejected and the file is unchanged; of two concurrent requests with the same revision only one succeeds |
| Stale anchor | An anchor not in the target column / not existing / the card itself is rejected with no write |
| Position conflict | With equal neighbor positions, the insertion order is correct after normalization |
| Cancel/drag out/failure | No write; a failure shows an error with no optimistic update |
| Regression | Horizontal edge scrolling, click to open, and touch-layout menu ordering are unchanged |

The real desktop UI (insertion line look, drag feel) needs manual or Luna acceptance in the host; this card does not install/reload the plugin as the user asked, so it is recorded as UNRUN.

## 2026-10-15 merge review amendments

- Menu Move up / Move down now uses the same `placeTask` path as dragging (anchor = adjacent visible card). One ordering rule; only the moved card's revision changes. The old integer renumbering that bumped every peer's revision is removed.
- When neighbors share a position, peers are renumbered in place without revision bumps. Order is preserved, positions carry no user-edited data, and placements anchor on card IDs, so a stale peer edit cannot misplace a card.
