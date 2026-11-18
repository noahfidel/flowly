import type { z } from "zod";
import type { Status } from "../shared/model";
import type { listPrs } from "../shared/rpc";

/** The board's pull requests menu (PR-MENU-SPEC): pure rules for its chip count, sections, order and row text. */

export type PrListRow = z.infer<typeof listPrs.output>["rows"][number];
export type PrSectionId = "open" | "reviewing" | "closed";
export type PrSection = { id: PrSectionId; rows: PrListRow[] };

/** The chip's count (§2.1): the overview's per-card `prs` over the live cards of the projects the board shows. */
export function prCount(
  projects: readonly { id: string }[],
  tasks: readonly { id: string; projectId: string; archivedAt: string | null }[],
  facts: ReadonlyMap<string, { prs: number }>,
): number {
  const ids = new Set(projects.map((p) => p.id));
  let n = 0;
  for (const t of tasks) if (!t.archivedAt && ids.has(t.projectId)) n += facts.get(t.id)?.prs ?? 0;
  return n;
}

// Board lane order, furthest along first (D5); a card no longer on the board sorts last.
const laneRank: Partial<Record<Status, number>> = { integrated: 0, committed: 1, in_review: 2, test: 3, development: 4, design: 5, blocked: 6, todo: 7, backlog: 8 };
const rankOf = (status: Status | undefined) => (status ? laneRank[status] ?? 9 : 10);
const sectionOf = (r: PrListRow): PrSectionId => (r.kind === "review" ? "reviewing" : r.state === "merged" || r.state === "closed" ? "closed" : "open");
const sectionOrder: PrSectionId[] = ["open", "reviewing", "closed"];

/** Open (Open, Draft or unknown), Reviewing (PR review cards), Merged or closed; each only with rows (D5). */
export function prSections(rows: readonly PrListRow[], statusOf: (taskId: string) => Status | undefined): PrSection[] {
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

/** `#n` / `!n`, then the artifact title unless it is empty, the URL or only the number; a review row uses the card title (§2.3). */
export function prRowTitle(row: PrListRow, cardTitle: string): string {
  const raw = (row.kind === "review" ? cardTitle : row.title).trim();
  if (!raw || raw === row.url) return row.number;
  const digits = row.number.slice(1);
  // "#42", "PR #42", "MR !7", "#42: …" repeat the number: drop it from the front.
  const rest = raw.replace(new RegExp(`^(?:(?:PR|MR|Pull request|Merge request)\\s*)?[#!]?${digits}\\b\\s*[:·\\-–—]?\\s*`, "i"), "").trim();
  return rest ? `${row.number} ${rest}` : row.number;
}

/** `project · owner/repo · card · lane` (§2.3): the project only when several are shown, the repo when known, no card on a review row. */
export function prRowDetail(row: PrListRow, where: { card: string; lane: string; project?: string }): string {
  return [where.project ?? "", row.repo, row.kind === "review" ? "" : where.card, where.lane].filter(Boolean).join(" · ");
}
