/**
 * Credential patterns shared by the workflow-insights redaction (`redact`), the
 * memory secret check (`containsSecret`) and the tool call details a card chat
 * loads (`maskSecrets`, SESSION-PANE-SPEC §1.3). Regex sources, so each caller
 * builds the flags and capture it needs. No lookbehind: the client loads this
 * module too, and older Hermes rejects it.
 */

/** An `Authorization:` header up to its value (group 1 is the header and scheme). */
export const AUTH_HEADER = String.raw`(Authorization:\s*(?:Bearer|Basic|token))\s+`;

/** An env-style name that holds a credential (`GITHUB_TOKEN`, `apiKey`, `DB_PASSWORD`). */
export const SECRET_NAME = String.raw`[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH)[A-Za-z0-9_]*`;

/** Well-known token shapes: JWTs, GitHub, GitLab, npm, OpenAI-style, Slack and AWS access keys. */
export const TOKEN_SHAPES = String.raw`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}`;

// The value stops at a quote, so a header inside a quoted shell argument keeps its closing quote.
const authHeader = new RegExp(`${AUTH_HEADER}[^\\s"']+`, "gi");
const urlCredentials = /(https?:\/\/)[^@\s/]+@/g;
const assignment = new RegExp(`\\b(${SECRET_NAME})=("[^"]*"|'[^']*'|\\S+)`, "gi");
// A quoted key with a quoted value of 8+ characters (JSON, YAML): `"apiKey": "…"`.
const quotedField = new RegExp(`(["']${SECRET_NAME}["']\\s*:\\s*)("[^"\\s]{8,}"|'[^'\\s]{8,}')`, "gi");
const tokens = new RegExp(`\\b(?:${TOKEN_SHAPES})`, "g");

/**
 * Masks credentials in text shown to the user from a session's tool call: header
 * values, credentials in URLs, `NAME=value` and `"name": "value"` assignments
 * of credential names, and known token shapes become `<secret>`. Paths, emails
 * and other text stay as they are.
 */
export function maskSecrets(text: string): string {
  return text
    .replace(authHeader, "$1 <secret>")
    .replace(urlCredentials, "$1<secret>@")
    .replace(assignment, "$1=<secret>")
    .replace(quotedField, '$1"<secret>"')
    .replace(tokens, "<secret>");
}
