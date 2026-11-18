import { useEffect, useRef, type MutableRefObject } from "react";
import { View } from "react-native";
import type { AutoReviewInput, Group, Project } from "../shared/model";
import { effectiveAutoReview } from "../shared/auto-review";
import { useGuardrailsQuery } from "./queries";
import { inheritedAutoReviewText } from "./group-settings-logic";
import { Choices, Label, Toggle, font, space } from "./ui";
import { t } from "../shared/i18n";

/** `override`: the project has its own value (BOARD-GROUPS-SPEC §5); off, it follows its group's. */
export type ReviewEdit = { override: boolean; on: boolean; rounds: string };

/** The value a `projects.update` sends for the edit: the override, or null to follow the group again. */
export const autoReviewPatch = (edit: ReviewEdit): AutoReviewInput | null => (edit.override ? { enabled: edit.on, maxRounds: Number(edit.rounds) } : null);

/** A project's edit state as stored: its override when it has one, else what it inherits from `group` (seeds the switch). */
export function reviewEditOf(project: Pick<Project, "autoReview"> | null | undefined, group: Pick<Group, "defaults"> | null | undefined): ReviewEdit {
  const value = effectiveAutoReview(project, group);
  return { override: !!project?.autoReview, on: value.enabled, rounds: String(value.maxRounds) };
}

/**
 * Auto review's switch with its cost and Max rework rounds (GUARDRAILS-SPEC §8). Group settings → Defaults uses it as
 * it is; a project's settings (`group` given) first offer *Override group Auto review*: off shows what the project follows
 * from its group, on shows the switch and rounds saved as the project's own value (BOARD-GROUPS-SPEC §5). One line of
 * the project's check commands shows when it has some. The daemon detects the commands when a project's Auto review
 * turns on (§4.5); nothing is detected or added before Save.
 */
export function AutoReviewSection({
  project,
  group,
  value,
  onChange,
  switchOn,
  applied,
}: {
  project?: Project;
  /** A project's group: shows the override switch and what the project follows without one. Absent: the group's own value. */
  group?: Group | null;
  value: ReviewEdit;
  onChange(next: ReviewEdit): void;
  /** Opened from What's new: Auto review starts on for this project (as its override when its group's value is off). */
  switchOn?: boolean;
  /** Owned by the caller's state so it survives this section unmounting (a collapsed section). */
  applied?: MutableRefObject<boolean>;
}) {
  const inherits = group !== undefined;
  const inherited = effectiveAutoReview(null, group);
  const on = inherits && !value.override ? inherited.enabled : value.on;
  // The project's active and observing commands, when it already has them.
  const store = useGuardrailsQuery(project?.id ?? "", !!project && on).data;
  const commands = (store?.entries ?? []).filter((e) => e.kind === "command" && (e.state === "active" || e.state === "observing")).map((e) => e.text);
  const set = (patch: Partial<ReviewEdit>) => onChange({ ...value, ...patch });
  const local = useRef(false);
  const asked = applied ?? local;
  useEffect(() => {
    if (!switchOn || asked.current) return;
    asked.current = true;
    if (!on) set({ override: true, on: true });
    // Once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switchOn]);
  return (
    <View style={{ gap: space[3] }}>
      {inherits && (
        <Toggle
          title={t("Override group Auto review")}
          detail={value.override ? undefined : inheritedAutoReviewText(group)}
          value={value.override}
          onChange={(override) => set(override ? { override, on: inherited.enabled, rounds: String(inherited.maxRounds) } : { override })}
        />
      )}
      {(!inherits || value.override) && (
        <Toggle title={t("Auto review")} detail={t("Every delivery runs a review and uses tokens.")} value={value.on} onChange={(next) => set({ on: next })} />
      )}
      {on && !!commands.length && (
        <Label size={font.sm} muted selectable>
          {t("Checks found: {names}", { names: commands.join(", ") })}
        </Label>
      )}
      {(!inherits || value.override) && value.on && (
        <Choices
          title={t("Max rework rounds")}
          value={value.rounds}
          options={["0", "1", "2", "3", "4", "5"].map((v) => ({ value: v, label: v }))}
          onChange={(rounds) => set({ rounds })}
        />
      )}
    </View>
  );
}
