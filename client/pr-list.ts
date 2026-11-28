import type { z } from "zod";
import type { Status } from "../shared/model";
import type { listPrs } from "../shared/rpc";
import type { PrState } from "../shared/pr-rows";
import { msg, t, tn } from "../shared/i18n";

/** The board's pull requests menu (PR-MENU-SPEC): pure rules for its chip count, sections, order and row text. */

export type PrListRow = z.infer<typeof listPrs.output>["rows"][number];
export type PrSectionId = "open" | "reviewing" | "closed" | "unknown";
export type PrSection = { id: PrSectionId; rows: PrListRow[] };

/**
 * The chip's counts (§2.1, D12, D20): the overview's per-card `prs` (visible), `prsHidden` and `prsMine` (the visible
 * ones the menu's last read found to be the user's) over the live cards of the projects the board shows.
 */
export function prCount(
  projects: readonly { id: string }[],
  tasks: readonly { id: string; projectId: string; archivedAt: string | null }[],
  facts: ReadonlyMap<string, { prs: number; prsHidden?: number; prsMine?: number }>,
): { shown: number; hidden: number; mine: number } {
  const ids = new Set(projects.map((p) => p.id));
  let shown = 0,
    hidden = 0,
    mine = 0;
  for (const t of tasks)
    if (!t.archivedAt && ids.has(t.projectId)) {
      shown += facts.get(t.id)?.prs ?? 0;
      hidden += facts.get(t.id)?.prsHidden ?? 0;
      mine += facts.get(t.id)?.prsMine ?? 0;
    }
  return { shown, hidden, mine };
}

/**
 * The chip's parts (§2.1, D20–D22): `text` is the total; `mine` is the text *{m} yours* shown after a person icon, null while
 * none is known to be the user's (the chip is then the total alone). `label` is the full sentence for screen readers;
 * `tooltip` repeats it on web hover, only when the person icon is shown.
 */
export function prChipText(prs: number, mine: number): { text: string; mine: string | null; label: string; tooltip: string | null } {
  const text = tn(prs, "{n} PR", "{n} PRs");
  const label = tn(prs, "Show {n} pull request", "Show {n} pull requests");
  if (mine <= 0) return { text, mine: null, label, tooltip: null };
  const full = t("{prs}, {mine} yours", { prs: label, mine });
  return { text, mine: t("{mine} yours", { mine }), label: full, tooltip: full };
}

/** Whether a row gets the "Your PR" marker (D19): only when the author is known to be the user; unknown never does. */
export const isOwnPr = (r: { mine: boolean | null }): boolean => r.mine === true;

// Board lane order, furthest along first (D5); a card no longer on the board sorts last.
const laneRank: Partial<Record<Status, number>> = { integrated: 0, committed: 1, in_review: 2, test: 3, development: 4, design: 5, blocked: 6, todo: 7, backlog: 8 };
const rankOf = (status: Status | undefined) => (status ? laneRank[status] ?? 9 : 10);
const baseSectionOf = (r: PrListRow): PrSectionId => (r.kind === "review" ? "reviewing" : r.state === "merged" || r.state === "closed" ? "closed" : "open");
const sectionOrder: PrSectionId[] = ["open", "reviewing", "closed", "unknown"];

/** The hidden view's rows (D14): the hidden ones, newest PR first. */
export function hiddenPrRows(rows: readonly PrListRow[]): PrListRow[] {
  return rows.filter((r) => r.hidden).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.taskId.localeCompare(b.taskId) || a.url.localeCompare(b.url));
}

/**
 * Open (Open, Draft or unknown), Reviewing (PR review cards), Merged or closed; each only with rows, hidden ones left out
 * (D5, D14). With `mine` on (D15, D17): own PRs only in Open and Merged or closed, review rows dropped, and PRs whose
 * author is not known in a last "unknown" section; PRs known to be someone else's are left out.
 */
