# Board card menu repro (observed on the installed plugin, not the working tree)

Project: Tinylink was not available, so the **flowly** project was used (3 cards in Development on desktop, 6 in Backlog on compact). Headless Chromium via `docs/promo/shot-lib.mjs`. Read-only: menus were opened and left, nothing was clicked in them, no card changed. Run on the installed plugin build, which may differ from the working tree.
Screenshots were removed (they showed other projects' tab names); the rows and boxes below are the evidence.

## Results

| Step | Result | Rows seen |
|---|---|---|
| 1. Wide 1700x1000, ⋯ on top card | PASS (claim true) | Header = card title; Open details, Open workspace, Switch to local…, Start session, Link to a card…, New follow-up task, Dismiss from Attention, Move up, Move down; "Move to": Backlog, Todo, Design, Development, Test, In review, Committed, Integrated, Blocked, Done, Cancelled. **No Archive, no Delete permanently…** Rows reach y=1007 in a 1000px window (Cancelled clipped), but the sheet scrolls; after wheel the last row is Cancelled (y 864-884). |
| 2. Bottom card ⋯, wide and 1700x600 | PASS (claim true) | Identical rows. At 600px tall the list is clipped at the window but scrolls; last row after scrolling is still Cancelled. No Archive/Delete. |
| 3. Right-click, wide 1000 | Menu complete and visible | Open details, Open workspace, Switch to local…, Start session, Link to a card…, New follow-up task, Dismiss from Attention; Move to: Backlog…Cancelled; Move up, Move down, **Archive card, Delete permanently…** (y 812-831 and 842-861). Menu box x=876 y=152 w=232 h=719, bottom=871 (fits). Same for top and bottom card. |
| 3b. Right-click, 1700x600 | FAIL (clip confirmed) | Same rows; menu box y=40..759, h=719, bottom=759 > 600. Cancelled, Move up/down, Archive card (700-719) and Delete permanently… (730-749) are all below the 600px window. Menu has no scroll (wheel did nothing); Delete is unreachable. Top and bottom card give the same box (placement clamps to the top). |
| 4. Compact 400x800, ⋯ on a card | PASS (claim true) | Bottom sheet titled with the card: Open details, Open workspace, Switch to local…, Start session, Link to a card…, New follow-up task, Move up, Move down; Move to: Backlog…Cancelled. Scrolls to the end; the last row is Cancelled (y 760-780). **No Archive, no Delete permanently…** |

## Hypotheses

- Confirmed: the board card's ⋯ menu (wide popover-style sheet and compact bottom sheet) has no Archive and no Delete permanently…; only right-click has them (wide). Compact long-press was not tested (no touch long-press attempted).
- Confirmed: the right-click menu is not height-limited. It is 719px tall and is cut off at the bottom of windows shorter than ~760px, with no scrolling, so Archive card and Delete permanently… are unreachable there. At 1000px it fits.
- Not as hypothesised: the ⋯ menu in this installed build is a scrollable sheet that also lists "Move to" and is not a "Task actions" modal with a different title; the code reading may refer to a newer or older build.

## Notes

- The ⋯ sheet rows reach past the window bottom at first open (needs a scroll to reach Cancelled).
- Cleanup: no Paseo resources were created. Temp files only in /tmp/repro.
