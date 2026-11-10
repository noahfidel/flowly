import { workpadLimits, type AcceptanceItem, type PlanSnapshot, type Workpad } from "./model";

/** Events of a workpad write by an agent and an edit by a person (WORKPAD-SPEC §2.3); not shown in Activity. */
export const workpadUpdatedAction = "workpad_updated";
export const workpadCheckedAction = "workpad_checked";

/** The project's Workpad switch (WORKPAD-SPEC §9); absent means on. */
export const workpadEnabled = (project: { workpad?: boolean } | null | undefined) => project?.workpad !== false;

/** An agent's acceptance list (GUARDRAILS-SPEC §7.1): its own claim of what "done" means, never a gate. */
export type WorkpadDraft = { acceptance: { id?: string; text: string; done: boolean }[] };

const textKey = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

function slug(text: string) {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return base || "item";
}

/**
 * Pairs each draft item with the previous item it replaces (same id, else
 * same text) and gives it an id: its own, the previous one's, or a new slug.
 */
function match<P extends { id: string; text: string }, D extends { id?: string; text: string }>(
  section: string,
  previous: readonly P[],
  draft: readonly D[],
): { item: D; id: string; prev?: P }[] {
  const explicit = new Set<string>();
  for (const d of draft) {
    if (!d.id) continue;
    if (explicit.has(d.id)) throw new Error(`Duplicate ${section} id "${d.id}".`);
    explicit.add(d.id);
  }
  const taken = new Set<P>();
  const pairs = draft.map((item) => {
    const prev = item.id ? previous.find((p) => p.id === item.id) : undefined;
    if (prev) taken.add(prev);
    return { item, prev };
  });
  for (const pair of pairs) {
    if (pair.item.id || pair.prev) continue;
    const prev = previous.find((p) => !taken.has(p) && !explicit.has(p.id) && textKey(p.text) === textKey(pair.item.text));
    if (prev) {
      taken.add(prev);
      pair.prev = prev;
    }
  }
  const used = new Set([...explicit, ...pairs.flatMap((p) => (p.prev && !p.item.id ? [p.prev.id] : []))]);
  return pairs.map(({ item, prev }) => {
    if (item.id) return { item, id: item.id, prev };
    if (prev) return { item, id: prev.id, prev };
    const base = slug(item.text);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return { item, id, prev };
  });
}

/**
 * The acceptance list an agent's full replacement produces (WORKPAD-SPEC §3.1). Unchanged items keep who changed
 * them last and when.
 */
export function mergeWorkpad(previous: Pick<Workpad, "acceptance"> | undefined, draft: WorkpadDraft, ctx: { now: string }): Pick<Workpad, "acceptance"> {
  if (draft.acceptance.length > workpadLimits.acceptance) throw new Error(`At most ${workpadLimits.acceptance} acceptance criteria.`);
  const acceptance: AcceptanceItem[] = match("acceptance", previous?.acceptance || [], draft.acceptance).map(({ item, id, prev }) =>
    prev && prev.text === item.text && prev.done === item.done
      ? { ...prev, id }
      : { id, text: item.text, done: item.done, by: "agent", at: ctx.now },
  );
  return { acceptance };
}

/** Event note for a workpad write, e.g. "Acceptance 2/4". English: it is history, not UI. */
export function workpadNote(workpad: Pick<Workpad, "acceptance">) {
  return workpad.acceptance.length ? `Acceptance ${workpad.acceptance.filter((a) => a.done).length}/${workpad.acceptance.length}` : "Workpad cleared";
}

/** The one workpad signal a card shows (GUARDRAILS-SPEC §7.1): `Acceptance n/m`. */
export type WorkpadSignal = { kind: "acceptance"; done: number; total: number };
export function workpadSignal(workpad: Pick<Workpad, "acceptance"> | null | undefined): WorkpadSignal | null {
  if (!workpad?.acceptance.length) return null;
  return { kind: "acceptance", done: workpad.acceptance.filter((a) => a.done).length, total: workpad.acceptance.length };
}

type TimelineItem = { type: string; items?: unknown };
type TodoItem = { text?: unknown; completed?: unknown; status?: unknown };

/**
 * The plan in a finished turn: its last native todo list (WORKPAD-SPEC §2.2).
 * undefined when the turn had none (keep the previous plan); [] clears it.
 */
export function planFromTimeline(timeline: readonly TimelineItem[] | undefined): PlanSnapshot["items"] | undefined {
  if (!timeline) return undefined;
  let last: TimelineItem | undefined;
  for (let i = timeline.length - 1; i >= 0 && !last; i--) if (timeline[i]?.type === "todo") last = timeline[i];
  if (!last || !Array.isArray(last.items)) return undefined;
  return (last.items as TodoItem[])
    .flatMap((item) => {
      const text = typeof item?.text === "string" ? item.text.trim().slice(0, workpadLimits.planText) : "";
      if (!text) return [];
      const status =
        item.status === "pending" || item.status === "in_progress" || item.status === "completed"
          ? item.status
          : item.completed === true
            ? "completed"
            : "pending";
      return [{ text, status } as const];
    })
    .slice(0, workpadLimits.planItems);
}

/** A card's plans, the most recently updated first. */
export function plansOf(plans: readonly PlanSnapshot[], taskId: string) {
  return plans.filter((p) => p.taskId === taskId).sort((a, b) => b.at.localeCompare(a.at));
}

export function workpadOf(workpads: readonly Workpad[] | undefined, taskId: string) {
  return workpads?.find((w) => w.taskId === taskId) ?? null;
}
