# Compact board header — 2026-10-31

Spec: UI-UX-SPEC §5 (2026-10-31 compact header). Uncommitted working tree on `feat/guardrails`.

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm test` | 148 files, 1291 passed, 1 skipped |
| `make check` (typecheck + test) | exit 0 |
| Web compact (Tinylink, board width 390, light + dark) | header = project, bell, search, filters; New task FAB bottom-right; no page errors (`board-light.png`, `board-dark.png`) |
| Filters dialog on compact | `Sort cards` choices and `Card display…` visible (`filters-dialog-light.png`); `Card display…` closes it and opens Flowly settings (1 dialog open afterwards) |
| Android phone (SM-S911B) | UNRUN: `adb devices` listed no device |

Shots taken with `docs/promo/shot-lib.mjs` (opened wide to select Tinylink, then resized to 710 px, so the board is 390 px wide).

## Polish pass (same day)

Changes: Low/Normal priority icons use `ArrowDown` / `Minus` (the `SignalLow`/`SignalMedium` glyphs rendered as a nearly invisible stray mark); a collapsed section's summary ends at the row's right edge (`SectionHeader`, `Disclosure`) instead of floating mid-row; the Ideas/Memory source line keeps its lane name on one line and lets the card title truncate.

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm test` | exit 0; 148 files, 1291 passed, 1 skipped |
| `make check` | exit 0 |
| `impeccable detect` on the changed client files | `[]` (no findings) |
| Screenshots (shot-lib, desktop 1600 and compact 390, light and dark) | polish-drawer-desktop.png, polish-drawer-phone.png, polish-ideas-phone.png, polish-board-phone-dark.png; no page errors |
| Android device | UNRUN (no device connected) |

## card-display tip (compact)

- Compact layout: the `card-display` tip now points to "Filters → Card display"; desktop keeps "the Sort menu → Card display". A new string was added to all 9 catalogs, and the ONBOARDING-SPEC tip table was updated.
- `npm run typecheck` exit 0; `npm test` exit 0 (148 files, 1291 passed, 1 skipped); `make check` exit 0; plugin reloaded.
- Unrun: no screenshot of the tip itself (it shows only once on a board with 6+ active cards, which needs reset tip state); Android device not connected.
