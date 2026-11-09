import { Pressable } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { attentionBadgeText } from "./attention";
import { CountPill, Label, font, noFocusRing, radius, space, touch, useTheme } from "./ui";
import { t, tn } from "../shared/i18n";

/** The board's Attention button (bell, label, count); also shown in the welcome tour's Attention demo. */
export function AttentionButton({
  count,
  compact,
  open,
  shortcut,
  onPress,
}: {
  count: number;
  compact: boolean;
  /** Its dropdown is showing. */
  open: boolean;
  shortcut: string;
  onPress(): void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${count ? tn(count, "Needs attention, {n} item", "Needs attention, {n} items") : t("Needs attention")}${shortcut ? ` (${shortcut})` : ""}`}
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      style={(state) => {
        const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        const hovered = hover;
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[1.5],
          height: touch ? 44 : 32,
          minWidth: touch ? 44 : 32,
          justifyContent: "center",
          paddingHorizontal: compact ? 0 : space[2] + 2,
          borderRadius: radius.md,
          backgroundColor: open || hovered || pressed ? colors.surface2 : "transparent",
        };
      }}
    >
      <Icon name="Bell" size={15} color={count ? colors.foreground : colors.foregroundMuted} />
      {!compact && (
        <Label size={font.md} medium muted={!count} selectable={false}>
          {t("Attention")}</Label>
      )}
      {!!count && <CountPill text={attentionBadgeText(count) || ""} />}
    </Pressable>
  );
}
