# Start prompt template

Status: specified 2026-11-27 (rulings, Noah 2026-11-26: 1A if-blocks in text, 2A every start path, 3A file-name spec rule, 4A same field everywhere). Supersedes [SESSION-START-TEXT-SPEC](SESSION-START-TEXT-SPEC.md) §1–§2 where they differ.

## 1. What it is

A project's **Start prompt** (the setting that was *New session starting text*, project field `sessionStartText`) is a template. When a card's session starts and nobody typed or passed a first message, Flowly renders the template against the card's state and sends the result as the session's first message.

Plain text with no `{{…}}` is a valid template and renders as itself. A project with no template behaves exactly as before, on every path (§4).

The template is the project's own text. Flowly names no skills or tools; a project maps states to whatever instructions it wants (example in §7). The rendered text is agent-facing and stays English (not translated).

## 2. Template language

Pure module `shared/start-prompt.ts`; no React, no Node. Its only i18n use is reading lane labels in English (`withLocale("en", …)` around `laneName`), since the built-in labels are translated lazily.

- `{{name}}` inserts a variable's value. A list is joined with ", ". A boolean is `true` or `false`. A number is printed in decimal.
- `{{#if cond}} … {{else if cond}} … {{else}} … {{/if}}`. Blocks can nest. `{{else if}}` and `{{else}}` are optional, and `{{else}}` must come last.
- `cond` is a chain of terms joined by `&&` and `||`. `&&` binds tighter. There are no parentheses. A term is one of:
  - `name` (true when the value is truthy: `true`, a non-empty string, a non-empty list, a number > 0)
  - `!name`
  - `name == value` or `name != value`. The value is a bare word (`[A-Za-z0-9_-]+`) or a double-quoted string. A list matches when any element equals the value. A boolean or number compares its printed form.
- Whitespace inside `{{ … }}` is ignored.
- Output whitespace:
  - a line that holds only one block tag (`#if`, `else if`, `else`, `/if`) plus spaces is removed with its line break;
  - after rendering, runs of three or more line breaks collapse to two (one blank line);
  - the result is trimmed.
  - a line holding only spaces or tabs counts as blank for that collapse.
- `}}` always ends a tag, also inside a quoted value.
- Errors make a template invalid:
  - an unknown variable name, in a value or a condition;
  - an unclosed `{{#if}}`, or a stray `{{else}}`, `{{else if}}` or `{{/if}}`;
  - an `{{else if}}` after `{{else}}`;
  - an empty condition, or a malformed term;
  - an unterminated `{{`.

  `parseTemplate(text)` returns `{ ok: true, template }` or `{ ok: false, error, line }`. `error` is English with a 1-based `line`. The client translates the fixed prefix only.
- `renderTemplate(template, state)` never throws for a parsed template.
- `{{` with nothing valid after it is an error. There is no escape syntax; literal `{{` is not supported.

## 3. Variables

The state is built by `promptState(...)` from what Flowly knows at start time. Where a start path has no card yet (New task), §4 says what each variable holds.

| Name | Type | Value |
|---|---|---|
| `title` | string | card title |
| `description` | string | card description, trimmed |
| `lane` | string | the card's status id (`todo`, `design`, `development`, …) when the prompt is built. This is before Start moves a Backlog/Todo card to its work lane |
| `laneName` | string | that lane's display name in the project (custom name, else the built-in English label) |
| `type` | string | card type, or "" |
| `deliveryMode` | string | resolved delivery mode: `branch`, `draft_pr`, `ready_pr` or `ship_main` |
| `plan` | string | the plan's target (absolute path for a file plan, else the link), or "" when the card has no plan |
| `planApproved` | boolean | the card has a plan and it is approved |
| `spec` | list | titles of the spec inputs (§3.1) |
| `inputs` | list | titles of every input artifact except the plan, newest first |
| `externalInputs` | list | items attached from a connected service, named like the From… default: a page by its title, everything else by its key |
| `reviewNotes` | number | open findings of the card's latest auto review (§3.2) |
| `delivered` | boolean | the card was delivered before (`deliveredAt` is set) |
| `links` | list | titles of the cards linked to this one |
| `tags` | list | the card's tags (a hint only: agents usually set them after start) |
| `firstSession` | boolean | the card has had no session before this one |

### 3.1 Spec inputs

An input artifact (role `input`, not the plan) is a spec when either is true:

- its target's file name (the last path segment, query and fragment removed) is `spec.md`, or ends in `-SPEC.md` or `_SPEC.md` (case-insensitive);
- its title starts with "spec" (case-insensitive) followed by the end of the title or a non-letter.

