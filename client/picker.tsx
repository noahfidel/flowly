import { useEffect, useState, type ReactNode } from "react";
import { Animated, Pressable, View } from "react-native";
import { useMotionPresence, lerp } from "./motion";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { Label, TextBox, font, radius, space, touch, useTheme, noFocusRing } from "./ui";
import { filterOptions, type PickerOption } from "./options";
import { useShortcutBlock } from "./shortcuts";
import { t } from "../shared/i18n";
export type { PickerOption } from "./options";

/** Grouped settings rows; each row shows its value and expands an inline option list. */
export function PickerGroup({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.lg,
        overflow: "hidden",
      }}
    >
      {children}
    </View>
  );
}

export function PickerRow({
  title,
  icon,
  options,
  value,
  placeholder,
  open,
  first = false,
  disabled = false,
  loading = false,
  onToggle,
  onChange,
}: {
  title: string;
  icon: string;
  options: readonly PickerOption[];
  value: string;
  placeholder: string;
  open: boolean;
  first?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onToggle(): void;
  onChange(value: string): void;
}) {
  const { colors } = useTheme();
  const selected = options.find((o) => o.value === value);
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderColor: colors.border }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${selected?.label || placeholder}`}
        accessibilityState={{ expanded: open, disabled }}
        disabled={disabled}
        onPress={onToggle}
        style={(state) => {
          const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        const hovered = hover;
          return {
            ...noFocusRing,
            flexDirection: "row",
            alignItems: "center",
            gap: space[3],
            minHeight: touch ? 52 : 44,
            paddingHorizontal: space[3],
            backgroundColor: open || hovered || pressed ? colors.surface1 : colors.surface0,
            opacity: disabled ? 0.5 : 1,
          };
        }}
      >
        <Icon name={icon} size={15} color={colors.foregroundMuted} />
        <View style={{ width: 84 }}>
          <Label muted size={font.md} selectable={false}>
            {title}
          </Label>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label medium size={font.base} lines={1} selectable={false} muted={!selected}>
            {loading ? t("Loading…") : selected?.label || placeholder}
          </Label>
        </View>
        <Icon name={open ? "ChevronUp" : "ChevronDown"} size={15} color={colors.foregroundMuted} />
      </Pressable>
      <OptionList open={open} title={title} options={options} value={value} onChange={onChange} />
    </View>
  );
}

/** Inline option list that opens under a row: animated in and out, searchable once it is long. */
export function OptionList({
  open,
  title,
  options,
  value,
  onChange,
}: {
  open: boolean;
  title: string;
  options: readonly PickerOption[];
  value: string;
  onChange(value: string): void;
}) {
  const { colors } = useTheme();
  const [query, setQuery] = useState(""),
    [searching, setSearching] = useState(false);
  useShortcutBlock(searching);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  const shown = filterOptions(options, query);
  const searchable = options.length > 8;
  const list = useMotionPresence(open ? true : undefined, open ? "list" : "");
  if (!list.item) return null;
  return (
    <Animated.View
          pointerEvents={list.active ? "auto" : "none"}
          style={{
            opacity: list.progress,
            transform: [{ translateY: lerp(list.progress, [-4, 0]) }],
            borderTopWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface1,
            padding: space[1.5],
            gap: space[1],
          }}
        >
          {searchable && (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space[2],
                paddingHorizontal: space[2] + 2,
                height: touch ? 40 : 32,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface0,
              }}
            >
              <Icon name="Search" size={14} color={colors.foregroundMuted} />
              <TextBox
                accessibilityLabel={t("Search {title}", { title })}
                value={query}
                onChangeText={setQuery}
                onFocus={() => setSearching(true)}
                onBlur={() => setSearching(false)}
                placeholder={t("Search {title}", { title })}
                autoCorrect={false}
                autoCapitalize="none"
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: "100%",
                  fontSize: font.md,
                  color: colors.foreground,
                  outlineStyle: "none",
                } as never}
              />
            </View>
          )}
          <ScrollView
            style={{ maxHeight: 264 }}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: 1 }}
          >
            {shown.map((option) => {
              const active = option.value === value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="button"
                  accessibilityLabel={`${title}: ${option.label}`}
                  accessibilityState={{ selected: active, disabled: !!option.disabled }}
                  disabled={option.disabled}
                  onPress={() => onChange(option.value)}
                  style={(state) => {
                    const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        const hovered = hover;
                    return {
                      ...noFocusRing,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: space[2],
                      minHeight: touch ? 48 : option.detail ? 44 : 34,
                      paddingHorizontal: space[2] + 2,
                      paddingVertical: space[1],
                      borderRadius: radius.md,
                      backgroundColor: active
                        ? colors.surface0
                        : hovered || pressed
                          ? colors.surface2
                          : "transparent",
                      opacity: option.disabled ? 0.45 : 1,
                    };
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
                      <View style={{ flexShrink: 1, minWidth: 0 }}>
                        <Label size={font.md} medium={active} lines={1} selectable={false}>
                          {option.label}
                        </Label>
                      </View>
                      {!!option.badge && (
                        <Label muted size={font.xs} selectable={false}>
                          {option.badge}
                        </Label>
                      )}
                    </View>
                    {!!option.detail && (
                      <Label muted size={font.sm} lines={1} selectable={false}>
                        {option.detail}
                      </Label>
                    )}
                  </View>
                  {active && <Icon name="Check" size={15} color={colors.accent} />}
                </Pressable>
              );
            })}
            {!shown.length && (
              <View style={{ padding: space[3] }}>
                <Label muted size={font.md}>
                  {options.length ? t("No matches.") : t("Nothing available.")}
                </Label>
              </View>
            )}
          </ScrollView>
        </Animated.View>
  );
}
