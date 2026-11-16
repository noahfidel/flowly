/**
 * A project's base branch for new worktrees (START-CARD-SPEC §4.1, project setting `baseRef`). Pure: no React, no
 * i18n. Problems are English identities; the client translates them at render.
 */

/** Longest stored base ref. */
export const baseRefMax = 200;

/** The stored form of an edit: trimmed; "" means none (the main checkout's current branch). */
export const baseRefValue = (value: string) => value.trim();

/**
 * Why git would not take `value` as a ref name, or null when it would (`git check-ref-format --allow-onelevel`
 * rules, plus no leading "-" so it can never read as an option). "" is valid: it removes the setting.
 */
export function baseRefProblem(value: string): string | null {
  const ref = baseRefValue(value);
  if (!ref) return null;
  if (ref.length > baseRefMax) return "Base branch is too long.";
  if (
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock") ||
    ref.includes(".lock/") ||
    ref === "@" ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    ref.includes("/.") ||
    ref.startsWith(".") ||
    // Whitespace, control characters and the characters git reserves.
    /[\s\x00-\x1f\x7f~^:?*[\\]/.test(ref)
  )
    return "Base branch is not a valid branch name.";
  return null;
}
