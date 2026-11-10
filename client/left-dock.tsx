import { useEffect, useState, type ReactNode } from "react";
import { Pressable, View, type GestureResponderEvent } from "react-native";
import { t } from "../shared/i18n";
import { attentionBadgeText } from "./attention";
import { dockDivider, minStackPane, splitSize, type DockLayout, type DockTab } from "./dock-logic";
import { minChatWidth } from "./geometry";
import { ResizeGrip } from "./resize";
import { CountPill, IconButton, Label, font, noFocusRing, radius, space, touch, useTheme } from "./ui";

/** The layout menu button's icon for the stored layout. */
const layoutIcons: Record<DockLayout, string> = { single: "Square", stack: "Rows2", side: "Columns2" };

/** Cmd (macOS) or Ctrl held on a press; web only, phones have no modifiers. */
function modified(event: GestureResponderEvent | undefined): boolean {
  const native = event?.nativeEvent as { metaKey?: boolean; ctrlKey?: boolean } | undefined;
  return !!(native?.metaKey || native?.ctrlKey);
}

/**
 * The left dock (DISPATCHER-SPEC §9.3; Ruling, Noah 2026-11-09): two panes, Attention and Dispatcher, in one panel
 * with one width. Single shows one pane, its header buttons acting as tabs; Stack puts Attention above the chat and
 * Side by side left of it, each with a draggable divider. Expand/Restore and Minimize (Close on phones) act on the
 * whole dock. Both panes stay mounted, a hidden one undisplayed, so the chat's draft and scroll survive.
 */
export function LeftDock({
  layout,
  storedLayout,
  tab,
  onPane,
  onLayoutMenu,
  stackShare,
  sideShare,
  onShare,
  onResizing,
  attentionCount,
  compact,
  expanded,
  onToggleSize,
  onClose,
  attention,
  dispatcher,
}: {
  /** The layout drawn (dockLayoutShown). */
  layout: DockLayout;
  /** The stored layout, for the menu button's icon. */
  storedLayout: DockLayout;
  /** Single: the pane shown; a split: the pane last used. */
  tab: DockTab;
  /** A header button pressed; `toggleSplit` when Cmd or Ctrl was held. */
  onPane(pane: DockTab, toggleSplit: boolean): void;
  /** Desktop: the layout menu, opened at the press. */
  onLayoutMenu?(event: GestureResponderEvent): void;
  /** Attention's stored share of the dock (0: half) in Stack and Side by side. */
  stackShare: number;
  sideShare: number;
  /** A divider released (or reset with 0): the share to remember. */
  onShare(layout: "stack" | "side", share: number): void;
  /** A divider drag began or ended (the board turns off text selection meanwhile). */
  onResizing?(resizing: boolean): void;
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
  const split = layout !== "single";
  // The panes' area, measured; the divider's share is kept locally while dragging and saved on release.
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [shares, setShares] = useState({ stack: stackShare, side: sideShare });
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) setShares({ stack: stackShare, side: sideShare });
  }, [stackShare, sideShare]);
  const side = layout === "side";
  const total = (side ? area.width : area.height) - dockDivider;
  const min = side ? minChatWidth : minStackPane;
  const share = side ? shares.side : shares.stack;
  const size = split && total > 0 ? splitSize(share, total, min) : 0;
  const kind = side ? "side" : "stack";
  const grip = split && size > 0 && (
    <ResizeGrip
      width={size}
      grows={side ? "right" : "down"}
      minWidth={Math.min(min, total / 2)}
      maxWidth={Math.max(total - min, total / 2)}
      labels={
        side
          ? { drag: t("Drag to resize Attention and the dispatcher chat"), widen: t("Widen Attention"), narrow: t("Narrow Attention") }
          : { drag: t("Drag to resize Attention and the dispatcher chat"), widen: t("Make Attention taller"), narrow: t("Make Attention shorter") }
      }
      onStart={() => {
        setDragging(true);
        onResizing?.(true);
      }}
      onEnd={() => {
        setDragging(false);
        onResizing?.(false);
        // Saved once, on release, never per frame; a press without a drag saves nothing.
        const next = Math.round((size / total) * 1000) / 1000;
        if (Math.abs(next - (side ? sideShare : stackShare)) > 0.001) onShare(kind, next);
      }}
      onChange={(next) => setShares((s) => ({ ...s, [kind]: splitSize(next / total, total, min) / total }))}
      onReset={() => {
        setShares((s) => ({ ...s, [kind]: 0 }));
        onShare(kind, 0);
      }}
    />
  );
  // Attention's box: its measured share in a split (an even flex until measured), the whole area in Single.
  const attentionBox = split
    ? size > 0
      ? { [side ? "width" : "height"]: size, flexShrink: 0 }
      : { flex: 1 }
    : { flex: 1, display: tab === "attention" ? ("flex" as const) : ("none" as const) };
  const dispatcherBox = split ? { flex: 1 } : { flex: 1, display: tab === "dispatcher" ? ("flex" as const) : ("none" as const) };
  return (
    <View style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: colors.surface0 }}>
      <View
        accessibilityRole={split ? undefined : "tablist"}
        style={{ flexDirection: "row", alignItems: "center", gap: space[1], paddingHorizontal: space[2], paddingVertical: space[2], borderBottomWidth: 1, borderBottomColor: colors.border, flexShrink: 0, minWidth: 0 }}
      >
        <DockTabButton
          label={badge ? t("Attention · {n}", { n: badge }) : t("Attention")}
          active={split || tab === "attention"}
          tab={!split}
          onPress={(event) => onPane("attention", modified(event))}
          trailing={badge ? <CountPill text={badge} /> : null}
          title={t("Attention")}
        />
        <DockTabButton label={t("Dispatcher")} title={t("Dispatcher")} active={split || tab === "dispatcher"} tab={!split} onPress={(event) => onPane("dispatcher", modified(event))} />
        <View style={{ flex: 1 }} />
        {!compact && onLayoutMenu ? <IconButton icon={layoutIcons[storedLayout]} label={t("Dock layout")} onPress={onLayoutMenu} /> : null}
        {!compact && onToggleSize ? (
          <IconButton icon={expanded ? "Minimize2" : "Maximize2"} label={expanded ? t("Restore size") : t("Expand")} onPress={onToggleSize} />
        ) : null}
        <IconButton icon={compact ? "X" : "PanelLeftClose"} label={compact ? t("Close") : t("Minimize")} onPress={onClose} />
      </View>
      <View
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setArea((a) => (a.width === width && a.height === height ? a : { width, height }));
        }}
        style={{ flex: 1, minHeight: 0, minWidth: 0, flexDirection: side ? "row" : "column" }}
      >
        <View style={{ minHeight: 0, minWidth: 0, ...attentionBox }}>{attention}</View>
        {grip}
        <View style={{ minHeight: 0, minWidth: 0, ...dispatcherBox }}>{dispatcher}</View>
      </View>
    </View>
  );
}

/** A dock pane button, styled as the board's project tabs (project-tabs.tsx); a tab in Single, a plain button in a split. */
function DockTabButton({ label, title, active, tab, trailing, onPress }: { label: string; title: string; active: boolean; tab: boolean; trailing?: ReactNode; onPress(event: GestureResponderEvent): void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole={tab ? "tab" : "button"}
      accessibilityLabel={label}
      accessibilityState={tab ? { selected: active } : undefined}
      {...(tab ? ({ "aria-selected": active } as object) : {})}
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
