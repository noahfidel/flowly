# Board polish: Attention dropdown, empty lanes, folded finished cards

Status: implemented on the user's request (card `5b2c9cd2`, "UI/UX细节优化", 2026-10-16):

1. PC上attention以drop down pop up展开: on desktop, Attention opens as a dropdown.
2. lane为空增加placeholder文本: an empty lane shows placeholder text.
3. 增加隐藏x天前done/cancelled的任务的功能，但仍然可以在done/cancelled中底部显示过去的done任务: hide Done/Cancelled cards older than X days, with the older ones still available at the bottom of those lanes.

This is presentation only. No board data, RPC, revision or native resource changes.

## 1. Attention dropdown (desktop)

- Desktop/tablet layout (not `compact`): the header **Attention** button, the `N` shortcut, the overview bar chips (needs you / unread / errors) and the attention deep link open a dropdown anchored under the header bell, right-aligned to it and kept inside the board surface (`client/popover.tsx`). The content is the same list as before: the read-state warning, rows with project · lane · counts and relative time, and the empty state. The header shows the card count.
- Selecting a row opens that card (and session) and closes the dropdown, as before. A click outside, `Esc`, pressing `N` again or the bell closes it. Any other board shortcut closes it and then runs. A resize of the board surface closes it, so it never floats away from the bell.
- The bell shows a pressed background and `expanded` accessibility state while open.
- Phones keep the bottom-sheet dialog. If the bell cannot be measured yet (e.g. a deep link opened before layout), the dialog is used as a fallback.
- Motion: a short opacity + 4 px rise (shared `useMotionPresence`, honours Reduce Motion). An exiting dropdown never catches clicks.

## 2. Empty lanes

- A desktop lane with no cards on screen shows a muted **No tasks** placeholder in the 72 px box that dragging already used. Idle it has no border. While a drag is running its dashed border appears and the text becomes **Drop to move here** over a target lane, so starting a drag no longer shifts the lane.
- If the lane only has folded older cards (§3), the text is **No recent tasks**.
- The phone list keeps its "No tasks in {lane}." + **Add task** empty state. With only folded cards it shows **No recent tasks** and the toggle.

## 3. Folded finished cards

- Setting: host-scoped board-view field `hideFinishedAfterDays` (integer 0–365, default **14**, 0 = show everything). UI: *Settings → Workflow → Finishing cards → Hide old finished cards*: Never / After 3, 7, 14, 30 days (an otherwise stored value is listed too).
- A card in **Done** or **Cancelled** is *older* when it entered its current lane more than N days ago. It entered at the latest `status_changed` event into its current status, or at `updatedAt` when no such event exists (`client/finished-cards.ts`, `olderFinished`). Other lanes are never folded. The open card is never folded.
- Older cards are not archived or changed. They sit at the bottom of their lane under a **Show {n} older tasks** row. Pressing it reveals them below the row (sorted by the board sort among themselves). **Hide older tasks** folds them again. Revealing is per lane, kept for the visit and reset when switching projects (not persisted).
- The lane header count still counts every card in the lane, folded ones included (desktop columns, collapsed strips and the phone lane picker row).
- Filters apply first: folded cards that do not match the filters are not counted.
- Keyboard grid navigation skips folded cards. Drag and drop slots follow the cards on screen. A card dropped into Done/Cancelled has just entered the lane, so it is recent.
- Archived cards follow **Show archived** as before. Folding applies on top.
- Onboarding: one-time tip `older-finished` (ONBOARDING-SPEC §5).

## 4. Acceptance

- Unit: `client/finished-cards.test.ts` covers the cutoff, Done/Cancelled only, the latest move into the lane winning over later edits or other lanes, reopen + finish again, 0 days, and the open card. `shared/settings.test.ts` covers the default and stored values. `client/onboarding-logic.test.ts` covers tip priority.
- Manual UI (desktop + phone): the dropdown position, outside click, `Esc`/`N`, overview chips, the deep-link fallback, the empty lane idle vs. drag, the toggle in Done/Cancelled, the setting round trip.
