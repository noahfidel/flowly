import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, ScrollView, View, useWindowDimensions, type GestureResponderEvent } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Modal, useAfterModalClose } from "./modal";
import { Label, Row, Theme, font, noFocusRing, radius, space, touch, useTheme } from "./ui";
import { useMotionPresence, lerp } from "./motion";
import { menuHeight, placeMenu } from "./menu-placement";
import { BACK, drillIn, escapeStep, freshTrail, stepBack, visibleEntries, type Submenu } from "./menu-trail";
import { t } from "../shared/i18n";

export type MenuEntry =
  | { kind?: "item"; id: string; label: string; icon?: string; leading?: ReactNode; danger?: boolean; checked?: boolean; disabled?: boolean; onPress(): void }
  | { kind: "separator"; id: string }
  | { kind: "label"; id: string; label: string }
  /** Drills into `entries` in the same popover or sheet, with a Back row on top. */
  | { kind: "submenu"; id: string; label: string; icon?: string; disabled?: boolean; entries: MenuEntry[] };

/** `node`: set when the press carried no coordinates (the keyboard); the menu then opens below that element. */
export type Point = { x: number; y: number; node?: unknown };
type Measurable = { measureInWindow?(callback: (x: number, y: number, width: number, height: number) => void): void };
type Opener = (at: Point, title: string, entries: MenuEntry[]) => void;
const Context = createContext<Opener | null>(null);

/** Position of a press/right-click, in window coordinates. */
export function eventPoint(event: GestureResponderEvent | { nativeEvent: { pageX?: number; pageY?: number } }): Point {
  const n = (event.nativeEvent ?? {}) as { pageX?: number; pageY?: number };
  if (typeof n.pageX === "number" && typeof n.pageY === "number") return { x: n.pageX, y: n.pageY };
  const e = event as { currentTarget?: unknown; target?: unknown };
  const node = [e.currentTarget, e.target].find((c) => typeof (c as Measurable | undefined)?.measureInWindow === "function");
  return { x: n.pageX ?? 0, y: n.pageY ?? 0, node };
}

type Control = {
  /** Steps back out of a submenu or closes the menu; true when it did. */
  escape(): boolean;
  /** Read at event time (no re-render). */
  isOpen(): boolean;
  /** Calls back on every open and close, without rendering anything. */
  subscribe(listener: (open: boolean) => void): () => void;
};
const ControlContext = createContext<Control>({ escape: () => false, isOpen: () => false, subscribe: () => () => {} });

/** The menu's stable control: its value never changes, so opening or closing a menu re-renders no consumer (PERFORMANCE-SPEC §3). */
export function useMenuControl() {
  return useContext(ControlContext);
}

/** Runs `listener` whenever a menu opens or closes; it never re-renders the caller. */
export function useOnMenuChange(listener: (open: boolean) => void) {
  const { subscribe } = useMenuControl();
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => subscribe((open) => latest.current(open)), [subscribe]);
}

/** The board's menu opener (null outside a ContextMenuProvider). */
export function useMenuOpener() {
  return useContext(Context);
}

/**
 * Plugin context menus: right-click on desktop web, long-press on touch.
 * Spread the result onto a Pressable. The browser's own menu is suppressed.
 */
export function menuHandlers(open: Opener | null, title: string, entries: () => MenuEntry[]): object {
  if (!open) return {};
  const show = (event: GestureResponderEvent) => open(eventPoint(event), title, entries());
  return {
    onLongPress: show,
    onContextMenu: (event: GestureResponderEvent & { preventDefault?(): void; stopPropagation?(): void }) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      show(event);
    },
  };
}

/**
 * Board-level suppression of the browser context menu. Editable fields keep
 * their native menu (copy/paste); everything else gets plugin menus or none.
 */
export function suppressNativeMenu(event: { preventDefault?(): void; nativeEvent?: { target?: unknown } }) {
  const target = event.nativeEvent?.target as { tagName?: string; isContentEditable?: boolean } | undefined;
  if (target?.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target?.tagName || "")) return;
  event.preventDefault?.();
}

