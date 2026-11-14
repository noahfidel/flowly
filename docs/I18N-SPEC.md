# Interface languages (i18n)

Status: implemented on the user's request ("Add localization for common languages" (translated), 2026-10-16). Task `682321fc`.

## 1. Scope

Ultra Kanban's own UI text is translated: buttons, labels, menus, toasts, dialogs, empty states, accessibility labels, Command Center titles, the session chip, insight suggestions, lane/type/priority names and relative times.

Not translated, on purpose:

- agent-facing text: the skill, MCP tool descriptions, prompts, work instructions and anything the daemon sends to a model;
- daemon error messages and RPC validation text (technical, English);
- text written by models (task progress summaries, daily digest, Workflow and session insights, agents' next moves and ideas): they follow the separate **AI output language** setting, stated explicitly in every prompt ([AI-LANGUAGE-SPEC](AI-LANGUAGE-SPEC.md)); it defaults to the interface language;
- user content (titles, descriptions, notes, ideas, lane names a project renamed).

Languages: English (source), Simplified Chinese `zh-CN`, Traditional Chinese `zh-TW`, Japanese `ja`, 한국어 `ko`, Español `es`, Français `fr`, Deutsch `de`, Português (Brasil) `pt-BR`, Русский `ru`. The list is `locales` in `shared/i18n.ts`.

The Paseo SDK (0.11.2) exposes no host language, so the plugin follows the device (`Intl.DateTimeFormat().resolvedOptions().locale`, mapped by `resolveLocale`) unless the user picks one.

## 2. Setting

Host-scoped setting `language` (`languageSettings` in `shared/settings.ts`, registered in `index.server.ts`): `"auto"` (default, follow the device) or one language code. UI: Ultra Kanban settings → **Language**. An unreadable or invalid stored value behaves as `"auto"`. Changing it applies at once to every plugin surface (board, sidebar entry, workspace panel); the Command Center entries are registered once at load and follow the device language until the plugin reloads.

## 3. Mechanism (gettext style, English text is the key)

- `t("Add task")`, `t("Moved to {lane}", { lane })`, `tn(count, "{n} card", "{n} cards")` in `shared/i18n.ts`. No catalog entry (or English) returns the source text, so an untranslated string is English, never blank.
- Placeholders are `{name}`; every translation must keep exactly the placeholders of its key. `tn` takes the singular and the plural English text; the catalog key is the **plural** text and its value is a string or per-CLDR-category forms (`one`, `few`, `many`, `other`) chosen with `Intl.PluralRules`. `{n}` is the count.
- Module-level tables use `msg("…")` (identity, found by the extractor) and translate when rendered (`t(label)`), or `localizedLabels({...})` whose values translate on read (`statusLabels`, `taskTypeLabels`, `priorityLabels`, `relationLabels`, activity verbs). Never call `t` at module load: it would freeze the language.
- The current language is a module variable set by `LocaleRoot` (`client/i18n.tsx`), which wraps each surface and remounts it (`key`) when the language changes. The daemon never sets one, so it stays English (prompts, errors); `withLocale(code, fn)` exists for daemon code that must build text for a given language.
- Compared strings stay English identities (`state.label === "Error"`, transcript authors): translate at display, not at creation.
- Dates use `formatLocale()`. Insight suggestions travel as `rule` + `args` (`Insight.args`) and are rendered client-side, so changing language needs no new daemon read.

## 4. Catalogs and tests

`shared/i18n/<code>.ts` is `Record<english, translation>`; `shared/i18n/catalogs.ts` registers them. `shared/i18n.test.ts` reads the source with the TypeScript compiler (`shared/i18n-keys.ts`) and fails when, for any language, a string is missing, a catalog entry is stale, a placeholder differs or a translation is empty. It also covers language resolution, fallback, plural selection and restoring the language after `withLocale`.

**Delivery (not in the client bundle).** The client bundle is evaluated from source at every app start, and the nine catalogs were 1.18 MB of its 2.12 MB. They are no longer imported by client code: `shared/i18n.ts` holds an empty registry (`registerCatalog`, `hasCatalog`); the daemon registers all of them (`shared/i18n-all.ts`, daemon and tests only) and serves one language on request (`i18n.catalog { locale }`, 78–127 KB of JSON). `client/catalog.ts` loads the language once per run; `LocaleRoot` (`client/i18n.tsx`) waits up to 400 ms for it before rendering a surface, then shows English and remounts the surface in the language when it arrives; the device language's catalog is also requested at plugin load for the Command Center titles (rebuilt when it lands). English never requests anything. A failed request leaves English and is retried by the next surface that mounts. `client/catalog.test.ts` fails when anything reachable from `index.client.tsx` imports `i18n-all` or `i18n/*`.

Adding text: write `t("…")`, run `npm test`, add the missing entries to each catalog. Adding a language: add it to `locales`, create `shared/i18n/<code>.ts`, register it in `catalogs.ts`.

## 5. Acceptance

See [verification/i18n.md](verification/i18n.md).
