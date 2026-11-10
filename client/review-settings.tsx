import { useEffect, useRef } from "react";
import { View } from "react-native";
import type { AutoReviewInput, Project } from "../shared/model";
import { useGuardrailsQuery } from "./queries";
import { Choices, Label, Toggle, font, space } from "./ui";
import { t } from "../shared/i18n";

export type ReviewEdit = { on: boolean; rounds: string };

/** phase B: `projects.update` takes `autoReview: { enabled, maxRounds }` only; this branch's input still lists `rules`. */
export const autoReviewPatch = (edit: ReviewEdit): AutoReviewInput => ({ enabled: edit.on, maxRounds: Number(edit.rounds) });

/**
 * New project / Edit project → Auto review (GUARDRAILS-SPEC §8): the switch with its cost, one line of the project's
 * check commands when it already has some, and Max rework rounds. The daemon detects the commands when the project is
 * created or saved with the switch turned on (§4.5); nothing is detected or added before Save.
 */
export function AutoReviewSection({
  project,
  value,
  onChange,
  switchOn,
}: {
  project?: Project;
  value: ReviewEdit;
  onChange(next: ReviewEdit): void;
  /** Opened from What's new: the switch starts on. */
  switchOn?: boolean;
}) {
  // The project's active and observing commands, when it already has them.
  const store = useGuardrailsQuery(project?.id ?? "", !!project && value.on).data;
  const commands = (store?.entries ?? []).filter((e) => e.kind === "command" && (e.state === "active" || e.state === "observing")).map((e) => e.text);
  const set = (patch: Partial<ReviewEdit>) => onChange({ ...value, ...patch });
  const asked = useRef(false);
  useEffect(() => {
    if (!switchOn || asked.current) return;
    asked.current = true;
    if (!value.on) set({ on: true });
    // Once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switchOn]);
  return (
    <View style={{ gap: space[3] }}>
      <Toggle title={t("Auto review")} detail={t("Every delivery runs a review and uses tokens.")} value={value.on} onChange={(on) => set({ on })} />
      {value.on && !!commands.length && (
        <Label size={font.sm} muted selectable>
          {t("Checks found: {names}", { names: commands.join(", ") })}
        </Label>
      )}
      {value.on && (
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
