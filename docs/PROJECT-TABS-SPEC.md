# Desktop project tabs and last-viewed project

> **Superseded (draft, 2026-11-10):** group tabs replace project tabs and the All tab (BOARD-GROUPS-SPEC v2 §3). Kept as history.

Status: requested by the user on 2026-10-15 (card “优化project系统”).

## Behavior

- **Desktop (non-compact) header** replaces the project switcher button with a row of project tabs in chooser order (`projectOrder`; archived projects only while *Show archived* is on, with an Archive icon). One click switches project. Active tab: `surface2` background and foreground text; others muted, `surface1` on hover. All tabs use the same font weight so switching never shifts widths. Tabs are capped at 220 pt with ellipsis; overflow scrolls horizontally and the active tab is scrolled into view when it changes from elsewhere (chooser, linked session).
- Before the tabs, while available: **All**, the All projects board (ALL-PROJECTS-SPEC), then one tab per board
  group (BOARD-GROUPS-SPEC §1). After the tabs: **+** (New project) and **⇕ Manage projects** (the existing chooser: reorder, edit, archive; shortcut `P` unchanged; labelled *All projects* before the All tab existed).
- **Tab context menu** (card “project tab增加contextual menu”, 2026-10-19): right-click a tab (long-press on touch) opens the shared plugin menu (`client/context-menu.tsx`) titled with the project name:
  - *Project settings* (the project form: name, folder, lanes, auto status) · *New task* (disabled for an archived project)
  - *Insights* · *Ideas* (only while Ideas is on)
  - *Move left* / *Move right* (same `moveProject` up/down as the chooser; disabled at the ends and while an action is pending) · *Restore* (archived projects only)
  - *Remove…* (danger; the existing Remove dialog, `PROJECT-REMOVE-SPEC`)
  Settings, New task, Insights and Ideas first switch the board to that project, then open; reorder, Restore and Remove act on it without switching. A plain click still only switches project; the browser's own menu stays suppressed.
- **Drag to reorder** (same card, 2026-10-19): drag a tab with the mouse along the row; it lifts and follows the pointer, the tabs it passes slide aside, and dropping saves the order (the shared `SortableList`, horizontal mode; same `moveProject` with an optimistic order as the chooser's drag). A drag starts after 6 pt of horizontal movement, so a click still switches project and the release after a drag is not a click. Disabled while a project action is pending. Touch keeps the menu's Move left/right.
- Compact/phone layouts and the no-project state keep the existing switcher button (its chooser keeps Edit/Restore/Remove).
- **Which project opens:** an explicit choice in this board instance → the project (or All, ALL-PROJECTS-SPEC §8) last viewed during this app run → the first project in chooser order. "Last viewed" is client module state, so leaving Ultra Kanban and coming back restores it, while a cold start (new client bundle) opens the first project. Opening the board from a linked workspace/session still selects that card's project, and that becomes the last viewed one.
- The persisted `board-view.lastProjectId` setting is no longer read or written; the field stays in the schema for compatibility with stored values.

## Acceptance

- Tab menu: right-clicking a non-active tab and picking *Project settings* opens that project's form with the board switched to it; *Move left/right* reorder the tabs and the chooser alike; *Remove…* opens the Remove dialog for that project.
- Dragging the first tab past the second swaps them in the tabs and the chooser and keeps the active project; dragging it back restores the order.
- Onboarding: one-time tip `project-menu` once desktop tabs show two or more projects (`client/onboarding-logic.test.ts`).
- Unit (`client/project-memory.test.ts`): cold start → first; remembered project restored; explicit choice wins; vanished project falls back to the first.
- Headless web client at 1440×900 against the reloaded plugin: tabs render; switch → leave the board → return keeps the switched project; page reload opens the first project.
