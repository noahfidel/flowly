# Default models (global and per project)

Status: implemented on the user's request (2026-10-16): a Models page in the settings with a default model, and a default model per project that overrides it.

## 1. What it is

The model a **new session** starts with: provider, model and optional reasoning effort. It prefills the "New session" form and the agent picker of "New task → Start an agent now". The user can still change it in those forms; nothing is forced on an existing session.

The default also carries an optional **permission mode** (2026-10-23). With no mode set, the form uses the provider's suggestion (`suggestedMode`: Claude `auto`, Codex `auto-review`, else the provider default). Not covered: the summary model (separate, see §4).

No setting of a new session ever comes from an earlier session (2026-11-10, Noah): provider, model, reasoning, permission mode and speed come only from the defaults below and the picker's suggestions. Before this, a project with no default followed its latest session, which could be one of Flowly's own Haiku summarizer sessions.

## 2. Precedence

`effectiveAgentModel(project, group, global)` in `shared/agent-defaults.ts`, strongest first:

1. the project's `agentModel`, when set;
2. its board group's `defaults.agentModel`, when set ([BOARD-GROUPS-SPEC](BOARD-GROUPS-SPEC.md));
3. the global default (`models` host setting), when set (`defaultProvider` and `defaultModel` both non-empty);
4. Paseo's own default provider/model: not used, the plugin API does not expose one (checked 2026-11-10);
5. nothing: the New task, New session and Quick task pickers start with Provider and Model empty and a hint under them, "No default model. Set one in Settings → Models."; the form cannot be submitted until the user picks a provider (its default model is then chosen as usual). `flowly_start_card` refuses with `MODEL_UNAVAILABLE` and a message asking the user to set one in Settings → Models (START-CARD-SPEC §5).

`startingAgent(chosen)` turns the result into the form's starting point: the default's provider, model, reasoning (`thinking`, else "" = the model's own default) and mode (else "" = the picker's suggestion); no speed. With no default it is null.

A higher default replaces a lower one as a whole (provider, model, reasoning and mode together); it is never merged field by field. If the chosen provider is not available on this machine the form falls back as it always did (an available provider, its default model).

Acceptance (2026-11-10):

- No default anywhere: the New task / New session / Quick task picker shows Provider and Model empty with the hint; nothing is preselected from any earlier session, including a newer summarizer session.
- No default anywhere: `flowly_start_card` refuses with `MODEL_UNAVAILABLE` before creating anything, even when the project's cards have live sessions.
- A default without reasoning: the session starts with no `thinkingOptionId` (the model's own default), never Extra High by suggestion.
- A default without mode: Claude starts in `auto`, Codex in `auto-review`; Quick task still starts in `plan` when offered.

## 3. Data

- Global: host-scoped setting `models` = `{ defaultProvider, defaultModel, defaultThinking, defaultMode }`, empty strings meaning none. Registered in `index.server.ts`.
- Project: optional `agentModel: { provider, model, thinking?, mode? }` on the project record. No board migration (absent on existing projects). `projects.update` takes `agentModel`; a model sets it, `null` removes it; it goes through the usual project revision check, so a stale edit is rejected. The model is validated by `agentModelSchema` (strict, non-empty ids).

## 4. UI

- **Settings → Models**: *Default model* (Provider, Model, Reasoning) and *Summary models* (an ordered fallback list; see [SUMMARY-MODELS-SPEC](SUMMARY-MODELS-SPEC.md)). Provider's first choice is **Automatic** (no default: "Choose a model when you start a session"). Choosing a provider also chooses its default model, so a default is always complete.
- **Project settings → Default model**: the same three rows; the provider's first choice reads **Global default (…)** (the current global one, or Automatic) and means "no override".
- A **Permissions** row (the provider's modes; **Automatic** keeps none: the form then uses the provider's suggestion, see "Automatic approval default") follows Reasoning; changing the provider clears it, since mode ids belong to a provider.
- The Reasoning row only appears when the model offers options; "Model default" stores no reasoning, so the session uses the model's own default.
- A default model has no speed. The session form starts at the picker's speed suggestion ([AGENT-SPEED-SPEC](AGENT-SPEED-SPEC.md)).

## 5. Acceptance

[verification/model-defaults.md](verification/model-defaults.md)

## Automatic approval default (2026-10-29)

New card/session pickers suggest Claude `auto` and Codex `auto-review` when no explicit permission mode is set (neither picked nor in the chosen default). Applies on initial selection, reset and provider switch. Explicit picks and model defaults win. Unsupported modes fall back to the provider default. Existing sessions are unchanged.

Custom providers that extend Claude or Codex (`claude-connected`, `codex-connected`, …) get the same suggestions (2026-10-30). Paseo does not tell clients what a custom provider extends, so `providerBase` in `shared/agent-defaults.ts` recognises it by its permission modes: `auto-review` means Codex, `acceptEdits` plus `bypassPermissions` means Claude; any other provider gets no suggestion. The suggestion is worked out in the picker (`client/agent-choice.tsx`) for a mode not chosen yet, once the provider's modes are listed; the form cannot be submitted before that. `startingAgent` passes only the default's values on.

## Reasoning default (2026-11-10)

New card/session pickers start with the chosen default's reasoning, else the model's own default (""). There is no automatic suggestion: the earlier Extra High (`xhigh`) suggestion (2026-10-30) was removed on Noah's request, along with `suggestedThinking`. `chosenThinking` in `shared/agent-defaults.ts` keeps a picked or default reasoning only while the model offers it, else falls back to the model's own.
