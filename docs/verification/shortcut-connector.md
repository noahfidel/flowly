# Verification: Shortcut connector (CONNECTORS-SPEC §14)

Date: 2026-10-29

## Commands

| Command | Result |
|---|---|
| `npm run typecheck` | clean, no errors |
| `npm run test:ci` | 4 passed |
| `npx vitest run server/connectors/ shared/` | 456 passed |
| live run, env vars supplied | 6 passed |
| `npm test` (full suite) | **not clean**: 5 failed of 1215 |

The five full-suite failures are `ideas`, `memory`, `sqlite-store`, `tags` and
`tool-server`. They are load-dependent timeouts under parallel vitest, not a result of
this change: the same tests fail on `origin/main`, and all five files pass when run on
their own (82 passed). Recorded here as a known-unclean command rather than a pass.

## Live workspace

Run against a real Shortcut workspace with `SHORTCUT_API_TOKEN`, `SHORTCUT_WORKSPACE`,
`SHORTCUT_STORY` and `SHORTCUT_EPIC` supplied from the environment. Output is not
reproduced here: it contains the workspace's own story and epic titles.

Confirmed:

- the token verifies and the account renders as `name (@mention_name)`
- the picker returns the signed-in user's open stories, each keyed `sc-<id>`
- a story reads with status, type, owners, labels, epic and branches, resolved through
  the `/workflows` and `/members` lookups
- an epic reads and lists its stories with their states
- a pasted story link resolves to the same item as its `sc-<id>` key

## Not done

Settings → Connections and the **From Shortcut** picker were not exercised by an
automated UI check.
