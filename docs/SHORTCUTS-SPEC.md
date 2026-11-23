# F4 Desktop shortcuts — incremental spec (2026-10-15)

## 1. Research findings (Paseo 0.11.2)

| Capability | Finding |
| --- | --- |
| Plugin SDK shortcut registration | **None.** `PluginClientContext` in `@getpaseo/plugin@0.11.2` has only `addCommandCenterItem`, `addSlashCommand`, `addHeaderButton` and the like; `PluginCommandCenterItemContribution` has only `id/title/icon/keywords/context/onSelect`, with no key/chord field. |
| Host shortcut system | The installed host bundle has a full shortcut registry (`resolveShortcutKeysForAction`, `useKeyboardShortcutsStore`, the shortcut help dialog, user overrides), but action IDs are a fixed built-in set; a plugin cannot register one or appear in the host's shortcut help. |
| Global listening | The only global way is a `keydown` listener on `window`/`document`. AGENTS.md forbids DOM APIs, so this is **not adopted** for letter shortcuts. One exception (user-requested 2026-11-18, AGENTS.md): the double tap of Ctrl, §5, which listens on `window` and never swallows an event. |
| React Native Web | The host's RN-Web `View` forwards React synthetic event props such as `onKeyDown/onKeyDownCapture/onKeyUp` (the `keyboardProps` allowlist in the host bundle), and `focusable` maps to focusable. These are React event props on an RN primitive: they do not access `window/document/element` and do not write HTML/CSS. The React Native type definitions do not declare these props, so they are passed only when `Platform.OS === "web"`, as a typed web-only props object. |

**Trade-off:** there is no compliant "global" shortcut. Two complementary paths are implemented:

1. **In-board shortcuts (scoped):** the board's root `View` is focusable on web and receives the `onKeyDown` that bubbles up. They work only while keyboard focus is inside the board (after clicking the board/a card/a button); they do not work when focus is in the host sidebar, the host input box or another pane.
2. **Command Center items (global):** global items are registered in the host's Command Center, so the same actions can be reached by keyboard from anywhere (the host's Command Center shortcut → type → Enter).

## 2. Observable behavior

### 2.1 In-board shortcuts (desktop web, non-compact layout)

