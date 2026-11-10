import { useState } from "react";
import { Pressable, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { t } from "../shared/i18n";
import { collapsedWidth } from "./geometry";
import { Label, font, noFocusRing, radius, space, useTheme } from "./ui";

/**
 * The minimized left dock on desktop (DISPATCHER-SPEC §9.3; Ruling, Noah 2026-11-09): a narrow rail on the board's left
 * edge, drawn like a collapsed board column, with the Dispatcher button. A press opens the dock; there is no width
 * tween (opening the dock is instant).
 */
export function DockRail({ onOpen }: { onOpen(): void }) {
  const { colors } = useTheme();
  const [hovered, setHovered] = useState(false);
  return (
    // Its own column inside the board's padding, so it lines up with the lanes beside it; above them for the tooltip.
    <View style={{ paddingLeft: space[3], paddingTop: space[2], paddingBottom: space[3], flexShrink: 0, zIndex: 2 }}>
      <View style={{ flex: 1, width: collapsedWidth, alignItems: "center", paddingTop: space[2], borderRadius: radius.xl, backgroundColor: colors.surface1 }}>
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Open the dispatcher chat")}
            onPress={onOpen}
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
            <Icon name="Bot" size={16} color={colors.foregroundMuted} />
          </Pressable>
          {hovered && (
            // A wide box from the button's right edge, so the tip keeps one line; the tip itself fits its text.
            <View pointerEvents="none" style={{ position: "absolute", left: 32 + space[2], top: 4, width: 240, alignItems: "flex-start" }}>
              <View style={{ paddingHorizontal: space[2], height: 24, justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2 }}>
                <Label size={font.sm} lines={1} selectable={false}>
                  {t("Dispatcher")}
                </Label>
              </View>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}
