# Card write scope and subdirectory tasks — research and design (draft)

Status: research/design only, 2026-10-15 (card “Optimize the project system”). **Deferred by the user (2026-10-15): no write restrictions for now; revisit after real use.** Not implemented.

Coverage gap: only Codex and Claude were researched. Other enabled providers (Hermes, Aside, Codex/Claude-compatible custom providers that reuse those adapters, and ACP-based providers such as Copilot/OpenCode/Pi when enabled) have unknown sandbox options and permission semantics; any future enforcement must inspect each provider or fall back to the provider-independent layers (read-only linked root, instructions, turn audit).

## Problems

1. **Linked multi-repo projects** (PROJECT-PICKER-SPEC): the root is a plugin-owned directory of symlinks. An agent started there may write into the root itself (notes, `git init`, `npm install`, scratch files) or into a linked repo the card is not about.
2. **Scoping a card** to part of a project: one linked repo, a few of them, or a subdirectory (e.g. `packages/api` in a monorepo single-root project).

## Findings (evidence: Paseo 0.11.2 SDK typings and the installed daemon's provider code)

| # | Finding | Consequence |
| --- | --- | --- |
| F1 | Plugin server can register `before("agent.create")` and rewrite `AgentSessionConfig`: `cwd`, `modeId`, `systemPrompt`, `providerOptions`, `mcpServers` (`@getpaseo/plugin/server/lifecycle`). It fires for every agent creation. | The plugin can inject provider-native sandbox settings for sessions in a card's workspace; it must leave all other sessions untouched. Applies at creation only. |
| F2 | Codex `providerOptions`: `sandbox_mode` (`read-only`/`workspace-write`/`danger-full-access`), `approval_policy`, `sandbox_workspace_write.{writable_roots, network_access, …}`. `providerOptions.sandbox_mode` overrides the mode preset on each turn (`applyTurnWorkflowPolicy`). | In workspace-write, writes are allowed only in `cwd` + `writable_roots` (+tmp). Codex *Full Access* = `danger-full-access`: no file fence. A plugin could offer "full access, fenced": `workspace-write` + `approval_policy: never` + network on. |
| F3 | Claude `providerOptions`: `additionalDirectories`, `allowedTools`/`disallowedTools`, `settings.permissions.{allow,ask,deny}`, `sandbox.filesystem.{allowWrite,denyWrite,…}`. | Edit/Write tools can be fenced with deny rules (Claude Code keeps deny rules in bypass mode — to verify through Paseo); Bash writes only when its sandbox is enabled. |
| F4 | Plugin observes `agent.permission_requested` and an agent handle has `respondToPermission`. | In asking modes (Codex Default/Auto-review, Claude Always Ask/Accept Edits/Auto) the plugin can deny out-of-scope writes automatically. |
| F5 | `agent.turn_started` / `agent.turn_ended` hooks (already used by auto status). | Natural audit point to detect out-of-scope changes after the fact. |
| F6 | Paseo can create a directory workspace at any path for a given project ID, and a worktree from an explicit source repo for a given project ID (used by the Phase 1 multi-repo design). | A card in a linked project can get its workspace **at one linked repo**, or an **isolated worktree of that repo** — worktree isolation becomes possible for linked projects. |
| F7 | The old per-card scope machinery still exists (`task.repoPaths`, `sourcePath`, `scope.directories` in `flowly_get_task`, worktree checkout mapping) and is used read-only for legacy cards. | Tool/skill plumbing for "this card's directories" can be reused. |
| F8 | Sandboxes evaluate real paths (to verify per provider). `root/api → /real/api` is outside `cwd=root`. | Today a linked-project card works fully only in full-access modes; in Codex Default the symlinked repos are not writable unless added to `writable_roots`. |
| F9 | Paseo writes nothing into a directory workspace root by itself as far as observed (worktrees live under `~/.paseo/worktrees`). To verify. | A read-only linked root should not break Paseo. |

## Design

### 1. Scope model

