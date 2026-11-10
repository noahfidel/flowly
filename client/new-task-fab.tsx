import { useState } from "react";
import { Animated, Pressable } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { motionDuration, useMotionValue, lerp } from "./motion";
import { noFocusRing, radius, space, useTheme } from "./ui";
import { t } from "../shared/i18n";

/** The phone board's New task button: bottom-right, opposite the Settings button (UI-UX-SPEC §5). */
export const newTaskFabSize = 52;

export function NewTaskFab({ onPress }: { onPress(): void }) {
  const { colors } = useTheme();
  const [pressed, setPressed] = useState(false);
  const shown = useMotionValue(1, motionDuration.forward, 0);
  const lift = useMotionValue(pressed ? 0.94 : 1);
  return (
    <Animated.View
      style={{
        position: "absolute",
        right: space[3],
        bottom: space[3],
        opacity: shown,
        transform: [{ translateY: lerp(shown, [8, 0]) }, { scale: lift }],
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("New task")}
        onPress={onPress}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        style={{
          ...noFocusRing,
          width: newTaskFabSize,
          height: newTaskFabSize,
          borderRadius: radius.xl,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.accent,
          shadowColor: "#000",
          shadowOpacity: 0.18,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 4 },
          elevation: 4,
        }}
      >
        <Icon name="Plus" size={22} color={colors.accentForeground} />
      </Pressable>
    </Animated.View>
  );
}