`isSpecInput(artifact)` holds the rule.

### 3.2 Review notes

`reviewNotes` is 0 unless the card's latest auto review (`task.review`) is in state `rework` or `failed`. In that case it is the number of its items that are `gating` and in state `failed`. Disputed items do not count.

## 4. Where it applies

The template is used only when the first message would otherwise be a built-in default. A message the user typed, or a `prompt` a caller passed, is always sent as is.

| Path | No template (unchanged) | With a template |
|---|---|---|
| Card drawer **New session** | box opens with "Read the card and pick up where it left off." | box opens with the template rendered for this card; the user can edit it before sending |
| Drawer, the user clears the box | sends title + description (SESSION-START-TEXT §3) | unchanged |
| Session started from an idea | the idea's prompt | unchanged |
| `flowly_start_card` / dispatcher start / **Start again**, no `prompt` | title, description, approved-plan line | the rendered template |
| … with a `prompt` | the prompt | the prompt |
| … first session of a card branched from its parent | the rebase line is appended | the rebase line is appended |
| **New task** / **Quick task** → start an agent, empty box | From… default, else Create is blocked | the rendered template (Create is not blocked) |
| … with typed text | the text | the text |
| Quick task, empty box and no From… item to name the card | Create is blocked | Create stays blocked (a card needs a title) |

On New task and Quick task the card does not exist yet. The state is built from the form:

- `title` and `description` as typed;
- `lane` is the card's starting lane;
- `type` as picked;
- `deliveryMode` resolved as the card will get it;
- `plan` is "" and `planApproved` is false;
- `inputs` and `externalInputs` are the picked From… items;
- `spec` comes from those items by §3.1;
- `reviewNotes` is 0 and `delivered`, `links` and `tags` are empty or false;
- `firstSession` is true.

A rendered template that is empty (all its sections were false) counts as no template on that path.

A stored template that does not parse (it should not happen, since saving validates it) also counts as no template. The daemon logs it with `logFailure`; the client falls back silently.

## 5. Setting

- Field `sessionStartText`, at most 4000 characters (was 2000). Trimmed. Empty removes it.
- `projects.update` refuses a template that does not parse (`VALIDATION`, message `Start prompt: <error> (line N)`). The project is unchanged. The `projectEdit` schema and `BoardStore.updateProject` both check.
- UI (Edit project, and each project section of Group settings):
  - the multiline field is labelled **Start prompt**;
  - under it, one hint line: "Use {{title}}, {{#if planApproved}}…{{else}}…{{/if}}. Variables: …" listing the variable names;
  - when the text does not parse, the error with its line is shown in place of the preview; Save is disabled only when the Start prompt was changed in this edit (an untouched stored text that does not parse never blocks saving other fields);
  - **Preview**: a card picker (the project's live cards outside Done/Cancelled, newest first; none selected → the first) and, below it, the template rendered for that card in a read-only monospace block. When the field is empty, the preview shows what that card would get today on the drawer path. The preview updates as the user types (debounced, ~250 ms).
- No group or host level.

## 6. Tool text

`flowly_start_card`'s `prompt` description: absent or blank sends the project's Start prompt rendered for the card when the project has one, else the card's title and description plus its approved plan.

## 7. Example template (documentation only; not shipped as a default)

```
{{#if reviewNotes}}
The last review left {{reviewNotes}} open findings. Work those first.
{{else if planApproved}}
Run the approved plan: {{plan}}.
{{else if spec}}
A spec is attached ({{spec}}). Write the implementation plan from it before coding.
{{else if lane == design || !plan}}
No spec or plan yet. Start with design: explore the problem, show options, and write a spec before any code.
{{else}}
Read the card and pick up where it left off.
{{/if}}
```

## 8. Acceptance

- A project with no template:
  - New session opens with "Read the card and pick up where it left off.";
  - `flowly_start_card` without a prompt sends title + description (+ plan line);
  - New task with an empty box and From… items sends the From… default, and without items Create is blocked.
- With the §7 template:
  - a card with no spec and no plan gets the design section;
  - a card with a `spec.md` input and an unapproved plan gets the plan-writing section;
  - a card with an approved plan gets the run section;
  - a card whose latest review is `rework` with 2 failed gating items gets the findings section.
- `flowly_start_card` with a template set and no prompt sends the rendered template, plus the rebase line on a branched first session. With a prompt, it sends the prompt.
- Saving an invalid template is refused with its line; saving "" removes it.
- The settings preview shows the rendered prompt for a picked card and updates while typing.
