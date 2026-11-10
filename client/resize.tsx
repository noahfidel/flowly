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
  /** The way a drag widens the panel: "left" for a panel on the grip's right (the card sidebar), "right" for one on its left. */
  grows?: "left" | "right";
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
  const current = useRef({ width, onChange, onStart, onEnd, onReset, sign: grows === "right" ? 1 : -1 });
  current.current = { width, onChange, onStart, onEnd, onReset, sign: grows === "right" ? 1 : -1 };
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
        current.current.onChange(startWidth.current + current.current.sign * g.dx),
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
      style={{
        width: touch ? 16 : 8,
        alignItems: "center",
        cursor: "col-resize",
      } as never}
    >
      <View
        style={{
          flex: 1,
          width: hovered ? 2 : 1,
          backgroundColor: hovered ? colors.foregroundMuted : colors.border,
        }}
      />
    </View>
  );
}
