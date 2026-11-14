# AI output language

Status: implemented and checked live (2026-10-21), for the card "AI output language setting for all AI features" (2026-10-21). Follow-up of "Paseo project settings interoperability".

## 1. Why

Each AI prompt used to leave the output language to the model, with a different guess each time: "the language most card titles use" (Workflow insights), "the language the cards are written in" (daily digest), "the language the person uses in the conversation" (card summaries, session insights), "in the user's language" (next moves from agents). On 2026-10-21 a Workflow insights Run now on Flowly wrote all 7 suggestions in German: the Chinese open suggestions that used to anchor the language were no longer in the material (each run now replaces them, WORKFLOW-INSIGHTS-SPEC), and German i18n excerpts in the inline samples pulled the model there ([evidence](verification/workflow-insights.md)). Guessing from the material is unstable by construction. One setting decides, the daemon states it in every prompt.

## 2. The setting

Host-scoped setting `ai-language` (`aiLanguageSettings` in `shared/settings.ts`, registered in `index.server.ts`), one field `aiLanguage`:

- `"interface"` (default): follow the interface language (setting `language`, [I18N-SPEC](I18N-SPEC.md) §2). A fixed interface language is used as is; `auto` means the device language, see §3.
- any language code of `locales` (`en`, `zh-CN`, `zh-TW`, `ja`, `ko`, `es`, `fr`, `de`, `pt-BR`, `ru`): that language, independent of the interface language.

An unreadable or invalid stored value behaves as `"interface"`. UI: Flowly settings → **AI features** → group **Output language**, a select "AI output language" whose first option reads "Same as interface language ({language})" where `{language}` is the language that currently resolves. The group says what it covers: card summaries, the daily digest, Workflow insights, session insights, and the next steps and ideas agents write. User content (titles, notes) is never translated.

`auto` of the interface setting is not offered as an AI choice: "same as interface" already covers it, and a device name that the daemon cannot see is not a language to put in a prompt.

## 3. Resolution (daemon)

`resolveAiLanguage` (`shared/ai-language.ts`, runtime-neutral, unit-tested) returns one `LocaleCode`:

1. `aiLanguage` is a language code → that code.
2. Else the interface setting is a language code → that code.
3. Else (interface `auto` = the device language of the client) → the **reported device language** (below).
4. Else the daemon host's own locale (`deviceLocale()` in the daemon process).
5. Else `en`.

**Reported device language (decision).** The daemon runs on the host and cannot see the phone or browser that has Flowly open. Each client reports its own `deviceLocale()` once per run: `LocaleRoot` (`client/i18n.tsx`) writes it into the host-scoped setting `device-language` (`{ locale }`, no settings page) when it differs from the stored value. The daemon reads that setting like any other. With several devices (laptop and phone) the **last device that opened Flowly wins**; a user who needs a stable language sets one explicitly in §2. The report is only written while the interface language is `auto`, so a user who pinned the interface language never writes it.

**Rejected: the majority language of card titles.** It is the heuristic that failed (§1): it changes with the material, a few English titles flip a Chinese board, and it cannot be explained to the user. The host locale (step 4) is only the fallback before any client has reported, which is a fresh install that has not opened the UI yet; the Node process may report `en-US` under a service manager, which is why clients report.

Changing the setting applies to the next run of each feature. Text already written (summaries, digests, suggestions, ideas) is kept in its language and is not regenerated.

## 4. What reaches the model

The daemon resolves the language when it builds a prompt and every prompt builder takes it as a required `language` argument (the type checker finds a builder that forgot). One shared helper, `outputLanguageRule(code)`, produces the line, so the wording is the same everywhere:

> Write every title and text in {Name}, whatever language the material below is in. Keep commands, code, file names, IDs and JSON keys as they are.

`{Name}` is the English name of the language: English, Simplified Chinese, Traditional Chinese, Japanese, Korean, Spanish, French, German, Brazilian Portuguese, Russian (`aiLanguageName`). The line replaces the old wording in:

| Output | Builder | Service |
| --- | --- | --- |
| Card progress summary | `summaryPrompt` (`shared/summary.ts`) | `SummaryService` |
| Daily digest | `digestPrompt` (`shared/digest.ts`) | `InsightsService` |
| Session insights: progress, next moves, ideas of sessions outside Flowly | `insightPrompt` (`shared/session-insights.ts`) | `SessionInsightService` |
| Workflow insights | `workflowPrompt` (`shared/workflow-insights.ts`) | `WorkflowInsightsService` |

Each service gets a `language: () => Promise<LocaleCode>` next to its settings reader; `index.server.ts` builds it once from the three settings. Counting rules that mention Chinese characters ("at most 15 words (or 30 Chinese characters)") stay: they are length limits, not a language choice.

The Workflow insights prompt keeps its other defences (a new suggestion must say how it differs from the nearest one); the explicit language line is what stops the material from deciding.

## 5. Agent sessions: next moves and ideas

Agents write next moves and ideas through the Flowly tools, so the language travels in the card context instead of a prompt:

- `flowly_get_task` returns `outputLanguage: { code, name }` (the resolved language of §3; `name` is the English name above), also in the CLI's `current` output.
- The skill says: write next-move labels and prompts and the title, detail and rationale of ideas in `outputLanguage.name`, even when the conversation or the card is in another language. The tool descriptions of `nextMoves` (label) and `flowly_propose_idea` point at `outputLanguage` instead of "the user's language". Chat replies, progress notes and the workpad still follow the person; this setting does not change what an agent says in conversation.
- An agent on an older skill ignores the field and keeps the old behaviour (additive, no tool version bump).

## 6. Out of scope

- Translating existing AI text, or re-running a feature after a language change.
- A per-project language. The setting is per host, like the interface language.
- Agent-facing text (skill, tool descriptions, prompts) stays English (I18N-SPEC §1); only the output language line changes.

## 7. Onboarding

A feature that changes what AI writes is worth one pointer. New one-time tip `ai-language`, shown the first time a card of the current project has an AI progress summary (fact `hasSummary`), after the Workflow insights tip in priority: "AI-written text follows Settings → AI features → AI output language. It starts as your interface language." The welcome tour and README feature list do not change (no change to the Projects/Cards/Sessions map or a headline capability); the README "Languages" paragraph gains one sentence.

## 8. Acceptance

- The setting exists (default "Same as interface language"), every language of `locales` can be picked, strings are in all nine catalogs.
- `resolveAiLanguage` unit tests: each of the five steps, invalid values, interface `auto` with and without a report.
- A unit test per prompt builder: the prompt contains the resolved language's line and none of the old wording ("language the cards", "language the person uses", "language most card titles").
- `flowly_get_task` returns `outputLanguage`; skill text (`server/skill-source.ts`, `skills/flowly/SKILL.md`, kept identical by `tool-server.test.ts`) and tool descriptions use it.
- Live: with AI output language set to Simplified Chinese (and again to English) on Flowly, Workflow insights **Run now** writes the suggestions in that language; evidence in [verification/ai-language.md](verification/ai-language.md).
- Tip `ai-language` covered in `client/onboarding-logic.test.ts`.
