# Flowly built-in tool and skill names

Status: requested 2026-10-19. This supersedes the naming in Phase 2 and the 2026-10-16 rename note. Input: card "Rename built-in tools and skills" and the user's instruction to remove the old product name from built-in tools and skills.

## Observable contract

- The MCP configuration key and server identity are `flowly`. All eleven tools use the `flowly_` prefix, retaining each suffix, schema, authorization, error, receipt and business behavior. The tool list advertises only the new names.
- The bundled skill is `skills/flowly/SKILL.md`, with frontmatter `name: flowly` and heading `Flowly`. The daemon's runtime `SKILL.md` is byte-identical. Its instructions and generated session instructions refer only to the new tool names.
- Newly supplied CLI commands use `flowly.mjs`. Managed session hooks supply `FLOWLY_CONTEXT_FILE`, `FLOWLY_CLI`, and `FLOWLY_SKILL`. Configuration overrides are `FLOWLY_DATA_DIR` and `FLOWLY_LINKED_DIR`.
- Newly created helper labels, internal query prefixes and connection names use Flowly. Existing summarizer labels remain recognized so old helper sessions remain hidden and resource guards remain correct.
- README tool lists and current specification references use the new names. Historical verification evidence and the actual checkout path are not rewritten.

## Compatibility and boundaries

The plugin ID remains `flowly`. Preserve the non-destructive legacy data/settings migration, existing board bytes and scope/workspace/session ownership, credentials, endpoint, and receipts. Do not rename the user's checkout or native project. Keep private legacy environment fallbacks and an old CLI compatibility entry for existing session instructions; never advertise them in new instructions. Existing running sessions may retain cached MCP configuration/tool names until a new session; their CLI context remains valid. Reopening a managed session supplies the new environment. Do not add legacy tool aliases to discovery.

Existing provisioning idempotency keys remain stable across this rename: changing them could duplicate a resource after a retry. No workflow, UI layout, user-facing capability or onboarding moment changes, so no new tour row or one-time tip is warranted; README naming is updated.

## Acceptance

1. MCP initialization identifies `flowly`; discovery exposes exactly the eleven `flowly_*` tools, and a real scoped read/write succeeds.
2. Packaged/runtime skill and generated instructions contain only Flowly entry names; new session MCP configuration and environment use Flowly.
3. `flowly.mjs` completes a scoped flow, preserves authorization/replay/errors, supports the new context environment, and retains legacy context fallback for existing sessions.
4. Reload preserves endpoint/credentials/receipts/data; legacy data migration and summarizer recognition still work.
5. Typecheck and the full suite pass; a `codex/gpt-6-luna` Paseo session launched with `settings.modeId: "full-access"` independently verifies the change and records evidence. Clean up only test-owned resources.

## Checks

- `npx vitest run server/tool-server.test.ts server/service.test.ts server/naming.test.ts shared/summary.test.ts server/summaries.test.ts server/insights.test.ts server/tickets.test.ts client/queries.test.ts`
- `npm run typecheck`
- `npm test`
- `paseo plugin reload flowly` after typecheck; verify installed service MCP initialize/list/call with private session context (never log credentials).
- Full-access Luna source/runtime review, evidence in `docs/verification/flowly-naming.md`. Desktop/compact visual checks are unnecessary for this naming-only change; any UI targeting attempt must still bind the non-fullscreen window unambiguously.
