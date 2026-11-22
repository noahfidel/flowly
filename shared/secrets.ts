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

/*
 * The tool-call masker's own patterns (`maskSecrets`), wider than the redaction's and the memory check's. Every one
 * runs in linear time: a pattern that starts with a repeated class is anchored to a boundary character, so a long
 * run of word characters is scanned once, not once per position.
 */

/** A key or variable name that holds a credential: `password`, `TOKEN`, `x-api-key`, `DB_PASSWORD`, `Authorization`. */
const credentialName = /token|key|secret|passw(?:or)?d|authoriz|auth(?!or)|credential|cookie/i;

/** Whether a key or variable name holds a credential (over-matches on purpose: `primaryKey`, `monkey`). */
export function isCredentialName(name: string): boolean {
  return credentialName.test(name);
}

// The value stops at a quote, so a header inside a quoted shell argument keeps its closing quote.
const authHeader = new RegExp(`${AUTH_HEADER}[^\\s"']+`, "gi");
// Any scheme: https://user:pass@, postgres://user:pass@, redis://:pass@.
const urlCredentials = /(^|[^A-Za-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi;
/**
 * `name=value`, `name: value`, `"name": "value"` (JSON, YAML, shell, env). The value is a quoted string (any
 * content, one line) or an unquoted run; whether the name is a credential's is decided in the replacer.
 */
const assignment = /(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]+)(["']?[ \t]*[=:][ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s"',;}\]=][^\s"',;}\]]*)/g;
/*
 * A token after a non-alphanumeric character or a JSON escape (`\n`, `\t`, `A`), which a `\b` would miss.
 * The shapes' open-ended runs are bounded here, so text like `-eyJ-eyJ-eyJ…` cannot make every start scan to the end.
 */
const boundedShapes = TOKEN_SHAPES.replace(/\{(\d+),\}/g, "{$1,512}").replace(/\]\+/g, "]{1,2048}");
const tokens = new RegExp(`(^|[^A-Za-z0-9]|\\\\[nrtbf]|\\\\u[0-9A-Fa-f]{4})(?:${boundedShapes})`, "g");
/** Values that are an auth scheme, already masked by the header rule. */
const scheme = /^(?:Bearer|Basic|token)$/i;

function maskAssignment(match: string, before: string, name: string, separator: string, value: string): string {
  if (!isCredentialName(name)) return match;
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
  const inner = quote ? value.slice(1, -1) : value;
  if (!inner || inner.startsWith("<secret>") || scheme.test(inner)) return match;
  return `${before}${name}${separator}${quote}<secret>${quote}`;
}

/**
 * Masks credentials in text shown to the user from a session's tool call: header values, credentials in any URL,
 * any non-empty value assigned to a credential-like name (`PASSWORD=…`, `"token": "…"`, `x-api-key: …`,
 * `"Authorization": "Bearer …"`), and known token shapes, also right after a JSON escape, become `<secret>`.
 * Paths, emails and other text stay as they are.
 */
export function maskSecrets(text: string): string {
  return text
    .replace(authHeader, "$1 <secret>")
    .replace(urlCredentials, "$1$2<secret>@")
    .replace(assignment, maskAssignment)
    .replace(tokens, "$1<secret>");
}
