# Telemetry error analysis — 2026-11-10

Card "近期error排查". Source: PostHog project 688543 (US), HogQL in the SQL editor, read-only, run from the maintainer's signed-in browser (Aside) on 2026-11-10 ~02:35 UTC. Window: last 30 days (2026-10-26 → 2026-11-10). Counts are install-days (per-day dedupe, TELEMETRY-SPEC §11.4). Messages are never reported, so causes are inferred from type, code, frames and Paseo's sources.

## Groups

| Events (installs) | Source | Type / value | Versions | Cause | Status |
|---:|---|---|---|---|---|
| 41 (14) | `Flowly read-state sync failed` ← `syncNative` → `openLocalDaemon` | Error / "" | 1.6.0, 1.7.0 | TCP-only address parsing | Fixed in 1.7.1 (#69, [report](telemetry-errors-2026-10-27.md)) |
| 23 (18) | same frames | SyntaxError / "" | 1.7.2, 1.8.0 | `JSON.parse` of `paseo.pid` while Paseo rewrites it. Paseo (`packages/server/src/server/pid-lock.ts`, v0.15.3) writes the file in place: `open("wx")` then `write`, and `updatePidLock` (sets `listen`/`serverId` once the server listens) does `truncate(0)` then `writeFile`. Paseo's own `readPidLock` retries 10 × 50 ms on empty/invalid content; Flowly read once. The startup sync runs at plugin load, i.e. during daemon start, exactly when the file is rewritten. | **Fixed here** |
| 15 (7) | read-state sync ×15 via `Timeout.eval`/`WebSocket.eval` → `DaemonClient.scheduleReconnect` | Error / "" | 1.7.2 | `DaemonClient` with `reconnect: { enabled: false }` rejects `connect()` with a plain `Error` (`Connection timed out` after 5 s, refused, closed), not `DaemonConnectionError`: the daemon is still starting or busy. The 30 s retry covers it. | **Fixed here** (not reported) |
| 7 (2) | `Flowly could not delete a summarizer session; archiving it` (same reconnect frames) | Error / "" | 1.7.2 | same | **Fixed here** (not reported) |
| 1 (1) | `Flowly could not clear Paseo read state` (same reconnect frames) | Error / "" | 1.7.2 | same | **Fixed here** (not reported) |
| 11 (2) | `rpc sessions.image` | Error / ENOENT | 1.7.0 | missing temp image | Fixed in 1.7.1 |
| 8 (1) | `rpc sessions.configure` | Error / EINVAL | 1.7.0 | Windows `.cmd` | Fixed in 1.7.1 |
| 5 (2) | `Flowly session insight failed` | Error / "" | 1.7.0 | provider failure | Not reported since 1.7.1 |
| 5 (4) | `Flowly session insight rows not added` | DaemonRpcError / "" | 1.7.2 | A Paseo RPC (agent refresh or timeline append) answered with an error; no frames and no code pass the filter (`safeCode` needs upper case), so which call and why is unknown | **Reported from here on** as `value` = `requestType:code` (TELEMETRY-SPEC §11.3) |
| 1 (1) | `Flowly next steps card not added` | DaemonRpcError / "" | 1.7.2 | same unknown | same |
| 4 (2) | `rpc projects.create-linked` (win32) | Error / EPERM | 1.7.0, 1.7.2 | `symlink(…, "dir")` needs the symlink privilege on Windows (Developer Mode or admin); linked roots cannot be created there | Open: proposed junctions on Windows (needs Windows verification) |
| 6 (1) | `Flowly memory clue not recorded` (`MemoryStore.load`, win32) | Error / "" | 1.7.2 | one install; message unknown | Not changed |
| 3 (1) | `Flowly turn timeline not read` | Error / "" | 1.7.2 | one install; message unknown | Not changed |
| 3 (3) | `Workflow insights backfill skipped a session` | Error / "" | 1.7.0, 1.7.2 | best effort by design | Not changed |
| 9 | `Kanban project folder not saved`, `rpc composer.draft`, `rpc sessions.mark-read`, `memory clue` | EROFS / EPERM / ENOSPC | 1.7.2 | disk full (one install, 2026-11-10), read-only or protected folder | Environment; not changed |
| 5 | `fs.list-directories` | ENOENT (1.6.0) / EPERM (macOS protected folder) | | typed path / privacy prompt | Not changed |
| 9 (1) | `DAEMON_CONNECTION_LOST` on several RPCs | DaemonConnectionError | 1.7.0 | daemon restart | Not reported since 1.7.1 |
| 6 (1) | `STORAGE_BUSY` (storage, migration, CLI, tools, backfill; same second) | StorageError / Error | 1.7.2 | a second daemon held the store | Expected; not changed |

The fixed rows (23 + 15 + 7 + 1 = 46 install-days) are 100 % of the reports still arriving from 1.8.0 and most of 1.7.2's.

## Fix

`server/local-daemon.ts`: `readListen` reads `paseo.pid` up to 10 times 50 ms apart while it is empty or not JSON, like Paseo's `readPidLock`; no file or still unreadable → `LocalDaemonUnavailable`. A failed `connect()` → `LocalDaemonUnavailable` with the reason in its message (logged) and the original as `cause`. A missing method on the connected Paseo still throws the plain `unsupported` error, which stays reported. Specs: TELEMETRY-SPEC §11.2, WORKSPACE-RESTORE-SPEC step 1.

Trade-off: a future systematic connection bug (like the TCP-only one fixed in 1.7.1) would no longer show as an exception; it would still show as `paseo_version = ""` on error reports, which uses the same connection.

## Checks

- `npx vitest run server/local-daemon.test.ts`: 6 passed (3 new: in-place rewrite retried; missing/empty/half-written/`null` file unavailable; refused connection unavailable and `outsideError`).
- `npm run typecheck`, `npm test`: see the card's delivery note.

## Not verified

- No live reproduction of the startup race on a real daemon; the cause is from Paseo's source and the frames. After release, the `SyntaxError` group and the reconnect-frame groups should stop arriving from the new version.
