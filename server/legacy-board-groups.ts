import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { LegacyGroup } from "../shared/groups";

/**
 * The host's v1 board groups for the one-time migration (BOARD-GROUPS-SPEC §7 step 1). A raw parse of the stored
 * `board-view` settings file, independent of the typed settings schema (which drops `boardGroups` once it is no
 * longer a setting). The file is never written: the stored value stays in place and is ignored afterwards.
 */

/** The v1 reader's rules (`boardGroupSchema` in shared/settings.ts before groups moved into the board). */
const legacyGroupSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.preprocess((v) => (typeof v === "string" ? v.slice(0, 80) : ""), z.string().max(80)),
  projectIds: z.array(z.string().max(200)).max(500).catch([]),
});

/**
 * The stored groups through the v1 rules: an invalid entry is dropped, a bad member list reads as none, anything
 * other than a list reads as no groups. The 50-group cap is applied by the migration, in one place.
 */
export function legacyBoardGroups(values: unknown): LegacyGroup[] {
  const stored = typeof values === "object" && values !== null ? (values as { boardGroups?: unknown }).boardGroups : undefined;
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((g) => {
    const parsed = legacyGroupSchema.safeParse(g);
    return parsed.success ? [parsed.data] : [];
  });
}

export const legacyBoardViewPath = (paseoHome: string) => resolve(paseoHome, "plugin-settings", "flowly", "board-view.json");

/**
 * A missing file, bad JSON or an envelope without values reads as no groups, as the v1 reader did. A file that exists
 * but cannot be read throws, so the migration fails, writes nothing and runs again at the next start instead of
 * placing every project in **Projects**.
 */
export async function readLegacyBoardGroups(file: string): Promise<LegacyGroup[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const envelope = JSON.parse(text) as unknown;
    return legacyBoardGroups(typeof envelope === "object" && envelope !== null ? (envelope as { values?: unknown }).values : undefined);
  } catch {
    return [];
  }
}
