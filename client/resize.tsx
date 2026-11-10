import { useRef, useState } from "react";
import { PanResponder, View } from "react-native";
import { touch, useTheme } from "./ui";
import { t } from "../shared/i18n";

export function ResizeGrip({
  width,
  onChange,
  maxWidth,
  minWidth = 340,
  grows = "left",
  labels,
  onStart,
  onEnd,
  onReset,
}: {
  width: number;
  onChange(width: number): void;
  maxWidth?: number;
  minWidth?: number;
  /**
   * The way a drag grows the panel: "left" for a panel on the grip's right (the card sidebar), "right" for one on its
   * left; "down" for a panel above the grip (a horizontal divider), "up" for one below it. `width` is then a height.
   */
  grows?: "left" | "right" | "up" | "down";
  /** Accessibility texts, already translated; the card sidebar's by default. */
  labels?: { drag: string; widen: string; narrow: string };
  /** Drag began / finished (released or interrupted). */
  onStart?(): void;
  onEnd?(): void;
  /** A double click (two presses without moving, within 350 ms). */
  onReset?(): void;
}) {
  const { colors } = useTheme();
  const [hovered, setHovered] = useState(false);
  const vertical = grows === "up" || grows === "down";
  const sign = grows === "right" || grows === "down" ? 1 : -1;
  const current = useRef({ width, onChange, onStart, onEnd, onReset, sign, vertical });
  current.current = { width, onChange, onStart, onEnd, onReset, sign, vertical };
  const startWidth = useRef(width);
  const lastTap = useRef(0);
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        startWidth.current = current.current.width;
        current.current.onStart?.();
      },
      onPanResponderRelease: (_e, g) => {
        current.current.onEnd?.();
        if (Math.abs(g.dx) >= 3 || Math.abs(g.dy) >= 3) return void (lastTap.current = 0);
        const now = Date.now();
        if (now - lastTap.current < 350) {
          lastTap.current = 0;
          current.current.onReset?.();
        } else lastTap.current = now;
      },
      onPanResponderTerminate: () => {
        lastTap.current = 0;
        current.current.onEnd?.();
      },
      onPanResponderMove: (_e, g) =>
        current.current.onChange(startWidth.current + current.current.sign * (current.current.vertical ? g.dy : g.dx)),
      onPanResponderTerminationRequest: () => false,
    }),
  ).current;
  return (
    <View
      {...pan.panHandlers}
      accessibilityLabel={labels?.drag ?? t("Drag to resize task details")}
      accessibilityRole="adjustable"
      accessibilityValue={{ min: minWidth, max: maxWidth, now: width }}
      accessibilityActions={[
        { name: "increment", label: labels?.widen ?? t("Widen task details") },
        { name: "decrement", label: labels?.narrow ?? t("Narrow task details") },
      ]}
      onAccessibilityAction={(event) => {
        const name = event.nativeEvent.actionName;
        if (name === "increment" || name === "decrement")
          current.current.onChange(current.current.width + (name === "increment" ? 60 : -60));
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={(vertical
        ? { height: touch ? 16 : 8, justifyContent: "center", cursor: "row-resize", flexShrink: 0 }
        : { width: touch ? 16 : 8, alignItems: "center", cursor: "col-resize" }) as never}
    >
      <View
        style={{
          ...(vertical ? { height: hovered ? 2 : 1 } : { flex: 1, width: hovered ? 2 : 1 }),
          backgroundColor: hovered ? colors.foregroundMuted : colors.border,
        }}
      />
    </View>
  );
}
