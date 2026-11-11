# Agent speed

Status: implemented on the user's request (2026-10-29, card "speed settings for agents").

## 1. What it is

The agent picker of **New session** and **New task → Start an agent now** (`client/agent-choice.tsx`) gets a **Speed** row next to Provider, Model, Reasoning and Permissions. It chooses how fast the provider runs the model, when the chosen model offers a choice. Faster speeds cost more usage; the provider's own note says so on each faster option.

Paseo has no speed field on models. It offers speed as a **provider feature**, listed per draft config by `paseo.providers.listFeatures({ provider: "<provider>/<model>", cwd })` and applied at creation through `featureValues`:

| Provider | Feature | Kind | Options |
|---|---|---|---|
| Codex | `service_tier` ("Speed") | select | the default tier ("Normal", `isDefault`) and the model's faster tiers (e.g. `fast`) |
| Claude | `fast_mode` ("Fast") | toggle | off / on; offered for models whose manifest supports fast mode (Opus) |

Other features (Codex Plan, ACP auto-accept and ACP config options) are not speeds and stay out of the picker. A provider that lists neither feature for the model gets no Speed row.

## 2. Behavior

- `shared/agent-speed.ts` `speedFeature(features)` turns the listed features into the row: the faster options (a select's non-default options; for the toggle, one option `fast` labeled with the feature's label), each with the option's description or else the feature's description, plus the provider's name for normal speed (`normalLabel`, the select's default option).
- The row only appears when `speedFeature` returns a choice. Its first option is the normal speed: the provider's own name for it, else **Standard**. Normal speed is the value `""` and sends nothing.
- `speedFeatureValues(choice, speed)` gives the session's `featureValues`: `{ service_tier: "<tier id>" }` for a select, `{ fast_mode: true }` for the toggle, nothing for normal speed or a speed the model does not offer. Both create paths pass it (`client/session-create.tsx`, `launchKanbanSession` in `client/session.ts` from `client/forms.tsx`).
- Features are listed per provider, model and project root, cached for 5 minutes, and only while the picker is in use. A failed listing hides the row; the session then starts at normal speed.
- Codex suggestions default to Fast when no speed is remembered; an explicit remembered Normal or other tier is preserved. Switching to Codex defaults to Fast. Unsupported tiers still fall back to normal. A custom provider that extends Codex gets the same suggestion (`providerBase`, MODEL-DEFAULTS-SPEC "Automatic approval default"). Fast is the tier the model offers as `priority` (the daemon's id, labelled Fast), else `fast` (`suggestedSpeed`).
- Changing the provider clears the speed for other providers. A model that does not offer the chosen speed falls back to normal speed, like reasoning.
- Starting point: the picker's suggestion (`suggestedSpeed`); a new session never takes its speed from an earlier session (MODEL-DEFAULTS-SPEC §1, 2026-11-10). While a wanted speed is still being checked against the model's features, the form cannot be submitted yet, so it is never dropped silently by a fast click.
- The speed of a running session is not changed from Flowly: the plugin SDK and the `paseo` CLI have no call to set a feature on a running agent. Use Paseo's own session controls.
- The card's session composer shows it (`client/session-settings.tsx`): a **Speed** chip after Reasoning, only when the session's snapshot features carry a speed choice. It names the speed the session runs at (`sessionSpeed`: the option's label, else the provider's normal label or **Standard**); its menu lists normal and the faster speeds with the current one selected, read-only with **Change in Paseo**. The Model chip no longer repeats the speed feature.
- Default models (Settings → Models, project default) do not store a speed.

## 3. Acceptance

1. Codex model with a faster tier: the Speed row shows Normal (default) and the faster tiers with the provider's cost note; choosing Fast creates the session with `featureValues: { service_tier: "fast" }`.
2. Claude Opus: the row shows Standard and Fast; Fast creates the session with `featureValues: { fast_mode: true }`. A Claude model without fast mode shows no row.
3. Normal speed sends no `featureValues`.
4. Changing the provider resets the row to normal speed; the next form after a fast session starts at that speed for the same provider.
5. `shared/agent-speed.test.ts`, `shared/agent-defaults.test.ts` and `client/attention.test.ts` cover the mapping, the creation values and the starting point.
