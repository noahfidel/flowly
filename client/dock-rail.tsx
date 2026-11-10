import { useState } from "react";
import { Pressable, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { t, tn } from "../shared/i18n";
import { attentionBadgeText } from "./attention";
import type { DockTab } from "./dock-logic";
import { collapsedWidth } from "./geometry";
import { CountPill, Label, font, noFocusRing, radius, space, useTheme } from "./ui";

/**
 * The minimized left dock on desktop (DISPATCHER-SPEC §9.3; Ruling, Noah 2026-11-09): a narrow rail on the board's left
 * edge, drawn like a collapsed board column, with the Attention bell (and its count) and the Dispatcher button. A press
 * opens the dock on that pane; there is no width tween (opening the dock is instant).
 */
export function DockRail({ attentionCount, attentionShortcut, onOpen }: { attentionCount: number; attentionShortcut: string; onOpen(pane: DockTab): void }) {
  const { colors } = useTheme();
  const badge = attentionBadgeText(attentionCount);
  const attentionLabel = `${attentionCount ? tn(attentionCount, "Needs attention, {n} item", "Needs attention, {n} items") : t("Needs attention")}${attentionShortcut ? ` (${attentionShortcut})` : ""}`;
  return (
    // Its own column inside the board's padding, so it lines up with the lanes beside it; above them for the tooltips.
    <View style={{ paddingLeft: space[3], paddingTop: space[2], paddingBottom: space[3], flexShrink: 0, zIndex: 2 }}>
      <View
        accessibilityRole="toolbar"
        style={{ flex: 1, width: collapsedWidth, alignItems: "center", paddingTop: space[2], gap: space[1], borderRadius: radius.xl, backgroundColor: colors.surface1 }}
      >
        <RailButton icon="Bell" label={attentionLabel} tip={attentionShortcut ? `${t("Attention")} (${attentionShortcut})` : t("Attention")} highlight={!!attentionCount} badge={badge} onPress={() => onOpen("attention")} />
        <RailButton icon="Bot" label={t("Dispatcher")} tip={t("Dispatcher")} onPress={() => onOpen("dispatcher")} />
      </View>
    </View>
  );
}

/** A rail icon button: the toolbar's IconButton look, a count pill on its corner, and a hover tooltip on its right. */
function RailButton({ icon, label, tip, highlight, badge, onPress }: { icon: string; label: string; tip: string; highlight?: boolean; badge?: string | null; onPress(): void }) {
  const { colors } = useTheme();
  const [hovered, setHovered] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        hitSlop={4}
        style={(state) => ({
          ...noFocusRing,
          width: 32,
          height: 32,
          borderRadius: radius.md,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: hovered || state.pressed ? colors.surface2 : "transparent",
        })}
      >
        <Icon name={icon} size={16} color={highlight ? colors.foreground : colors.foregroundMuted} />
      </Pressable>
      {!!badge && (
        <View pointerEvents="none" style={{ position: "absolute", top: -4, right: -6 }}>
          <CountPill text={badge} />
        </View>
      )}
      {hovered && (
        // A wide box from the button's right edge, so the tip keeps one line; the tip itself fits its text.
        <View pointerEvents="none" style={{ position: "absolute", left: 32 + space[2], top: 4, width: 240, alignItems: "flex-start" }}>
          <View style={{ paddingHorizontal: space[2], height: 24, justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2 }}>
            <Label size={font.sm} lines={1} selectable={false}>
              {tip}
            </Label>
          </View>
        </View>
      )}
    </View>
  );
}
