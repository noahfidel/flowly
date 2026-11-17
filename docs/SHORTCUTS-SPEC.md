# F4 Desktop shortcuts — incremental spec (2026-10-15)

## 1. Research findings (Paseo 0.11.2)

| Capability | Finding |
| --- | --- |
| Plugin SDK shortcut registration | **None.** `PluginClientContext` in `@getpaseo/plugin@0.11.2` has only `addCommandCenterItem`, `addSlashCommand`, `addHeaderButton` and the like; `PluginCommandCenterItemContribution` has only `id/title/icon/keywords/context/onSelect`, with no key/chord field. |
| Host shortcut system | The installed host bundle has a full shortcut registry (`resolveShortcutKeysForAction`, `useKeyboardShortcutsStore`, the shortcut help dialog, user overrides), but action IDs are a fixed built-in set; a plugin cannot register one or appear in the host's shortcut help. |
| Global listening | The only global way is a `keydown` listener on `window`/`document`. AGENTS.md forbids DOM APIs, so this is **not adopted**. |
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
| `P` | Open the project switcher popover | — |
| `/` or `F` | Open the filter/search popover | A current project exists |
| `S` | Open / close the Search page (SEARCH-SPEC §5) | A current project exists |
| `N` | Start stepping through "N need you" one card at a time (same as that button in the overview bar, `startStep("needs")`; help row "Step through what needs you") | A current project exists or All projects |
| `U` | Start reading "N unread" one card at a time (same as that button in the overview bar, `startStep("updated")` and the re-press rule of `stepStartTarget`; waits for the board and sessions to load; with nothing to read, toast "Nothing unread."; help row "Step through unread cards"; the button shows the shortcut hint "U"). Ruling (Noah, 2026-11-10) | A current project exists or All projects |
| `D` | Open the left Dispatcher chat dock and focus the message box; if already open, only focus the message box. `D` never closes the dock, only `Esc` closes it (Ruling, Noah 2026-11-09); when focus is in the message box, it types "d" | The board has a dock (project or All projects) |
| `⌥←` / `⌥→` (Option on mac, `Alt+←` / `Alt+→` on other systems; user decision 2026-11-16: easier to press than `⌘⌥←` / `⌘⌥→`, which is not accepted) | Back / Forward through what was opened, same as the header buttons (UI-REFRESH-SPEC §7ae; the button labels show `⌥←` / `⌥→` on Apple systems and `Alt+←` / `Alt+→` elsewhere; help row "Back / forward (Alt+← / Alt+→ on Windows and Linux)"). `Ctrl+←` / `Ctrl+→` and `⌘`, `Ctrl` or `Shift` added to the chord are not used (macOS desktop switch, word move). Option+arrow word-move in text boxes is unaffected because board shortcuts are off while one has focus | Always consumed on the board, even with nowhere to go; off while a text box, modal or picker has focus (`useShortcutBlock`) |
| `?` | Open the shortcut help popover | — |
| `Esc` | Acts on the area the user is in (Ruling, Noah 2026-11-09): first an open popover; then, if the dock is the active area (the message box got focus or was pressed in the dock, and nothing elsewhere on the board was pressed since): message box focused with a draft → only blur (the draft is kept, the dock stays the active area), otherwise close the dock and give focus back to the board; then, in order: sidebar open (detail or session preview) → close the whole sidebar at once (Ruling, Noah 2026-11-10: there is no longer a "back from session" step; the ← Back in the chat header still returns to the card detail; closing the card ends the step-through); on the Projects page → leave it (the dock stays open) | See left |
| `J` / `K` | Next / previous card in the current column (opens its sidebar); with no card selected, selects the first card of the first column | There are visible cards |
| `H` / `L` | The nearest non-empty column to the left / right, same row number (past the end, take the last card) | There are visible cards |
| `←` / `→` | Agent multi-question ask: previous / next question (no wrap; attached to the question form itself, not routed through board shortcuts, see SESSION-QUESTION-SPEC §2) | Focus is inside the question form and not in an input |

- Ruling (Noah, 2026-11-10): `N` starts stepping through "N need you" (it was `A`), `T` opens "New task" (it was `N`), and `A` is no longer bound to any action (freed, no alias). All shortcut hints (the need button, the New task button, the help popover) are updated accordingly.
- Uppercase letters (`CapsLock`) are equivalent to lowercase; any other combination with `Cmd/Ctrl/Alt` is never handled and is left to the host shortcuts (the exception is `⌥←` / `⌥→` (`Alt+←` / `Alt+→`) with no other modifier). `⌘[` / `⌘]` and `Ctrl+[` / `Ctrl+]` are not used: they clash with Paseo's own shortcuts (user decision 2026-11-16), so they go to the host. Letters with `Shift` held (such as `Shift+N`) are not handled; characters that themselves need Shift, such as `?`, are handled as usual.
- Auto-repeat (key held) and events during IME composition (`isComposing`) are ignored.
- A handled key calls `preventDefault` + `stopPropagation`; an unhandled one bubbles to the host unchanged.
- Card navigation follows the desktop column display order (`position`, then `createdAt`) and moves only within the current filter result; navigating selects and opens the sidebar (same as clicking a card) and does not scroll the column automatically.

### 2.2 Blocking conditions (any one stops the shortcut from firing)

- Any text input inside the plugin has focus (`Field`, the session follow-up input).
- Any host `Modal` owned by the plugin is open (project/filter/Attention/status/card actions/form/new session/Wrap up/session editor/shortcut help, etc.). Then Esc is handled by the host Modal itself.
- The compact layout, native platforms (iOS/Android), and "New task" while a write operation is running likewise do not take effect.

Blocking is implemented by a reference count inside the plugin (`useShortcutBlock` in `client/shortcuts.ts`): inputs register on `onFocus/onBlur`, all plugin Modals register on `open` through the wrapper in `client/modal.tsx`, and they unregister when the component unmounts. The DOM `activeElement` or `event.target` is not read.

Known limitation: after a host Modal closes, focus may return to the page root, and you need to click the board once more to keep using shortcuts; this is the cost of not using a global listener.

### 2.3 Discoverability

- The desktop header gets a new "Keyboard shortcuts" icon button (the `Keyboard` icon); clicking it or pressing `?` opens the help popover, which lists all keys and descriptions, says "focus must be inside the board", and says that searching "Flowly" in the Command Center reaches the items of §2.4.
- The accessibility labels of the desktop header's Projects / Attention / Filter / New task / help buttons carry the shortcut (such as `New task (T)`, `Task filters (/)`). The RN-Web-specific `accessibilityKeyShortcuts` is not used, because React Native types do not declare it.

### 2.4 Command Center items (global)

| Item | Behavior |
| --- | --- |
| `Flowly: View board` | Open the board (id `open-board`) |
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
