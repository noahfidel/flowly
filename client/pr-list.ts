import type { z } from "zod";
import type { Status } from "../shared/model";
import type { listPrs } from "../shared/rpc";

/** The board's pull requests menu (PR-MENU-SPEC): pure rules for its chip count, sections, order and row text. */

export type PrListRow = z.infer<typeof listPrs.output>["rows"][number];
export type PrSectionId = "open" | "reviewing" | "closed";
export type PrSection = { id: PrSectionId; rows: PrListRow[] };

/**
 * The chip's counts (§2.1, D12): the overview's per-card `prs` (visible) and `prsHidden` over the live cards of the
 * projects the board shows.
 */
export function prCount(
  projects: readonly { id: string }[],
  tasks: readonly { id: string; projectId: string; archivedAt: string | null }[],
  facts: ReadonlyMap<string, { prs: number; prsHidden?: number }>,
): { shown: number; hidden: number } {
  const ids = new Set(projects.map((p) => p.id));
  let shown = 0,
    hidden = 0;
  for (const t of tasks)
    if (!t.archivedAt && ids.has(t.projectId)) {
      shown += facts.get(t.id)?.prs ?? 0;
      hidden += facts.get(t.id)?.prsHidden ?? 0;
    }
  return { shown, hidden };
}

// Board lane order, furthest along first (D5); a card no longer on the board sorts last.
const laneRank: Partial<Record<Status, number>> = { integrated: 0, committed: 1, in_review: 2, test: 3, development: 4, design: 5, blocked: 6, todo: 7, backlog: 8 };
const rankOf = (status: Status | undefined) => (status ? laneRank[status] ?? 9 : 10);
const sectionOf = (r: PrListRow): PrSectionId => (r.kind === "review" ? "reviewing" : r.state === "merged" || r.state === "closed" ? "closed" : "open");
const sectionOrder: PrSectionId[] = ["open", "reviewing", "closed"];

/** The hidden view's rows (D14): the hidden ones, newest PR first. */
export function hiddenPrRows(rows: readonly PrListRow[]): PrListRow[] {
  return rows.filter((r) => r.hidden).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.taskId.localeCompare(b.taskId) || a.url.localeCompare(b.url));
}

/** Open (Open, Draft or unknown), Reviewing (PR review cards), Merged or closed; each only with rows, hidden ones left out (D5, D14). */
export function prSections(allRows: readonly PrListRow[], statusOf: (taskId: string) => Status | undefined): PrSection[] {
  const rows = allRows.filter((r) => !r.hidden);
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
 * `#n` / `!n`, then the artifact title unless it is empty, the URL or only the number; a review row uses the card title
 * without its "PR review:" lead (§2.3). The row's own number is dropped from the front only when written as a number
 * (`#42`, `!7`, `PR #42`, or on a review row `owner/repo#42`) and followed by the end, a separator or a space; a bare
 * leading number ("2024 roadmap" on #2024) is part of the title and stays.
 */
export function prRowTitle(row: PrListRow, cardTitle: string): string {
  let rest = (row.kind === "review" ? cardTitle : row.title).trim();
  if (!rest || rest === row.url) return row.number;
  const number = `${escape(row.number)}(?!\\d)(?:\\s*[:·\\-–—]\\s*|\\s+|$)`;
  if (row.kind === "review") {
    rest = rest.replace(/^PR review:\s*/i, "");
    rest = rest.replace(new RegExp(`^[\\w.-]+/[\\w.-]+${number}`), "");
  }
  rest = rest.replace(new RegExp(`^(?:(?:PR|MR|Pull request|Merge request)\\s*)?${number}`, "i"), "").trim();
  return rest ? `${row.number} ${rest}` : row.number;
}

/** `project · owner/repo · card · lane` (§2.3): the project only when several are shown, the repo when known, no card on a review row. */
export function prRowDetail(row: PrListRow, where: { card: string; lane: string; project?: string }): string {
  return [where.project ?? "", row.repo, row.kind === "review" ? "" : where.card, where.lane].filter(Boolean).join(" · ");
}