export function ContextMenuProvider({ compact, children }: { compact: boolean; children: ReactNode }) {
  const theme = useTheme();
  const { colors } = theme;
  const root = useRef<View>(null);
  const [menu, setMenu] = useState<{ at: Point; title: string; entries: MenuEntry[]; key: number } | null>(null);
  // Opened submenus, outermost first; reset on every open.
  const [trail, setTrail] = useState<Submenu[]>([]);
  // Null until measured: a popover never renders against an unknown box (a 0-height first frame).
  const [origin, setOrigin] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  // The popover's real content height for the view it was measured in.
  const [measured, setMeasured] = useState({ view: "", height: 0 });
  const seq = useRef(0);
  const presence = useMotionPresence(menu, menu ? String(menu.key) : "");
  const dims = useWindowDimensions();
  const windowRef = useRef(dims);
  windowRef.current = dims;
  // Stable: it is the context value, and a new one would re-render every
  // consumer (the whole board) on each menu open/close (PERFORMANCE-SPEC §3).
  const compactRef = useRef(compact);
  compactRef.current = compact;
  const open = useCallback<Opener>((at, title, entries) => {
    const key = ++seq.current;
    const show = (where: Point) => {
      if (seq.current !== key) return;
      setTrail(freshTrail());
      setMenu({ at: where, title, entries, key });
    };
    // Phones show a bottom sheet: no anchoring geometry needed.
    if (!compactRef.current) {
      setOrigin(null);
      const fallback = () => setOrigin((current) => current ?? { x: 0, y: 0, width: windowRef.current.width, height: windowRef.current.height });
      try {
        if (typeof root.current?.measureInWindow === "function")
          root.current.measureInWindow((x, y, width, height) => setOrigin({ x, y, width, height }));
        else fallback();
      } catch {
        fallback();
      }
    }
    // A keyboard press has no pointer position: anchor below the pressed element.
    const node = at.node as Measurable | undefined;
    if (node?.measureInWindow) {
      try {
        node.measureInWindow((x, y, _width, height) => show({ x, y: y + height }));
        return;
      } catch {
        // fall through to the plain point
      }
    }
    show(at);
  }, []);
  const close = () => setMenu(null);
  const afterClose = useAfterModalClose();
  const latest = useRef({ menu, trail });
  latest.current = { menu, trail };
  const escape = useCallback(() => {
    if (!latest.current.menu) return false;
    const step = escapeStep(latest.current.trail);
    if (step.close) setMenu(null);
    else setTrail(step.trail);
    return true;
  }, []);
  const openRef = useRef(false);
  const listeners = useRef(new Set<(open: boolean) => void>());
  const isOpen = menu !== null;
  useEffect(() => {
    openRef.current = isOpen;
    listeners.current.forEach((listener) => listener(isOpen));
  }, [isOpen]);
  const control = useMemo<Control>(
    () => ({
      escape,
      isOpen: () => openRef.current,
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => void listeners.current.delete(listener);
      },
    }),
    [escape],
  );
  const run = (entry: MenuEntry) => {
    if (entry.kind === "separator" || entry.kind === "label") return;
    if (entry.kind === "submenu") return setTrail((current) => drillIn(current, entry));
    if (entry.id === BACK) return setTrail(stepBack);
    close();
    // Phones show the menu in a Modal; what the entry opens (a dialog, a card) waits for it to close.
    if (compactRef.current) afterClose(entry.onPress);
    else entry.onPress();
  };
  const shown = presence.item;
  const width = 232;
  const entries = shown ? visibleEntries(shown.entries, trail) : [];
  // Keyed by view (and its size) so a measurement is never applied to a different view.
  const view = shown ? `${shown.key}/${trail.length}/${entries.length}` : "";
  const placed = origin
    ? placeMenu({
        at: shown?.at ?? { x: 0, y: 0 },
        origin,
        width,
        height: measured.view === view ? measured.height + 10 : menuHeight(entries, touch),
        margin: 4,
      })
    : null;
  const trailing = (entry: MenuEntry) =>
    entry.kind === "submenu" ? <Icon name="ChevronRight" size={14} color={colors.foregroundMuted} /> : null;
  return (
    <ControlContext.Provider value={control}>
    <Context.Provider value={open}>
      <View ref={root} style={{ flex: 1, minHeight: 0 }}>
        {children}
        {!compact && shown && placed && (
          <>
            {/* Only an open menu catches outside clicks; a closing one never swallows the next click. */}
            {presence.active && <Pressable
              accessibilityLabel={t("Close menu")}
              onPress={close}
              {...({ onContextMenu: (e: { preventDefault?(): void }) => { e.preventDefault?.(); close(); } } as object)}
              style={{ ...noFocusRing, position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 200 }}
            />}
            <Animated.View
              accessibilityRole="menu"
              pointerEvents={presence.active ? "auto" : "none"}
              style={{
                position: "absolute",
                zIndex: 201,
                left: placed.left,
                top: placed.top,
                width,
                maxHeight: placed.maxHeight,
                padding: 4,
                borderRadius: radius.lg,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface0,
                shadowColor: "#000",
                shadowOpacity: 0.14,
                shadowRadius: 18,
                shadowOffset: { width: 0, height: 8 },
                opacity: presence.progress,
                transform: [{ scale: lerp(presence.progress, [0.97, 1]) }],
              }}
            >
              {/* Never cut off: a menu taller than the board scrolls inside its maximum height. */}
              <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} showsVerticalScrollIndicator={false}>
                <View onLayout={(e) => setMeasured({ view, height: e.nativeEvent.layout.height })}>
                  {entries.map((entry) =>
                    entry.kind === "separator" ? (
                      <View key={entry.id} style={{ height: 1, marginVertical: 4, backgroundColor: colors.border }} />
                    ) : entry.kind === "label" ? (
                      <View key={entry.id} style={{ paddingHorizontal: space[2] + 2, paddingTop: 4, paddingBottom: 2 }}>
                        <Label muted size={font.xs} selectable={false}>{entry.label}</Label>
                      </View>
                    ) : (
                      <Pressable
                        key={entry.id}
                        accessibilityRole="menuitem"
                        accessibilityLabel={entry.label}
                        disabled={entry.disabled}
                        onPress={() => run(entry)}
                        style={(state) => {
                          const { pressed, hovered: hover } = state as typeof state & { hovered?: boolean };
                          return {
                            ...noFocusRing,
                            flexDirection: "row",
                            alignItems: "center",
                            gap: space[2],
                            height: touch ? 40 : 30,
                            paddingHorizontal: space[2] + 2,
                            borderRadius: radius.md,
                            backgroundColor: hover || pressed ? colors.surface2 : "transparent",
                            opacity: entry.disabled ? 0.4 : 1,
                          };
                        }}
                      >
                        <View style={{ width: 16, alignItems: "center" }}>
                          {entry.kind !== "submenu" && entry.leading ? entry.leading : entry.icon ? (
                            <Icon name={entry.icon} size={14} color={entry.kind !== "submenu" && entry.danger ? colors.statusDanger : colors.foregroundMuted} />
                          ) : null}
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Label size={font.md} lines={1} color={entry.kind !== "submenu" && entry.danger ? colors.statusDanger : undefined} selectable={false}>
                            {entry.label}
                          </Label>
                        </View>
                        {entry.kind !== "submenu" && entry.checked && <Icon name="Check" size={14} color={colors.accent} />}
                        {trailing(entry)}
                      </Pressable>
                    ),
                  )}
                </View>
              </ScrollView>
            </Animated.View>
          </>
        )}
      </View>
      {compact && (
        <Modal open={!!menu} title={menu?.title || t("Actions")} onOpenChange={(next) => !next && close()}>
          <Modal.Content contentContainerStyle={{ padding: space[3], gap: space[1] }}>
            <Theme.Provider value={theme}>
              {entries.map((entry) =>
                entry.kind === "separator" ? (
                  <View key={entry.id} style={{ height: 1, marginVertical: space[1], backgroundColor: colors.border }} />
                ) : entry.kind === "label" ? (
                  <View key={entry.id} style={{ paddingHorizontal: space[3], paddingTop: space[1] }}>
                    <Label medium muted size={font.sm} selectable={false}>{entry.label}</Label>
                  </View>
                ) : (
                  <Row
                    key={entry.id}
                    title={entry.label}
                    icon={entry.kind !== "submenu" && entry.leading ? undefined : entry.icon}
                    leading={entry.kind !== "submenu" ? entry.leading : undefined}
                    iconColor={entry.kind !== "submenu" && entry.danger ? colors.statusDanger : undefined}
                    selected={entry.kind !== "submenu" && entry.checked}
                    trailing={trailing(entry)}
                    disabled={entry.disabled}
                    onPress={() => run(entry)}
                  />
                ),
              )}
            </Theme.Provider>
          </Modal.Content>
        </Modal>
      )}
    </Context.Provider>
    </ControlContext.Provider>
  );
}