- Project **scope units**: for a linked project, its links (`name → target`); for a single-root project, the root and any subdirectory of it.
- New optional card field `scopePaths: string[]` (canonical absolute paths). Empty = whole project (today's behavior). Each path must be inside the root or inside a link target. Legacy `repoPaths` stays untouched for old cards.
- UI, New/Edit task: **Scope** row — *Whole project* (default) / *Choose…*: linked projects show the links as a checklist; any project can *Browse* a subdirectory with the existing folder browser restricted to the project. Scope edits bump the task revision (Kanban tools already reject stale writes); running sessions keep their creation-time sandbox and get a notice to restart.

### 2. Workspace and session start directory

| Scope | Workspace | Session `cwd` |
| --- | --- | --- |
| Whole project | directory workspace at root (today) | root |
| One linked repo | directory workspace at the repo **or** worktree of that repo (new: isolation for linked projects) | that repo/worktree |
| One subdirectory of a Git root | directory or worktree of the root | the subdirectory (inside the worktree when isolated) |
| Several paths | directory workspace at root | root (read-only), writes fenced to the paths |

Narrowest `cwd` matters because Codex always lets the session write its `cwd`.

### 3. Enforcement, in layers

1. **Read-only linked root (mode-independent).** After creating links, `chmod 0555` the linked root; `set-links` restores `u+w` only while it edits links. Nothing can add, delete or rename entries in the common directory, including full-access agents (short of a deliberate `chmod`). Writes inside link targets are unaffected. Answers "never write into the common directory" for every provider and mode.
2. **Provider fence at session creation** (`before("agent.create")`, only for sessions whose `cwd` lies in a card's workspace):
   - Codex Default/Auto-review: `sandbox_workspace_write.writable_roots` = scope real paths (and worktree checkout) other than `cwd`.
   - Codex Full Access: optional **fenced full access** — `sandbox_mode: workspace-write`, `approval_policy: never`, `network_access: true`, same writable roots. No prompts, writes limited to scope.
   - Claude (all modes): `additionalDirectories` = scope real paths; `settings.permissions.deny` = `Edit/Write/MultiEdit/NotebookEdit` on the linked root and on out-of-scope link targets; if the Claude sandbox is enabled, `sandbox.filesystem.denyWrite` for the same paths (covers Bash).
3. **Permission responder.** On `agent.permission_requested` from a card session, resolve the target path (tool input path, or command cwd) — if it is outside scope, `respondToPermission(deny, "Outside this card's scope: …")`. In-scope requests stay with the user; nothing is auto-approved.
4. **Instructions.** Task context and skill list the scope directories explicitly, state that the root is a read-only index and that other links are off-limits.
5. **Turn audit.** At `turn_started`, record a digest of `git status --porcelain -z` + `HEAD` for each out-of-scope linked repo and the root listing; at `turn_ended`, compare. A change adds card activity "Out-of-scope change in <repo>" and an Attention item. Never reverts. Attributed only when no other card session of the same project ran during that turn; otherwise marked unattributed. Bounded: linked projects only, per-repo timeout.

### 4. Limits

- Codex Full Access (unfenced) and Claude Bypass with Bash: only layers 1, 4, 5 apply to Bash writes into out-of-scope targets — detection, not prevention.
- Sessions created before the feature, or resumed with a stored config, keep their old sandbox.
- MCP/browser tools are not covered by file sandboxes.
- Symlink/real-path behavior of each sandbox, Claude deny rules under bypass, and Paseo with a read-only root are assumptions until verified.

### 5. Phasing and verification

- **P1:** read-only linked root; `scopePaths` model + UI; workspace/cwd per scope (including worktree of a linked repo); instructions; Codex/Claude fence for non-full modes; permission responder.
- **P2:** fenced full access option; turn audit.
- Verification: fixture linked project with repos A/B/C, card scoped to A; for Codex Default, Codex Full (fenced and unfenced), Claude Accept Edits and Bypass, try writing to root, B and A; record allow/deny/detected per layer. Luna full-access test session per AGENTS for the end-to-end run.

## Open decisions

1. Codex **Full Access** on scoped cards: keep true full access (detect only) or use fenced full access by default (recommended for linked projects)?
2. Out-of-scope writes in asking modes: **auto-deny** (recommended) or ask the user as usual and only warn?
3. Subdirectory scope: move the session's `cwd` into the subdirectory (recommended; enforceable for Codex) or keep `cwd` at the root with only Claude-side fences?
4. Linked-repo cards: offer **worktree of the chosen repo** as the isolated option (recommended), keeping directory mode as default?