| Key | Action | Precondition |
| --- | --- | --- |
| `T` | Open "New task": Quick task when *Quick task for New task* is on (default), otherwise the full form (default Todo; QUICK-TASK-SPEC §5) | A current project exists and is not archived |
| `Q` | Open Quick task, the project defaulting to the one last used for Quick task, otherwise the current project (QUICK-TASK-SPEC §3) | At least one unarchived project |
| `P` | Open / close the Pull requests menu (PR-MENU-SPEC D24); help row "Pull requests"; the PR chip shows the hint "P" | The board shows a PR chip; otherwise not consumed |
| `G` | Open the group switcher (BOARD-GROUPS-SPEC); help row "Switch group" | — |
| `A` | Open / close the Guardrails page (GUARDRAILS-SPEC); the Guardrails chip shows the hint "A" | A current project exists with memory on; otherwise not consumed |
| `/` or `F` | Open the filter/search popover | A current project exists |
| `S` | Open / close the Search page (SEARCH-SPEC §5) | A current project exists |
| `N` | Start stepping through "N need you" one card at a time (same as that button in the overview bar, `startStep("needs")`; help row "Step through what needs you") | A current project exists or All projects |
| `U` | Start reading "N unread" one card at a time (same as that button in the overview bar, `startStep("updated")` and the re-press rule of `stepStartTarget`; waits for the board and sessions to load; with nothing to read, toast "Nothing unread."; help row "Step through unread cards"; the button shows the shortcut hint "U"). Ruling (Noah, 2026-11-10) | A current project exists or All projects |
| `D` | Open the left Dispatcher chat dock and focus the message box; if already open, only focus the message box. `D` never closes the dock, only `Esc` closes it (Ruling, Noah 2026-11-09); when focus is in the message box, it types "d" | The board has a dock (project or All projects) |
| `⌃[` / `⌃]` on macOS (Control, not `⌘`); `Alt+←` / `Alt+→` on Windows and Linux (ruling, Noah 2026-11-18, replacing the `⌥←` / `⌥→` of 2026-11-16 on macOS) | Back / Forward through what was opened, same as the header buttons (UI-REFRESH-SPEC §7ae; the button labels show `⌃[` / `⌃]` on Apple systems and `Alt+←` / `Alt+→` elsewhere; help row keys `⌃[ ⌃]`, title "Back / forward (Alt+← / Alt+→ on Windows and Linux)"). Each platform has one pair: `⌥←` / `⌥→` no longer navigate on macOS, and `Ctrl+[` / `Ctrl+]` are not used on Windows and Linux because Paseo binds them there to its previous / next workspace. `⌘[` / `⌘]` stay with Paseo on macOS (its previous / next workspace). Checked with a real keystroke in Chrome on macOS: `⌃[` arrives as `key "["`, `code "BracketLeft"`, `ctrlKey`, with no Escape event, so it does not trigger Esc handling | Always consumed on the board, even with nowhere to go; off while a text box, modal or picker has focus (`useShortcutBlock`) |
| `?` | Open the shortcut help popover | — |
| `Esc` | Acts on the area the user is in (Ruling, Noah 2026-11-09): first an open popover; then, if the dock is the active area (the message box got focus or was pressed in the dock, and nothing elsewhere on the board was pressed since): message box focused with a draft → only blur (the draft is kept, the dock stays the active area), otherwise close the dock and give focus back to the board; then, in order: sidebar open (detail or session preview) → close the whole sidebar at once (Ruling, Noah 2026-11-10: there is no longer a "back from session" step; the ← Back in the chat header still returns to the card detail; closing the card ends the step-through); on the Projects page → leave it (the dock stays open) | See left |
| `J` / `K` | Next / previous card in the current column (opens its sidebar); with no card selected, selects the first card of the first column | There are visible cards |
| `H` / `L` | The nearest non-empty column to the left / right, same row number (past the end, take the last card) | There are visible cards |
| `O` | Open the active session chat of the card open in the sidebar, by the same rule and the same one-time entry as the board's card double click (first of the Quick links order; waits until the card's sessions are known); with no session, toast "No session yet."; help row "Open the open card's active session". The double click stays silent | A card is open in the sidebar; otherwise not consumed |
| `R` | Open the card's newest pull request (GitHub PR / GitLab MR, the first PR chip of the Quick links) in the browser, as the chip does; waits until the card detail is loaded; with no pull request, toast "No pull request yet."; help row "Open the open card's newest pull request" | A card is open in the sidebar; otherwise not consumed |
| `←` / `→` | Agent multi-question ask: previous / next question (no wrap; attached to the question form itself, not routed through board shortcuts, see SESSION-QUESTION-SPEC §2) | Focus is inside the question form and not in an input |

- Ruling (Noah, 2026-11-10): `N` starts stepping through "N need you" (it was `A`), `T` opens "New task" (it was `N`), and `A` is no longer bound to any action (freed, no alias). All shortcut hints (the need button, the New task button, the help popover) are updated accordingly.
- Ruling (Noah, 2026-11-18): the PR shortcut is `R`, because `G` stays Guardrails.
- Ruling (Noah, 2026-11-23): `P` opens and closes the Pull requests menu, the group switcher moves from `P` to `G`, and Guardrails moves from `G` to `A`.
- Uppercase letters (`CapsLock`) are equivalent to lowercase; any other combination with `Cmd/Ctrl/Alt` is never handled and is left to the host shortcuts (the exception is Back / Forward: `⌃[` / `⌃]` on macOS, `Alt+←` / `Alt+→` elsewhere, each with no other modifier). `⌘[` / `⌘]` (macOS) and `Ctrl+[` / `Ctrl+]` (Windows and Linux) are Paseo's previous / next workspace and go to the host. Letters with `Shift` held (such as `Shift+N`) are not handled; characters that themselves need Shift, such as `?`, are handled as usual.
- Auto-repeat (key held) and events during IME composition (`isComposing`) are ignored.
- A handled key calls `preventDefault` + `stopPropagation`; an unhandled one bubbles to the host unchanged.
- Card navigation follows the desktop column display order (`position`, then `createdAt`) and moves only within the current filter result; navigating selects and opens the sidebar (same as clicking a card) and does not scroll the column automatically.

### 2.2 Blocking conditions (any one stops the shortcut from firing)

- Any text input inside the plugin has focus (`Field`, the session follow-up input).
- Any host `Modal` owned by the plugin is open (project/filter/Attention/status/card actions/form/new session/Wrap up/session editor/shortcut help, etc.). Then Esc is handled by the host Modal itself.
- The compact layout, native platforms (iOS/Android), and "New task" while a write operation is running likewise do not take effect.

- While the Pull requests menu is open the board is blocked, so the menu itself takes a bare `P` (`prMenuClosesOn`, no modifier, no repeat, no IME composition) and closes; `Esc` is the host Modal's. On open, focus moves into the menu so `Tab` and `Esc` work there. When the menu closes by any route, focus returns to the board root after the Modal has closed (`MODAL_CLOSE_MS`), so the next shortcut arrives.

