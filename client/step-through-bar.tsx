import { View } from "react-native";
import { t } from "../shared/i18n";
import { IconButton, Label, font, space, useTheme } from "./ui";
import type { StepKind } from "./step-through";

type Position = { index: number | null; total: number; prev: string | null; next: string | null };

/**
 * The step-through on top of the card sidebar, one row: name, "i of N" while the card is in the queue, then ‹ › and the
 * close X (DISPATCHER-SPEC §9.4; Ruling, Noah 2026-11-22). The arrows are always there and disabled at the ends. Asks
 * are answered in the session chat or the card's banners; nothing moves by itself and the X only leaves the walk.
 */
export function StepThroughBar({
  kind,
  position,
  onPrev,
  onNext,
  onEnd,
}: {
  kind: StepKind;
  position: Position;
  onPrev(): void;
  onNext(): void;
  onEnd(): void;
}) {
  const { colors } = useTheme();
  const title = kind === "needs" ? t("Needs you") : t("Unread");
  return (
    <View style={{ flexShrink: 0, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[1], paddingLeft: space[3], paddingRight: space[2], paddingVertical: space[1.5], minWidth: 0 }}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline", gap: space[2] }}>
          <Label medium size={font.md} lines={1} selectable={false}>
            {title}
          </Label>
          {position.index !== null && (
            <Label muted size={font.sm} lines={1} selectable={false}>
              {t("{index} of {total}", { index: position.index + 1, total: position.total })}
            </Label>
          )}
        </View>
        <IconButton icon="ChevronLeft" label={t("Previous card")} disabled={!position.prev} onPress={onPrev} />
        <IconButton icon="ChevronRight" label={t("Next card")} disabled={!position.next} onPress={onNext} />
        {/* Always enabled: leaves the walk only; the card stays open and nothing is marked read or snoozed. */}
        <IconButton icon="X" label={t("Stop stepping through")} onPress={onEnd} />
      </View>
    </View>
  );
}
