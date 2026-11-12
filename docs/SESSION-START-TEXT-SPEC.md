# New session starting text

Status: implemented on Noah's request (2026-11-12).

## 1. What it is

A card's **New session** form (the card drawer's New session) opens with editable text in its message box instead of an empty box. The text comes from a per-project setting, **New session starting text**; with none set it is the built-in default:

> Read the card and pick up where it left off.

The text is the session's first message, so it is agent-facing and stays English (not translated); the user can edit it before sending.

## 2. Setting

- Project record: optional `sessionStartText` (string, at most 2000 characters). Absent means the built-in default.
- `projects.update` takes `sessionStartText`; the server trims it and caps it at 2000 characters; an empty (or whitespace-only) value removes it, so the built-in default applies again. It goes through the usual project revision check.
- UI: Project settings (Edit project and each project section of Group settings) has a multiline **New session starting text** field below Delivery mode; its placeholder shows the built-in default.
- No group or host level.

## 3. Form behavior

- Each time the form opens, the message box is filled with the project's starting text (`sessionStartText(project)` in `shared/session-start.ts`).
- A session started from an idea (Ideas page, IDEAS-SPEC §6.3) keeps the idea's own prompt; the starting text is not used.
- Create is no longer blocked by an empty box. The message sent is the typed text, trimmed; when the box is empty (or only whitespace) it is the card's title, then a blank line and its description when it has one (`sessionFirstMessage`). This applies to both Create session and Create ordinary session.
- The placeholder of the empty box reads "Empty sends the card's title and description".
- New task → Start an agent now is unchanged (UI-REFRESH-SPEC §7s).

## 4. Acceptance

- A project with no setting: New session opens with "Read the card and pick up where it left off."; sending it unchanged sends that text.
- A project with a starting text: the box opens with it; editing the setting changes the next open.
- Clearing the box and creating sends "<title>\n\n<description>" (just the title when the description is empty).
- An idea-seeded session opens with the idea's prompt.
- Saving an empty setting removes it from the project record.
