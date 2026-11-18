/*
 * The Gallery viewer (EVIDENCE-GALLERY-SPEC §2.2), ported from paseo-image-gallery
 * (github.com/mordol/paseo-image-gallery, client/viewer.tsx). Full size (fit to the window, never enlarged),
 * next/previous across the card's gallery, arrow keys and Esc on web, the file name and path. No zoom (§2.2).
 *
 * Portions copyright (c) 2026 Taegyu Ryu. MIT License:
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
 * to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions
 * of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
 * TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Image, Modal, Platform, Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { t } from "../shared/i18n";
import type { GalleryImage } from "../shared/gallery";
import { stepGallery } from "./gallery-logic";
import { useGalleryImage } from "./gallery-image";
import { hasWindowButtons, onKeyDown } from "./gallery-web";
import { useShortcutBlock } from "./shortcuts";
import { font, message, noFocusRing, radius, space, touch } from "./ui";

type Zone = "top" | "bottom" | "left" | "right";
/** One viewer entry: the image and the path shown for it. */
export type ViewerItem = { image: GalleryImage; path: string };

const EDGE = 96;
const BAR = 72;
const HIDE_DELAY_MS = 250;
/** Room for the macOS window buttons, which sit over the top-left corner of a full-window modal. */
const WINDOW_BUTTONS_INSET = 80;

/**
 * Hover tracking for one zone. The zone and every button inside it report hover separately,
 * because moving onto a child button can end the zone's own hover.
 */
const HoverContext = createContext<{ enter: (id: string) => void; leave: (id: string) => void } | null>(null);

/** Pressable hover props that keep the surrounding zone revealed. */
function useZoneHover(id: string) {
  const hover = useContext(HoverContext);
  return hover ? { onHoverIn: () => hover.enter(id), onHoverOut: () => hover.leave(id) } : {};
}

function ToolButton({ icon, label, theme, compact, onPress }: { icon: string; label: string; theme: PluginTheme; compact: boolean; onPress: () => void }) {
  const hover = useZoneHover(`button:${label}`);
  return (
    <Pressable
      {...hover}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        ...noFocusRing,
        flexDirection: "row",
        alignItems: "center",
        gap: space[1.5],
        paddingVertical: space[1.5],
        paddingHorizontal: 10,
        borderRadius: radius.lg,
        backgroundColor: theme.colors.surface2,
      }}
    >
      <Icon name={icon} size={16} color={theme.colors.foreground} />
      {!compact ? <Text style={{ color: theme.colors.foreground, fontSize: font.md }}>{label}</Text> : null}
    </Pressable>
  );
}

function NavButton({ side, enabled, theme, onPress }: { side: "left" | "right"; enabled: boolean; theme: PluginTheme; onPress: () => void }) {
  const hover = useZoneHover("nav");
  return (
    <Pressable
      {...hover}
      accessibilityRole="button"
      accessibilityLabel={side === "left" ? t("Previous image") : t("Next image")}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      onPress={onPress}
      style={{
        ...noFocusRing,
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
        opacity: enabled ? 1 : 0.3,
      }}
    >
      <Icon name={side === "left" ? "ChevronLeft" : "ChevronRight"} size={22} color={theme.colors.foreground} />
    </Pressable>
  );
}

/** A region that reveals its controls while hovered (web) or while controls are pinned by a tap. */
function HoverZone({
  zone,
  style,
  visible,
  hoverable,
  onHover,
  children,
}: {
  zone: Zone;
  style: object;
  visible: boolean;
  hoverable: boolean;
  onHover: (id: string, zone: Zone, hovered: boolean) => void;
  children: ReactNode;
}) {
  const context = useMemo(
    () => ({
      enter: (id: string) => onHover(`${zone}:${id}`, zone, true),
      leave: (id: string) => onHover(`${zone}:${id}`, zone, false),
    }),
    [onHover, zone],
  );
  const content = (
    <View style={{ flex: 1, opacity: visible ? 1 : 0 }} pointerEvents={visible ? "box-none" : "none"}>
      {children}
    </View>
  );
  if (!hoverable) {
    return (
      <View style={[{ position: "absolute" }, style]} pointerEvents="box-none">
        {content}
      </View>
    );
  }
  return (
    <Pressable accessible={false} onHoverIn={() => context.enter("zone")} onHoverOut={() => context.leave("zone")} style={[{ position: "absolute", ...noFocusRing }, style]}>
      <HoverContext.Provider value={context}>{content}</HoverContext.Provider>
    </Pressable>
  );
}

