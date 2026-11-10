# Verification: board groups (commit 0c2a303)

- Commit: 0c2a303 (`fix(onboarding): the board-groups tip shows on an unfiltered group board`), parent 05ab9c5, branch `kanban/board-groups-7-7-onboarding-what-s-new-i-a10036`
- Date: 2026-11-10
- Scope: this run covers 0c2a303 after the review fixes. The earlier run on 05ab9c5 passed; it is not repeated here.
- Verifier: independent session (did not write the code). Run in a temporary detached worktree of 0c2a303, removed afterwards.

## 1. Commands

| Command | Exit | Result |
|---|---|---|
| `npm ci` | 0 | install OK (fsevents install-script notice only) |
| `npm run typecheck` | 0 | `tsc --noEmit` clean |
| `npm test` | 0 | Test files: 198 passed, 1 skipped (199). Tests: 2133 passed, 7 skipped (2140). 0 failed |
| `npx vitest run client/onboarding-logic.test.ts shared/i18n.test.ts client/catalog.test.ts` | 0 | Test files: 3 passed (3). Tests: 101 passed (101). 0 failed |

## 2. Static checks

- No stale user-visible "All projects" or project-tab wording in `client/*.tsx`, `client/onboarding*.ts`, `client/whats-new.ts`. Remaining hits are code comments (`board.tsx`, `card.tsx`, `sortable-list.tsx`), the allowed `client/search-page.tsx` scope option (`t("All projects")`), the test that asserts the retired tips stay gone, and the 1.9.0 item "Group tabs replace the project tabs" (intentional). PASS
- `tipIds` contains `board-groups`; it contains neither `all-projects` nor `project-menu`. PASS
- `README.md` and `README.zh-CN.md` each have a `### 7.` board-groups highlight (lines 104 and 100). PASS
- `package.json`, `package-lock.json` (root) and `shared/version.ts` all say 1.9.0. PASS

## 3. Catalogs (`shared/i18n/`, nine locales: de, es, fr, ja, ko, pt-BR, ru, zh-CN, zh-TW)

- New strings present in all nine (count 1 each): "Each group has its own dispatcher, so its chat…", "Group tabs replace the project tabs…", "Projects are grouped into boards…", "Projects sit in boards. Each group has its own tab…". PASS
- Retired strings absent from all nine: "All projects shows every project's cards…", "Drag a project tab to reorder it…". PASS
- Note: "Board groups hold projects and give them defaults…" is present in all nine and is still used by the 1.9.0 What's new entry (`client/whats-new.ts`, line 56). It is live copy, not retired, so it is not counted as one of the two.

## 4. UI checks

- Code reading, `client/board.tsx` tip gate (~line 1658): `groupBoard = !project && !!group && !task && !compact`. When `!project` and `groupBoard`, the tip calls `nextTip` with `{ ...noTipFacts, groupTabs: allLiveProjects.length > 1 }` and the `tipBlocked` guard. Otherwise it returns null. Matches the brief. PASS (code reading only)
- Live Paseo UI, tip shown on an unfiltered group board: UNRUN. This session cannot bind the non-fullscreen Paseo window unambiguously, so it did not drive the UI or the live app.
- Live What's new / tour / compact layout checks: UNRUN, same reason.

## 5. Verdict

PASS for everything runnable in this session: typecheck, full suite, targeted suites, static wording and version checks, catalog counts, and the tip-gate reading. Live UI checks are UNRUN (window binding), not failed.