Blocking is implemented by a reference count inside the plugin (`useShortcutBlock` in `client/shortcuts.ts`): inputs register on `onFocus/onBlur`, all plugin Modals register on `open` through the wrapper in `client/modal.tsx`, and they unregister when the component unmounts. The DOM `activeElement` or `event.target` is not read.

- An input removed while it has focus releases its block. React ignores DOM events while it commits, so such an input never reports `onBlur` (the tag input closed by Esc or Enter, the picker search closing, the dispatcher box replaced by its Start view while the dock stays mounted), and an owner that tracks focus through `onFocus`/`onBlur` would keep every board shortcut off until it unmounts. `TextBox` and the session composer box send that missing blur to their owner when they unmount while focused (`useBlurOnUnmount`).
- A handled board shortcut moves focus to the board root before its change renders (`shortcutRefocusesBoard`; every action except `D`, which focuses the dispatcher's message box). The card sidebar is keyed by card, so Back / Forward and `J`/`K`/`H`/`L` remount it; focus held inside it would otherwise fall to the page body, outside the board, and the next shortcut would not arrive.

Known limitation: after a host Modal closes, focus may return to the page root, and you need to click the board once more to keep using shortcuts; this is the cost of not using a global listener.

### 2.3 Discoverability

- The desktop header gets a new "Keyboard shortcuts" icon button (the `Keyboard` icon); clicking it or pressing `?` opens the help popover, which lists all keys and descriptions, says "focus must be inside the board", and says that searching "Flowly" in the Command Center reaches the items of §2.4.
- The accessibility labels of the desktop header's Projects / Attention / Filter / New task / help buttons carry the shortcut (such as `New task (T)`, `Task filters (/)`). The RN-Web-specific `accessibilityKeyShortcuts` is not used, because React Native types do not declare it.

### 2.4 Command Center items (global)

| Item | Behavior |
| --- | --- |
| `Flowly: View board` | Open the board (id `open-board`). On the web, while the double tap of Ctrl is on (§5), the title is `Flowly: View board (double-tap Ctrl)`; the id is unchanged |
| `Flowly: Quick task` | Open the board and open Quick task (intent `quick-task`, QUICK-TASK-SPEC §5) |

Flowly registers only these two items, in this order (QUICK-TASK-SPEC §7), and registers no workspace-context items. The other intents (`attention`, `new-task`, `projects`, `filters`, `search`, `shortcuts`, `welcome`) have no Command Center item but are still valid as screen params, and the buttons and shortcuts on the board work as before.

Data contract: `openScreen({ screenId: "board", params: { intent, at } })`.

- `intent ∈ {"new-task","quick-task","projects","filters","attention","shortcuts","welcome","search"}`; `at` is the decimal string of `Date.now()`.
- The board consumes each `(intent, at)` only once; when `at` is more than 30 seconds from now (for example left in the URL after a page refresh), or its format is invalid, or the intent is unknown, it is ignored without error.
- It does not conflict with the session chip link params (`taskId/sessionId/workspaceId/requestId`); the intent param does not enter `parseSessionLink`.
- `new-task` does not open the form when there is no project or the project is archived (consistent with the button's disabled state); the other intents run after data loading completes.

## 3. Errors

- Shortcuts and Command Center intents create no new error paths and call no RPC; when blocked or a precondition is not met they silently do not respond (consistent with a disabled button).

## 4. Acceptance

1. Pure-logic unit tests: key parsing (case, modifier keys, repeat, IME, blocking, compact), card grid navigation (empty board, first selection, up/down within a column, across columns/skipping empty columns/row number clamping), intent param parsing (freshness, unknown values, repeated consumption).
2. `npm run typecheck` and `npm test` pass.
3. UNRUN (needs a real host window): actual key triggering on desktop, how focus enters the board, the host Command Center items showing and navigating, the look of the help popover.

## 5. Double tap of Ctrl (user-requested 2026-11-18)

Two quick taps of Ctrl anywhere in Paseo open the Flowly board, exactly as the sidebar entry and `Flowly: View board` do (`openScreen({ screenId: "board" })`, no params).

### 5.1 Behavior

- **Where:** the web client only (Paseo desktop app and browser). iOS and Android have no window keyboard events and install nothing.
- **A tap** is a Ctrl keydown (`key === "Control"`, no Shift, Alt or Meta held, not a repeat) followed by its Ctrl keyup, with no other keydown in between, the press lasting at most `DOUBLE_TAP_MS` = 300 ms (`client/double-tap.ts`). Holding Ctrl longer is not a tap.
- **Fires** when the second tap's keydown comes within 300 ms of the first tap's keyup, on the second tap's keyup. After firing the detector starts over: a triple tap opens the board once; a fourth tap pairs with the third.
- **Resets:** any other keydown (Shift, Alt, Meta, Tab, letters, …), a pointer or mouse down anywhere, and the window itself losing focus (a `blur` whose target is the window; focus moving between elements does not reset). Repeat keydowns are ignored (they neither count nor reset), but a held Ctrl still fails the 300 ms rule. A Ctrl keydown while Ctrl is thought to be down (its keyup was missed) restarts from that press as a first tap.
- **Text fields:** it fires even while a text field, the session message box or a terminal has focus. A bare Ctrl tap types nothing there, so nothing is lost; this is what makes it "from anywhere".
- **Never swallows events:** the listener never calls `preventDefault` or `stopPropagation`. Every key still reaches the host, other plugins and the focused field.

### 5.2 Install and hosts

- `client/double-tap-install.ts` adds capture-phase `keydown`, `keyup`, `pointerdown`, `mousedown` and `blur` listeners on `window` (AGENTS.md exception). It is feature-detected (`Platform.OS === "web"`, `globalThis.addEventListener`) and never throws.
- Paseo evaluates the plugin client once per connected host. A `globalThis` slot (`__flowlyDoubleTapCtrl`) holds the one listener and the list of live installs, one per host. With several hosts, a double tap opens the board through the first host (in install order) whose setting is on, not necessarily the host on show. When no host is known to be on, every host not known to be off is read together and the first that reads on opens. Each host's `contribute` cleanup removes its install; the last one removes the listeners.

### 5.3 Setting

- Host setting `shortcuts.doubleTapCtrl` (boolean, default `true`), the switch **Double-tap Ctrl to open Flowly** in Settings → General → **Keyboard**, shown only on the web, with the detail *Works anywhere in Paseo, even while typing. Turn off if macOS Dictation uses a double press of Control.*
- No read at plugin load (cold start, PERFORMANCE-SPEC): each install reads its host's setting about 3 s after load. On a double tap: when the cached value is on, the board opens at once and the value is read again in the background; when it is off or unknown, the setting is read first and the board opens only if it is on. A failed read keeps the value already known, or falls back to the default (on) when nothing is known yet. Turning the switch changes the cache at once, then every host's value is read again about 1.5 s later.
- The `Flowly: View board` Command Center title (§2.4) and the help row (§5.4) name the gesture only while it is on; a read that finds it off re-registers the Command Center items with the plain title.

### 5.4 Discoverability

- The board's Keyboard shortcuts popover lists **Open Flowly from anywhere in Paseo (double-tap Ctrl)** with the keys `Ctrl` `Ctrl`, while the gesture is on.
- One-time tip `double-tap-ctrl` (ONBOARDING-SPEC, tip table): *Double-tap Ctrl anywhere in Paseo to open Flowly. Turn it off in Settings → General.*

### 5.5 Clashes

- **Workspace Switcher plugin** (Ctrl+Tab and Ctrl+` hold modes): those modes hold Ctrl longer than 300 ms and press another key, so they are never a tap. Nothing is swallowed, so the switcher keeps working. The switcher stops propagation of keys while its modes are open, so this listener may miss the Tab keydown or the Ctrl keyup; the 300 ms press rule still rejects the hold, and a missed keyup is handled by the restart rule. Known rare case: if the switcher swallows a Tab keydown, two very quick Ctrl+Tab presses, each released within 300 ms, can read as a double tap and open Flowly (harmless).
- **macOS Dictation** can be set to *Press Control Key Twice*; then both Dictation and Flowly react. Turn one of them off.
- Host shortcuts using Ctrl with another key are combos, never taps.

### 5.6 Acceptance

1. Detector unit tests (`client/double-tap.test.ts`): two quick taps fire; a late second tap or a held Ctrl does not; another key, a Ctrl combo, Ctrl with Shift/Alt/Meta or a reset between taps prevents it; repeats are ignored; a triple tap fires once; a missed keyup restarts.
2. `npm run typecheck` and `npm test` pass.
3. UNRUN (needs the live app): the board opens on a double tap in the desktop app with focus in the board, the host sidebar, a session message box and a terminal; the switch turns it off at once; the Workspace Switcher's Ctrl+Tab hold never opens the board; the Command Center title follows the switch.