export function GalleryViewer({
  items,
  index,
  theme,
  reduced,
  onIndexChange,
  onClose,
}: {
  items: readonly ViewerItem[];
  index: number;
  theme: PluginTheme;
  /** System Reduce Motion: the viewer opens and closes without a fade. */
  reduced: boolean;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const item = items[index];
  // Board shortcuts (j/k, Shift+H/L, e, Esc…) stay off while the viewer is open, like any plugin modal: the board's
  // key handler then neither acts on nor stops Esc and the arrows, so they reach the viewer's own listener below.
  useShortcutBlock(true);
  const { uri, error } = useGalleryImage(item.image, "full", true);
  const hoverable = Platform.OS === "web";
  const compact = touch;

  const [hovered, setHovered] = useState<Zone | null>(null);
  // Every hovered zone or button, keyed by id. Controls hide only after all of them are left.
  const hoverSources = useRef(new Map<string, Zone>());
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onHover = useCallback((id: string, zone: Zone, isHovered: boolean) => {
    if (isHovered) hoverSources.current.set(id, zone);
    else hoverSources.current.delete(id);
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    const active = [...hoverSources.current.values()].at(-1);
    if (active) setHovered(active);
    else hideTimer.current = setTimeout(() => setHovered(null), HIDE_DELAY_MS);
  }, []);
  useEffect(
    () => () => {
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    },
    [],
  );
  const [pinned, setPinned] = useState(!hoverable);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    setNatural(null);
    if (!uri) return;
    let current = true;
    Image.getSize(uri, (width, height) => current && setNatural({ width, height }));
    return () => {
      current = false;
    };
  }, [uri]);

  const hasPrevious = index > 0;
  const hasNext = index < items.length - 1;

  // Full size, shrunk to fit the window; small images are never enlarged.
  const fit = natural && viewport.width > 0 ? Math.min(viewport.width / natural.width, viewport.height / natural.height) : 1;
  const scale = Math.min(1, fit);
  const displayed = natural ? { width: natural.width * scale, height: natural.height * scale } : { width: 0, height: 0 };

  const go = (delta: number) => {
    const next = stepGallery(index, delta, items.length);
    if (next !== index) onIndexChange(next);
  };
  const latestNav = useRef({ go, onClose });
  latestNav.current = { go, onClose };
  useEffect(
    () =>
      onKeyDown((key) => {
        const nav = latestNav.current;
        if (key === "ArrowLeft") nav.go(-1);
        else if (key === "ArrowRight") nav.go(1);
        else if (key === "Escape") nav.onClose();
        else return false;
        return true;
      }),
    [],
  );

  const show = (zone: Zone) => pinned || hovered === zone;
  const bar = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space[2],
    paddingHorizontal: compact ? space[3] : space[5],
    paddingVertical: 10,
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
  };
  const muted = { color: theme.colors.foregroundMuted, fontSize: font.sm };
  return (
    <Modal visible transparent animationType={reduced ? "none" : "fade"} onRequestClose={onClose}>
      <View
        style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setViewport({ width, height });
        }}
      >
        {/* A tap toggles the controls, which is how touch devices reveal them. */}
        <Pressable accessible={false} style={{ flex: 1, overflow: "hidden", ...noFocusRing }} onPress={() => setPinned((value) => !value)}>
          {uri && natural ? (
            <Image
              source={{ uri }}
              accessibilityLabel={item.image.name}
              style={{
                position: "absolute",
                width: displayed.width,
                height: displayed.height,
                left: (viewport.width - displayed.width) / 2,
                top: (viewport.height - displayed.height) / 2,
              }}
              resizeMode="stretch"
            />
          ) : (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space[4] }}>
              {error ? <Text style={{ color: theme.colors.statusDanger }}>{message(error)}</Text> : <ActivityIndicator color={theme.colors.foregroundMuted} />}
            </View>
          )}
        </Pressable>

        <HoverZone zone="top" style={{ top: 0, left: 0, right: 0, height: BAR }} visible={show("top")} hoverable={hoverable} onHover={onHover}>
          <View style={[bar, { borderBottomWidth: 1 }, hasWindowButtons() ? { paddingLeft: WINDOW_BUTTONS_INSET } : null]}>
            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: font.base }}>
              {item.image.name}
            </Text>
            <Text style={muted}>
              {index + 1} / {items.length}
            </Text>
            <ToolButton icon="X" label={t("Close")} compact={compact} theme={theme} onPress={onClose} />
          </View>
        </HoverZone>

        <HoverZone zone="bottom" style={{ bottom: 0, left: 0, right: 0, height: BAR }} visible={show("bottom")} hoverable={hoverable} onHover={onHover}>
          <View style={[bar, { flex: 1, borderTopWidth: 1, flexDirection: "column", alignItems: "flex-start", justifyContent: "center", gap: 2 }]}>
            <Text selectable numberOfLines={1} style={muted}>
              {item.path}
            </Text>
          </View>
        </HoverZone>

        {(["left", "right"] as const).map((side) => (
          <HoverZone
            key={side}
            zone={side}
            style={{ [side]: 0, top: "30%", height: "40%", width: EDGE }}
            visible={show(side)}
            hoverable={hoverable}
            onHover={onHover}
          >
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }} pointerEvents="box-none">
              <NavButton side={side} enabled={side === "left" ? hasPrevious : hasNext} theme={theme} onPress={() => go(side === "left" ? -1 : 1)} />
            </View>
          </HoverZone>
        ))}
      </View>
    </Modal>
  );
}