export function prSections(allRows: readonly PrListRow[], statusOf: (taskId: string) => Status | undefined, options: { mine?: boolean } = {}): PrSection[] {
  const rows = allRows.filter((r) => !r.hidden && (!options.mine || (r.kind !== "review" && r.mine !== false)));
  const sectionOf = (r: PrListRow): PrSectionId => (options.mine && r.mine === null ? "unknown" : baseSectionOf(r));
  const sorted = [...rows].sort(
    (a, b) =>
      rankOf(statusOf(a.taskId)) - rankOf(statusOf(b.taskId)) ||
      b.createdAt.localeCompare(a.createdAt) ||
      a.taskId.localeCompare(b.taskId) ||
      a.url.localeCompare(b.url),
  );
  return sectionOrder.flatMap((id) => {
    const list = sorted.filter((r) => sectionOf(r) === id);
    return list.length ? [{ id, rows: list }] : [];
  });
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `#n` / `!n`, then the PR's own title exactly as the host has it when known (D25); otherwise the artifact title unless it is empty, the URL or only the number; a review row uses the card title
 * without its "PR review:" lead (§2.3). The row's own number is dropped from the front only when written as a number
 * (`#42`, `!7`, `PR #42`, or on a review row `owner/repo#42`) and followed by the end, a separator or a space; a bare
 * leading number ("2024 roadmap" on #2024) is part of the title and stays. When that leaves only the number, the card
 * title (cleaned the same way) follows it.
 */
export function prRowTitle(row: PrListRow, cardTitle: string): string {
  const exact = row.prTitle.trim();
  if (exact) return `${row.number} ${exact}`;
  const own = cleanTitle(row, row.kind === "review" ? cardTitle : row.title);
  if (own !== row.number || row.kind === "review") return own;
  return cleanTitle(row, cardTitle);
}

function cleanTitle(row: PrListRow, title: string): string {
  let rest = title.trim();
  if (!rest || rest === row.url) return row.number;
  const number = `${escape(row.number)}(?!\\d)(?:\\s*[:·\\-–—]\\s*|\\s+|$)`;
  if (row.kind === "review") {
    rest = rest.replace(/^PR review:\s*/i, "");
    rest = rest.replace(new RegExp(`^[\\w.-]+/[\\w.-]+${number}`), "");
  }
  rest = rest.replace(new RegExp(`^(?:(?:PR|MR|Pull request|Merge request)\\s*)?${number}`, "i"), "").trim();
  return rest ? `${row.number} ${rest}` : row.number;
}

const stateWords: Record<Exclude<PrState, "">, string> = { draft: msg("Draft"), open: msg("Open"), merged: msg("Merged"), closed: msg("Closed") };
const stateCues: Record<Exclude<PrState, "">, { icon: "GitPullRequest" | "GitPullRequestDraft" | "GitMerge" | "GitPullRequestClosed"; tone: "running" | "muted" | "success" | "danger" }> = {
  open: { icon: "GitPullRequest", tone: "running" },
  draft: { icon: "GitPullRequestDraft", tone: "muted" },
  merged: { icon: "GitMerge", tone: "success" },
  closed: { icon: "GitPullRequestClosed", tone: "danger" },
};

/** The state icon of a row (D26): its shape, colour tone and English word (the caller translates it with `t()`); null when the state is unknown. */
export function prStateCue(state: PrState): { icon: (typeof stateCues)[Exclude<PrState, "">]["icon"]; tone: (typeof stateCues)[Exclude<PrState, "">]["tone"]; word: string } | null {
  return state ? { ...stateCues[state], word: stateWords[state] } : null;
}

/** `project · owner/repo · card · lane` (§2.3): the project only when several are shown, the repo when known, no card on a review row. */
export function prRowDetail(row: PrListRow, where: { card: string; lane: string; project?: string }): string {
  return [where.project ?? "", row.repo, row.kind === "review" ? "" : where.card, where.lane].filter(Boolean).join(" · ");
}

/**
 * The line under "My PRs" (D17): "none" when no visible pull request is known to be the user's, "noLogin" when none of
 * them has a known author or login at all; null when the list shows something of the user's or there is nothing to show.
 */
export function mineNote(allRows: readonly PrListRow[]): "none" | "noLogin" | null {
  const rows = allRows.filter((r) => !r.hidden);
  if (!rows.length || rows.some((r) => r.kind !== "review" && r.mine === true)) return null;
  const own = rows.filter((r) => r.kind !== "review");
  return own.length && own.every((r) => r.mine === null) ? "noLogin" : "none";
}

/**
 * Whether the list read (`prs.list`) runs, and whether its arrival refreshes the overview (PR-MENU-SPEC D23): while the
 * menu is open, or while the board shows a visible PR, so the chip's yours count shows without opening the menu. Every
 * arrival refreshes the overview, because that read is what fills the daemon's "yours" index (D20).
 */
export function prListRead(input: { open: boolean; prs: number }): { enabled: boolean; refreshOnArrival: boolean } {
  const enabled = input.open || input.prs > 0;
  return { enabled, refreshOnArrival: enabled };
}
