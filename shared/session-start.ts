/**
 * The text a card's New session form opens with (SESSION-START-TEXT-SPEC), now the project's Start prompt template
 * (START-PROMPT-TEMPLATE-SPEC). Pure: no React, no i18n. The text is the session's first message, so it is
 * agent-facing and stays English.
 */
import { parseTemplate } from "./start-prompt";


/** Built-in starting text, used when the project sets none. */
export const defaultSessionStartText = "Read the card and pick up where it left off.";
/** Longest stored starting text. */
export const sessionStartMax = 4000;

/** The stored form of an edit: trimmed and capped; "" means none (the built-in default applies). */
export const sessionStartValue = (value: string) => value.trim().slice(0, sessionStartMax).trim();

/** Why a stored Start prompt is invalid, as "<error> (line N)"; "" when it parses or is empty (START-PROMPT-TEMPLATE-SPEC §5). */
export function sessionStartProblem(text: string): string {
  if (!text.trim()) return "";
  const parsed = parseTemplate(text);
  return parsed.ok ? "" : `${parsed.error} (line ${parsed.line})`;
}

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
