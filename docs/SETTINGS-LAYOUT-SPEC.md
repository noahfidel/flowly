# Settings modal: two columns by function

Status: implemented on the user's request (2026-10-16): "Redesign the UI of the ultra kanban settings menu: use two columns, left and right, split by function" (translated).

- Left column: four sections, each with an icon. Right column: the settings of the selected section, in their own scroll area. The window is plugin-owned (a React Native `Modal` with a backdrop, title bar and close button) instead of the host Modal, whose width is fixed at about 520 px: it is up to 900 px wide (window width − 32 on small windows), the body has a fixed height (≤ 470, shrinks on short windows) so switching sections does not resize it. Esc, a click on the backdrop and the close button close it; board shortcuts are paused while it is open.
- Sections: **General** (Language; Welcome tour and tips), **Models** (default model for new sessions; summary model, see [MODEL-DEFAULTS-SPEC](MODEL-DEFAULTS-SPEC.md)), **Workflow** (Moving cards; Finishing cards: auto wrap up, auto archive on delete), **AI features** (task progress summary and daily digest switches; Ideas).
- Each page has a title and a one-line purpose; settings sit in titled cards of rows (name and explanation on the left, the control on the right, hairlines between rows). Components: `client/settings-ui.tsx` (`SettingsPage`, `SettingsGroup`, `SettingRow`, `SettingSwitch`, `SettingSelect`), pages in `client/settings-pages.tsx`. A select row opens its choices under it (`OptionList`, shared with the form pickers).
- Narrow windows (window < 592 px wide, i.e. the window itself is under 560 px, e.g. phones): the section list becomes a horizontally scrolling strip of chips above the settings, the selected chip outlined.
- The first section opens each time the modal is mounted fresh; the selected section is kept while the modal stays mounted. Switching sections fades the content in (`Enter`, honours Reduce Motion).
- New text goes through `t()`; catalogs gained `General`, `Workflow`, `AI summaries`, `Settings sections`, and `Device ({language})` replaced the longer language label so it fits the narrow right column.

Acceptance: [verification/settings-layout.md](verification/settings-layout.md).
