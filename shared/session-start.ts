/**
 * The text a card's New session form opens with (SESSION-START-TEXT-SPEC). Pure: no React, no i18n. The text is
 * the session's first message, so it is agent-facing and stays English.
 */

/** Built-in starting text, used when the project sets none. */
export const defaultSessionStartText = "Read the card and pick up where it left off.";
/** Longest stored starting text. */
export const sessionStartMax = 2000;

/** The stored form of an edit: trimmed and capped; "" means none (the built-in default applies). */
export const sessionStartValue = (value: string) => value.trim().slice(0, sessionStartMax).trim();

/** What the New session box opens with in this project. */
export function sessionStartText(project: { sessionStartText?: string }): string {
  return sessionStartValue(project.sessionStartText ?? "") || defaultSessionStartText;
}

/** What the session is sent: the typed text, or the card's title and description when the box is empty. */
export function sessionFirstMessage(typed: string, task: { title: string; description: string }): string {
  const text = typed.trim();
  if (text) return text;
  const description = task.description.trim();
  return description ? `${task.title}\n\n${description}` : task.title;
}
