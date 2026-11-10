import type { Task, Workpad } from "./model";

/** What a card needs before work starts (CARD-SETUP-SPEC §3), in this fixed order. */
export const setupItems = ["type", "tags", "workpad"] as const;
export type SetupItem = (typeof setupItems)[number];

/**
 * The card's missing setup: no type, no tags (from anyone), or no acceptance list while the project has the workpad
 * on (`workpad` keeps its name; GUARDRAILS-SPEC §6.1).
 */
export function setupMissing(task: Pick<Task, "type" | "tags">, workpad: Pick<Workpad, "acceptance"> | null | undefined, workpadOn: boolean): SetupItem[] {
  const out: SetupItem[] = [];
  if (!task.type) out.push("type");
  if (!task.tags?.length) out.push("tags");
  if (workpadOn && !workpad?.acceptance.length) out.push("workpad");
  return out;
}

/** get_task's `setup` (CARD-SETUP-SPEC §3.1). */
export function setupContext(missing: readonly SetupItem[], stage: Task["status"]) {
  return {
    typeMissing: missing.includes("type"),
    tagsMissing: missing.includes("tags"),
    workpadMissing: missing.includes("workpad"),
    stage,
    missing: [...missing],
  };
}

// Agent-facing, English (CARD-SETUP-SPEC §3.3, §3.4).
const itemText: Record<SetupItem, string> = {
  type: "no type (flowly_set_type: feature, bugfix, research, refactor, docs or chore)",
  tags: "no tags (flowly_set_tags: 1-4 module or direction tags, reuse projectTags)",
  workpad: "no acceptance list (flowly_update_workpad: 3-5 acceptance criteria, before you implement)",
};
const itemsText = (missing: readonly SetupItem[]) => missing.map((m) => itemText[m]).join("; ");

/** The one reminder a write carries while setup is missing (§3.3). */
export const setupReminder = (missing: readonly SetupItem[]) =>
  `This card's setup is incomplete: ${itemsText(missing)}. Make these calls now, before more work; they take seconds. This write already succeeded.`;

/** The delivery refusal's setup line (§3.4). */
export const setupIncompleteMessage = (missing: readonly SetupItem[]) =>
  `Card setup is incomplete: ${itemsText(missing)}. The first attempt is always refused, even with acknowledgeOpen=true. Set them now and deliver again. Only after reviewing this refusal, retry with acknowledgeOpen=true and a note that explains why each one is still missing. A changed card or acceptance list, or a new turn, requires a new refusal.`;

/** The first-context line (§3.2); empty when nothing is missing. */
export const setupContextLine = (missing: readonly SetupItem[]) =>
  missing.length
    ? `Card setup missing: ${missing.join(", ")}. Before you change anything, set them (${missing
        .map((m) => (m === "type" ? "flowly_set_type" : m === "tags" ? "flowly_set_tags" : "flowly_update_workpad with 3-5 acceptance criteria"))
        .join(", ")}); see "Start of every turn" in the Flowly skill.`
    : "";
