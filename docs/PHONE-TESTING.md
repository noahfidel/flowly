# Testing and measuring Flowly on the phone

Procedure for device checks (the "UNRUN: device" items in the specs). Rules and the adb decision are in `AGENTS.md`; results go to `docs/verification/`. First run: [performance-phone-2026-10-21](verification/performance-phone-2026-10-21.md).

## Driving the phone

- Prefer the AndroMeld MCP tools (`phone_connect`, `phone_tap`, ...). When `phone_connect` times out ("Timed out while receiving Device Agent data") even though `phone_files` works, use `adb` (user decision, `AGENTS.md`). `adb devices -l` shows the device; the app is `sh.paseo`; the screen is 1080x2340.
- `adb exec-out screencap -p > shot.png` and look at it before and after taps. `adb shell uiautomator dump` can show a stale tree behind the open sidebar: trust the screenshot.
- `adb shell am start -W -n sh.paseo/.MainActivity` gives the app's first-frame time (Paseo shell only, not Flowly). `adb shell dumpsys gfxinfo sh.paseo reset` before a scenario and read it after.

## Getting to the board (pixel coordinates at 1080x2340)

1. Open the sidebar: tap the menu icon at about (79, 200). After a cold start wait 2-4 s: a tap that lands while the drawer is still opening is lost.
2. Tap "Flowly" at about (176, 599). The board opens on the first lane with cards (Blocked here).
3. Lane picker: tap the lane header (about (1000, 646)); "Done" is the last big row. "Show N older tasks" sits at the end of a lane's list.
4. A card: tap its title. **Back leaves Flowly**, it does not go up one level from the board: use it once from a card or session, never from the board.

Stray taps seen so far: the system "Update ready to install" prompt (press Back, never Install) and the host picker listing other people's hosts (press Back, choose nothing).

## Timing log

1. Write `~/.paseo/plugin-settings/flowly/performance.json` as `{"version":1,"values":{"log":true}}`, `paseo plugin reload flowly`, force-stop and start the app.
2. `paseo plugin logs flowly | grep "\[perf\]"`: lines tagged `android` are the phone, `web` are desktop clients. Names are listed in PERFORMANCE-SPEC ("Timing log"); `board.read.full.<why>` and the daemon's `board.read.full reason=` say why a read was a whole board.
3. Reports flush every 10 s; give a scenario at least that long. Delete the file and reload the plugin afterwards.

## Scenarios

Cold start; open Flowly; switch to a long lane and expand "older"; scroll it (swipes, both ways); open a card and Back (repeat); open a card's session; type in the composer (`adb shell input text`, never send; clear it afterwards). Record per scenario: gfxinfo percentiles and "Slow UI thread", the matching `[perf] android` names, battery and temperature (`dumpsys battery`).

## Pitfalls

- 120 Hz: gfxinfo's janky-frame percentage uses an 8.3 ms deadline and overstates; read p50/p90/p99 and slow-UI-thread counts.
- A mostly idle board still polls (`board.read.same`, chip rounds); a quiet window is not zero activity.
- Another session writing to the board (including this card's own agent) causes board changes while you measure; note it.
- The host's own data must not be written to prove a point (for example adding events to a card): use an offline round trip on a copy instead.
- Single short runs are indicative only; repeat and separate LAN from relay before claiming a number.

## Board groups switcher and tabs (task 7, 2026-11-10)

- Not run. No `adb` binary is installed on this machine and the AndroMeld phone tools were not available in the card session, so the switcher and group-tab pass on the Samsung SM-S911B is unrun.
- To run it: check `adb devices`, open the switcher from the board, and look at the group rows, Add group, and the group tabs with a screenshot before each tap. Expect the board to open on the last group viewed, with no All projects row. Keep the host picker and any system prompt out of it.
