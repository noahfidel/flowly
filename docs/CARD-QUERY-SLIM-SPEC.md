# Minimal slimming of the card query internal compatibility layer

2026-10-24; scope: internal cleanup after phase 2 of NATIVE-OVERVIEW-SPEC is complete.

## 1. Purpose and basis

The standalone `CardDetailProvider` has taken over the native detail view. The current production source has no
`CardBoardContext.Provider`, and its default value is always `undefined`; so
the `withCardBoard` branch of `useBoardQuery` only ever returns the original query.
Delete this old path that has no production entry, to cut the maintenance load of the context, the Proxy and the by-revision data selection.
This is a complexity cleanup and promises no improvement in load time or FPS.

## 2. Exact changes

| File | Change |
|---|---|
| `client/queries.ts` | Delete `CardBoardContext`, `preferFullBoard`, `withCardBoard` and the React imports used only by them; `useBoardQuery` returns the existing `useQuery` result directly |
| `client/queries.test.ts` | Delete the two tests that only verify the scoped fallback (tracked-result and Proxy behavior); keep the silent poll observer, etag, patch and live-agent tests |
| `client/session-link-query.test.ts` | Delete the old test that merges a scoped Board with the full Board by revision; keep the four current full-board navigation / fresh-check tests |

Do not change the key, fetcher, options, etag, retry or notification policy of `useBoardQuery`.
Return the tracked result directly, do not spread it, and add no replacement wrapper, framework or cache.

## 3. Behavior and contracts that must stay

- Overview, CardDetail and the full Board keep using separate types, query keys and etags;
  do not treat any projection as the full Board, and add no native full-board observer.
- The native detail view keeps using `CardDetailProvider`; web / old full-board readers keep using the original `useBoardQuery`.
- The query's data, pending, error, refetch and per-property tracking behavior come from the original TanStack result;
  a failed read does not pass off old scoped data as success, and deletion or a workspace/session change still refuses access.
- Fresh task/workspace/session ownership, send authorization, failure rejection and old-route isolation are unchanged;
  the cache is still used only for display and cannot authorize an action.
- Keep the registration, schema and server implementation of the old `sessions.card-board` RPC; do not delete a protocol that old clients can call.
- Keep the existing event body, description search, live Attention, input/scroll state, continuous height animation and the 450ms modal handoff.
  Animation, routing, UI, write path, server and dependency files are out of the change scope.
- No visible feature change, and no new onboarding, tip or What's new copy.

## 4. Verification and acceptance

First save the product file hashes of the current dirty working tree, then change the three files above.
The other product files must stay byte-identical; historical verification docs are not rewritten because of old symbol names.

Required checks:

```sh
npm run typecheck
npx vitest run --exclude 'docs/verification/**' client/queries.test.ts client/session-link-query.test.ts client/card-detail-query.test.ts client/overview-query.test.ts server/card-board.test.ts client/session.test.ts
git diff --check -- client/queries.ts client/queries.test.ts client/session-link-query.test.ts docs/CARD-QUERY-SLIM-SPEC.md docs/PROGRESS.md
```

An independent Paseo `codex/gpt-6-luna` test session, created in `full-access`, runs one focused regression and checks the source boundary;
reuse the parent's typecheck on the same source, do not repeat the full suite, and install no temporary renderer or dependency.
Keep the existing regressions for CardDetail scope / fresh read / failure rejection, Overview key/etag, full-board fresh navigation,
send ownership and old card-board projection compatibility.

Acceptance conditions: the three old symbols have no references in production code and current tests; only the three old-layer-specific tests are deleted;
the current regressions above and typecheck pass; the protected product file hashes are unchanged; this round's test session is cleaned up.
Evidence is saved to `docs/verification/card-query-slim-2026-10-24/`.
This round does not build/install/reload the plugin and does not operate the phone; real UI, FPS and end-to-end speedup are not conclusions of this round.
