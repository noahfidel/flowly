import type { ReactNode } from "react";
import { View } from "react-native";
import { t } from "../shared/i18n";
import { IconButton, Label, font, space, useTheme } from "./ui";

/**
 * The left dock (DISPATCHER-SPEC §9.3; Ruling, Noah 2026-11-09): the dispatcher chat only. Its header has the title,
 * Expand/Restore and Minimize (Close on phones); the chat stays mounted while minimized so its draft and scroll survive.
 */
export function LeftDock({ compact, expanded, onToggleSize, onClose, children }: { compact: boolean; expanded: boolean; onToggleSize?(): void; onClose(): void; children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: colors.surface0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[1], paddingLeft: space[3], paddingRight: space[2], paddingVertical: space[2], borderBottomWidth: 1, borderBottomColor: colors.border, flexShrink: 0, minWidth: 0 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label lines={1} selectable={false} size={font.md} medium>
            {t("Dispatcher")}
          </Label>
        </View>
        {!compact && onToggleSize ? (
          <IconButton icon={expanded ? "Minimize2" : "Maximize2"} label={expanded ? t("Restore size") : t("Expand")} onPress={onToggleSize} />
        ) : null}
        <IconButton icon={compact ? "X" : "PanelLeftClose"} label={compact ? t("Close") : t("Minimize")} onPress={onClose} />
      </View>
      <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>{children}</View>
    </View>
  );
}
