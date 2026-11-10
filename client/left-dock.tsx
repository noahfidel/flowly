import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { t } from "../shared/i18n";
import { attentionBadgeText } from "./attention";
import type { DockTab } from "./dock-logic";
import { CountPill, IconButton, Label, font, noFocusRing, radius, space, touch, useTheme } from "./ui";

/**
 * The left dock (DISPATCHER-SPEC §9.3; Ruling, Noah 2026-11-09): two tabs, Attention and Dispatcher, over one panel
 * with one width; Expand/Restore and Minimize (Close on phones) act on the dock whichever tab shows. Both tabs stay
 * mounted, the hidden one undisplayed, so the chat's draft and scroll survive a switch.
 */
export function LeftDock({
  tab,
  onTab,
  attentionCount,
  compact,
  expanded,
  onToggleSize,
  onClose,
  attention,
  dispatcher,
}: {
  tab: DockTab;
  onTab(tab: DockTab): void;
  /** The bell's count (open asks); updates never count. */
  attentionCount: number;
  compact: boolean;
  expanded: boolean;
  onToggleSize?(): void;
  onClose(): void;
  attention: ReactNode;
  dispatcher: ReactNode;
}) {
  const { colors } = useTheme();
  const badge = attentionBadgeText(attentionCount);
  return (
    <View style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: colors.surface0 }}>
      <View
        accessibilityRole="tablist"
        style={{ flexDirection: "row", alignItems: "center", gap: space[1], paddingHorizontal: space[2], paddingVertical: space[2], borderBottomWidth: 1, borderBottomColor: colors.border, flexShrink: 0, minWidth: 0 }}
      >
        <DockTabButton
          label={badge ? t("Attention · {n}", { n: badge }) : t("Attention")}
          active={tab === "attention"}
          onPress={() => onTab("attention")}
          trailing={badge ? <CountPill text={badge} /> : null}
          title={t("Attention")}
        />
        <DockTabButton label={t("Dispatcher")} title={t("Dispatcher")} active={tab === "dispatcher"} onPress={() => onTab("dispatcher")} />
        <View style={{ flex: 1 }} />
        {!compact && onToggleSize ? (
          <IconButton icon={expanded ? "Minimize2" : "Maximize2"} label={expanded ? t("Restore size") : t("Expand")} onPress={onToggleSize} />
        ) : null}
        <IconButton icon={compact ? "X" : "PanelLeftClose"} label={compact ? t("Close") : t("Minimize")} onPress={onClose} />
      </View>
      <View style={{ flex: 1, minHeight: 0, minWidth: 0, display: tab === "attention" ? "flex" : "none" }}>{attention}</View>
      <View style={{ flex: 1, minHeight: 0, minWidth: 0, display: tab === "dispatcher" ? "flex" : "none" }}>{dispatcher}</View>
    </View>
  );
}

/** A dock tab, styled as the board's project tabs (project-tabs.tsx). */
function DockTabButton({ label, title, active, trailing, onPress }: { label: string; title: string; active: boolean; trailing?: ReactNode; onPress(): void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      {...({ "aria-selected": active } as object)}
      onPress={onPress}
      style={(state) => {
        const { pressed, hovered } = state as typeof state & { hovered?: boolean };
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[1.5],
          height: touch ? 36 : 30,
          flexShrink: 1,
          minWidth: 0,
          paddingHorizontal: space[2] + 2,
          borderRadius: radius.md,
          backgroundColor: active ? colors.surface2 : hovered || pressed ? colors.surface1 : "transparent",
        };
      }}
    >
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Label lines={1} selectable={false} size={font.md} medium color={active ? colors.foreground : colors.foregroundMuted}>
          {title}
        </Label>
      </View>
      {trailing}
    </Pressable>
  );
}
