import { useEffect, useRef } from "react";
import { Pressable, View, type ScrollView as RNScrollView } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import type { Group } from "../shared/model";
import { menuHandlers, useMenuOpener, type MenuEntry } from "./context-menu";
import { SortableList } from "./sortable-list";
import { IconButton, Label, font, noFocusRing, radius, space, useTheme } from "./ui";
import { t } from "../shared/i18n";

/**
 * Desktop group tabs (BOARD-GROUPS-SPEC §3): one tab per group, one click opens its board; the trailing
 * buttons create a project in the current group or open the group switcher. Right-click (long-press on
 * touch) a tab for that group's actions; drag a tab with the mouse to reorder.
 */
export function GroupTabs({
  groups,
  activeId,
  shortcut,
  onSelect,
  onManage,
  onCreate,
  menuFor,
  onMove,
  reorderDisabled,
}: {
  /** In position order. */
  groups: readonly Group[];
  activeId: string;
  shortcut: string;
  onSelect(id: string): void;
  onManage(): void;
  onCreate(): void;
  /** Context menu entries for one tab's group. */
  menuFor(group: Group, index: number): MenuEntry[];
  /** Drop a dragged tab at `to`, an index in `groups`. */
  onMove(id: string, to: number): void;
  reorderDisabled: boolean;
}) {
  const openMenu = useMenuOpener();
  const scroll = useRef<RNScrollView>(null);
  const offsets = useRef(new Map<string, { x: number; width: number }>());
  const viewport = useRef({ x: 0, width: 0 });
  // Keep the active tab in view when it changes from elsewhere (switcher, linked session).
  const reveal = (id: string) => {
    const tab = offsets.current.get(id),
      view = viewport.current;
    if (!tab || !view.width) return;
    if (tab.x < view.x) scroll.current?.scrollTo({ x: tab.x, animated: true });
    else if (tab.x + tab.width > view.x + view.width)
      scroll.current?.scrollTo({ x: tab.x + tab.width - view.width, animated: true });
  };
  useEffect(() => reveal(activeId), [activeId]);
  return (
    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space[1] }}>
      <ScrollView
        ref={scroll as never}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 1, minWidth: 0 }}
        contentContainerStyle={{ flexDirection: "row", alignItems: "center", gap: 2 }}
        scrollEventThrottle={64}
        onScroll={(e) => (viewport.current.x = e.nativeEvent.contentOffset.x)}
        onLayout={(e) => (viewport.current.width = e.nativeEvent.layout.width)}
      >
        <SortableList
          horizontal
          items={groups}
          gap={2}
          disabled={reorderDisabled}
          onMove={onMove}
          onItemLayout={(id, x, width) => {
            offsets.current.set(id, { x, width });
            if (id === activeId) reveal(id);
          }}
          renderItem={(g, index, pressable) => (
            <Tab
              title={g.name}
              label={t("Group {name}", { name: g.name })}
              active={g.id === activeId}
              menu={menuHandlers(openMenu, g.name, () => menuFor(g, index))}
              // The release that ends a drag is not a click.
              onPress={() => pressable() && onSelect(g.id)}
            />
          )}
        />
      </ScrollView>
      <IconButton icon="Plus" label={t("New project")} onPress={onCreate} />
      <IconButton
        icon="ChevronsUpDown"
        label={`${t("Manage groups")}${shortcut ? ` (${shortcut})` : ""}`}
        onPress={onManage}
      />
    </View>
  );
}

function Tab({
  title,
  label,
  active,
  menu,
  onPress,
}: {
  title: string;
  label: string;
  active: boolean;
  menu: object;
  onPress(): void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      {...({ "aria-selected": active } as object)}
      {...menu}
      onPress={onPress}
      style={(state) => {
        const { pressed, hovered: hover } = state as typeof state & { hovered?: boolean; focused?: boolean };
        const hovered = hover;
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[1.5],
          height: 30,
          maxWidth: 220,
          paddingHorizontal: space[2] + 2,
          borderRadius: radius.md,
          // Same weight for every tab so switching never shifts its neighbours.
          backgroundColor: active ? colors.surface2 : hovered || pressed ? colors.surface1 : "transparent",
        };
      }}
    >
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Label
          lines={1}
          selectable={false}
          size={font.md}
          medium
          color={active ? colors.foreground : colors.foregroundMuted}
        >
          {title}
        </Label>
      </View>
    </Pressable>
  );
}
