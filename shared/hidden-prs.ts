import { z } from "zod";

/**
 * Hiding a PR from the board's pull requests menu (PR-MENU-SPEC D11): one entry per card and trimmed PR URL. The PR
 * stays linked to its card; only the menu and its count leave it out.
 */
export const hiddenPrLimits = { records: 2000, url: 2000 } as const;

export const hiddenPrSchema = z.strictObject({
  taskId: z.string().min(1).max(200),
  url: z.string().min(1).max(hiddenPrLimits.url),
  hiddenAt: z.string().datetime(),
});
export type HiddenPr = z.infer<typeof hiddenPrSchema>;

export const hidePrInput = z.strictObject({ taskId: z.string().min(1).max(200), url: z.string().trim().min(1).max(hiddenPrLimits.url) });
export type HidePrInput = z.infer<typeof hidePrInput>;
export const restorePrInput = hidePrInput;
export type RestorePrInput = HidePrInput;

/** The identity of a hidden PR: the card plus the trimmed URL (what `cardPrs` rows carry). */
export const prHiddenKey = (taskId: string, url: string) => `${taskId}\n${url.trim()}`;

/** The keys of the stored entries, for a lookup per row. */
export const hiddenPrKeys = (entries: readonly { taskId: string; url: string }[] | undefined) =>
  new Set((entries ?? []).map((e) => prHiddenKey(e.taskId, e.url)));
