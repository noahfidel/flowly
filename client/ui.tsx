import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  Animated,
  Platform,
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { motionDuration, useMotionValue, lerp } from "./motion";
import { useShortcutBlock } from "./shortcuts";
import { composerEnterAction, type ComposerKey } from "./session-input";
import { formatLocale, t } from "../shared/i18n";

/** Host Paseo scale (0.11.2): 4pt grid, 12–18 type, 4–12 radii. */
export const space = { 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24 } as const;
export const radius = { sm: 4, md: 6, lg: 8, xl: 12, full: 999 } as const;
export const font = { xs: 11, sm: 12, md: 13, base: 14, lg: 16, xl: 18 } as const;
export const touch = Platform.OS !== "web";
const control = touch ? 44 : 32;
/** Height of the "← Board" bar of the Ideas, Memory and Insights pages: the same as the session preview header beside it (8 padding + a two-line title of 37 px or a control, whichever is taller, + 8 padding + 1 border), so both bottom borders line up. */
export const pageBarHeight = 2 * space[2] + Math.max(control, 37) + 1;
const smallControl = touch ? 32 : 28;

/**
 * Vertical-only scrolling. iOS (Fabric) adds child overflow/transforms to the
 * content size, so any sub-pixel overflow would let a list drift sideways.
 */
export const verticalScroll = {
  horizontal: false,
  alwaysBounceHorizontal: false,
  showsHorizontalScrollIndicator: false,
  directionalLockEnabled: true,
} as const;
export const verticalContent: ViewStyle = { overflow: "hidden", maxWidth: "100%" };

export const Theme = createContext<PluginTheme | null>(null);
export function useTheme() {
  const theme = useContext(Theme);
  if (!theme) throw new Error("Theme missing");
  return theme;
}

/** Alpha tint of a theme color; falls back to the color itself for non-hex values. */
export function tint(color: string, alpha: number) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${full}${a}`;
}

type Hoverable = PressableStateCallbackType & { hovered?: boolean };
/**
 * Web: suppress the browser's square focus outline on pressables; components
 * show focus with their own hover/selected styling instead.
 */
export const noFocusRing = { outlineStyle: "none" } as unknown as ViewStyle;

export function Label({
  children,
  muted = false,
  size = font.md,
  bold = false,
  medium = false,
  lines,
  selectable,
  color,
  mono = false,
  italic = false,
}: {
  children: ReactNode;
  muted?: boolean;
  size?: number;
  bold?: boolean;
  medium?: boolean;
  lines?: number;
  selectable?: boolean;
  color?: string;
  mono?: boolean;
  italic?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Text
      numberOfLines={lines}
      // Android's default ("highQuality") measures a line narrower than it draws, so a short
      // one-line label beside other content could lose its last word ("just now" → "just").
      textBreakStrategy={lines === 1 ? "simple" : undefined}
      selectable={selectable}
      style={{
        userSelect: selectable === false ? "none" : undefined,
        color: color || (muted ? colors.foregroundMuted : colors.foreground),
        fontSize: size,
        lineHeight: Math.round(size * 1.45),
        fontWeight: bold ? "600" : medium ? "500" : "400",
        fontStyle: italic ? "italic" : undefined,
        fontFamily: mono ? monoFont : undefined,
      }}
    >
      {children}
    </Text>
  );
}
export const monoFont = Platform.OS === "ios" ? "Menlo" : "monospace";

export function Button({
  children,
  onPress,
  primary = false,
  disabled = false,
  label,
  icon,
  leading,
  quiet = false,
  danger = false,
  grow = false,
  small = false,
}: {
  children: ReactNode;
  onPress: (event: GestureResponderEvent) => void;
  primary?: boolean;
  disabled?: boolean;
  label?: string;
  icon?: string;
  /** A custom icon (e.g. a service logo) in place of `icon`. */
  leading?: ReactNode;
  quiet?: boolean;
  danger?: boolean;
  grow?: boolean;
  /** Compact control for inline rows (e.g. inside a card); the touch target stays 44 pt via hitSlop. */
  small?: boolean;
}) {
  const { colors } = useTheme();
  const height = small ? smallControl : control;
  const fg = primary
    ? colors.accentForeground
    : danger
      ? colors.statusDanger
      : colors.foreground;
  const hasText = !(typeof children === "string" && !children);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        label || (typeof children === "string" ? children : undefined)
      }
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={onPress}
      hitSlop={small && touch ? { top: (control - smallControl) / 2, bottom: (control - smallControl) / 2 } : undefined}
      style={(state) => {
        const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        const hovered = hover;
        return {
          ...noFocusRing,
          paddingHorizontal: hasText ? (small ? space[2] + 2 : space[3]) : 0,
          height,
          minWidth: height,
          borderRadius: radius.md,
          flexDirection: "row",
          flexGrow: grow ? 1 : 0,
          flexShrink: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: space[1.5],
          borderWidth: primary || quiet ? 0 : 1,
          borderColor: colors.border,
          backgroundColor: primary
            ? colors.accent
            : hovered || pressed
              ? colors.surface2
              : quiet
                ? "transparent"
                : colors.surface0,
          opacity: disabled ? 0.45 : pressed && primary ? 0.85 : 1,
        };
      }}
    >
      {leading ?? (icon && <Icon name={icon} size={small ? 13 : 15} color={fg} />)}
      {hasText && (
        <Text
          numberOfLines={1}
          selectable={false}
          style={{
            userSelect: "none",
            flexShrink: 1,
            color: fg,
            fontSize: small ? font.sm : font.md,
            fontWeight: "500",
          }}
        >
          {children}
        </Text>
      )}
    </Pressable>
  );
}

/** Square ghost icon button with a required accessible name. */
export function IconButton({
  icon,
  label,
  onPress,
  disabled = false,
  active = false,
  color,
  size = control,
  onHoverChange,
}: {
  icon: string;
  label: string;
  onPress(event: GestureResponderEvent): void;
  disabled?: boolean;
  active?: boolean;
  color?: string;
  size?: number;
  onHoverChange?(hovered: boolean): void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={onHoverChange && (() => onHoverChange(true))}
      onHoverOut={onHoverChange && (() => onHoverChange(false))}
      hitSlop={touch ? undefined : 4}
      style={(state) => {
        const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        const hovered = hover;
        return {
          ...noFocusRing,
          width: size,
          height: size,
          borderRadius: radius.md,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor:
            active || hovered || pressed ? colors.surface2 : "transparent",
          opacity: disabled ? 0.4 : 1,
        };
      }}
    >
      <Icon
        name={icon}
        size={16}
        color={color || (active ? colors.foreground : colors.foregroundMuted)}
      />
    </Pressable>
  );
}

type TextBoxProps = Omit<ComponentProps<typeof TextInput>, "value" | "defaultValue" | "onChangeText"> & {
  value: string;
  onChangeText(text: string): void;
  /** Report typing to the parent only after this much quiet (and on blur/unmount). */
  commitDelay?: number;
};

/**
 * Text input for plugin forms that stays smooth while typing (AGENTS.md "Text
 * input"). Native: the input owns its text — `defaultValue` is a seed that only
 * changes (with a remount) when the parent's value changes from outside; React
 * Native pushes any changed value/defaultValue back into the native view, which
 * erases characters typed meanwhile and breaks IME composition. Web: local
 * state, so a keystroke re-renders only this input. `commitDelay` keeps
 * expensive parents (board filtering) out of the typing path. Like Field, it
 * blocks board shortcuts while focused (SHORTCUTS-SPEC §2.2).
 */
export function TextBox({ value, onChangeText, commitDelay = 0, onFocus, onBlur, ...props }: TextBoxProps) {
  const native = Platform.OS !== "web";
  const [focused, setFocused] = useState(false);
  useShortcutBlock(focused);
  const [shown, setShown] = useState(value);
  const [mount, setMount] = useState(0);
  const committed = useRef(value);
  const typed = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const report = useRef(onChangeText);
  report.current = onChangeText;
  const commit = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (typed.current === committed.current) return;
    committed.current = typed.current;
    report.current(typed.current);
  };
  useEffect(() => () => commit(), []);
  useEffect(() => {
    if (value === committed.current) return;
    // An outside change (reset, restore, clear filters): show it.
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    committed.current = value;
    typed.current = value;
    setShown(value);
    if (native) setMount((m) => m + 1);
  }, [value]);
  return (
    <TextInput
      {...props}
      key={native ? `text-${mount}` : undefined}
      {...(native ? { defaultValue: shown } : { value: shown })}
      onChangeText={(text) => {
        typed.current = text;
        if (!native) setShown(text);
        if (commitDelay <= 0) return commit();
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(commit, commitDelay);
      }}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        commit();
        onBlur?.(event);
      }}
    />
  );
}

export function Field({
  title,
  value,
  onChange,
  multiline = false,
  placeholder = "",
  editable = true,
  hint,
  commitDelay,
  onSubmit,
  autoFocus,
  secure = false,
}: {
  title: string;
  value: string;
  onChange: (text: string) => void;
  /** Hide the typed text (tokens); also turns off autocorrect and capitalization. */
  secure?: boolean;
  multiline?: boolean;
  placeholder?: string;
  editable?: boolean;
  hint?: string;
  commitDelay?: number;
  /** Enter submits (Shift+Enter is a new line in a multiline field). Pass nothing while the form can't be submitted. */
  onSubmit?: () => void;
  autoFocus?: boolean;
}) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  useShortcutBlock(focused);
  return (
    <View style={{ gap: space[1.5] }}>
      <Label medium size={font.sm} muted>
        {title}
      </Label>
      <TextBox
        accessibilityLabel={title}
        value={value}
        onChangeText={onChange}
        commitDelay={commitDelay}
        multiline={multiline}
        editable={editable}
        autoFocus={autoFocus}
        placeholder={placeholder}
        placeholderTextColor={colors.foregroundMuted}
        {...(secure ? { secureTextEntry: true, autoCorrect: false, autoCapitalize: "none" as const } : {})}
        {...(onSubmit
          ? Platform.OS === "web"
            ? {
                onKeyPress: (event: { nativeEvent: unknown; preventDefault(): void }) => {
                  const action = composerEnterAction(event.nativeEvent as ComposerKey);
                  if (action === "native") return;
                  event.preventDefault();
                  if (action !== "suppress") onSubmit();
                },
              }
            : // A phone's return key is a new line in a multiline field; in a single line it submits.
              multiline
              ? {}
              : { onSubmitEditing: () => onSubmit(), returnKeyType: "done" as const, blurOnSubmit: false }
          : {})}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          borderWidth: 1,
          borderColor: focused ? colors.foregroundMuted : colors.border,
          borderRadius: radius.md,
          paddingHorizontal: space[3],
          paddingVertical: multiline ? space[2] + 2 : 0,
          color: editable ? colors.foreground : colors.foregroundMuted,
          backgroundColor: editable ? colors.surface0 : colors.surface1,
          fontSize: font.base,
          height: multiline ? undefined : touch ? 44 : 36,
          minHeight: multiline ? 96 : undefined,
          textAlignVertical: multiline ? "top" : "center",
          outlineStyle: "none",
        } as never}
      />
      {!!hint && (
        <Label muted size={font.sm}>
          {hint}
        </Label>
      )}
    </View>
  );
}

/** Segmented choice; wraps rather than scrolling horizontally. */
export function Choices<T extends string>({
  title,
  value,
  options,
  onChange,
  hideTitle = false,
}: {
  title: string;
  hideTitle?: boolean;
  value: T;
  options: readonly { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: space[1.5] }}>
      {!!title && !hideTitle && (
        <Label medium size={font.sm} muted>
          {title}
        </Label>
      )}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignSelf: "flex-start",
          maxWidth: "100%",
          gap: 2,
          padding: 2,
          borderRadius: radius.lg,
          backgroundColor: colors.surface2,
        }}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityLabel={`${title}: ${option.label}`}
              accessibilityState={{ selected, disabled: option.disabled }}
              disabled={option.disabled}
              onPress={() => onChange(option.value)}
              style={(state) => {
                const { hovered: hover, focused } = state as Hoverable & { focused?: boolean };
        const hovered = hover;
                return {
                  ...noFocusRing,
                  paddingHorizontal: space[3],
                  height: touch ? 40 : 28,
                  justifyContent: "center",
                  borderRadius: radius.md,
                  backgroundColor: selected
                    ? colors.surface0
                    : hovered
                      ? tint(colors.surface0, 0.5)
                      : "transparent",
                  borderWidth: 1,
                  borderColor: selected ? colors.border : "transparent",
                  opacity: option.disabled ? 0.4 : 1,
                };
              }}
            >
              <Text
                selectable={false}
                numberOfLines={1}
                style={{
                  userSelect: "none",
                  fontSize: font.md,
                  fontWeight: selected ? "500" : "400",
                  color: selected ? colors.foreground : colors.foregroundMuted,
                }}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export type Tone = "danger" | "warning" | "info" | "success";
export function Notice({
  children,
  tone = "danger",
}: {
  children: ReactNode;
  tone?: Tone;
}) {
  const { colors } = useTheme();
  const color = toneColor(colors, tone);
  return (
    <View
      accessibilityRole={tone === "danger" ? "alert" : undefined}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: space[2],
        paddingHorizontal: space[3],
        paddingVertical: space[2] + 2,
        borderWidth: 1,
        borderColor: tint(color, 0.35),
        backgroundColor: tint(color, 0.08),
        borderRadius: radius.lg,
      }}
    >
      <View style={{ paddingTop: 2 }}>
        <Icon name={toneIcon[tone]} size={14} color={color} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.md}>{children}</Label>
      </View>
    </View>
  );
}
const toneIcon: Record<Tone, string> = {
  danger: "CircleAlert",
  warning: "TriangleAlert",
  info: "Info",
  success: "CircleCheck",
};
export function toneColor(colors: PluginTheme["colors"], tone: Tone) {
  return tone === "danger"
    ? colors.statusDanger
    : tone === "warning"
      ? colors.statusWarning
      : tone === "success"
        ? colors.statusSuccess
        : colors.foregroundMuted;
}

export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
      }}
    />
  );
}

export function Badge({ children, color }: { children: string; color?: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        paddingHorizontal: space[1.5],
        height: 18,
        justifyContent: "center",
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: color ? tint(color, 0.4) : colors.border,
      }}
    >
      <Text
        selectable={false}
        style={{
          userSelect: "none",
          fontSize: font.xs,
          fontWeight: "500",
          color: color || colors.foregroundMuted,
        }}
      >
        {children}
      </Text>
    </View>
  );
}

/** Solid Paseo theme count pill shared by the board Attention button and sidebar badge. */
export function CountPill({ text }: { text: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        minWidth: 16,
        height: 16,
        paddingHorizontal: 4,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.accent,
      }}
    >
      <Label size={font.xs} bold color={colors.accentForeground} selectable={false}>
        {text}
      </Label>
    </View>
  );
}

/** Host-style list row for menus and pickers. */
export function Row({
  title,
  detail,
  icon,
  iconColor,
  leading,
  trailing,
  selected = false,
  disabled = false,
  onPress,
  label,
  menu,
  testID,
}: {
  title: string;
  detail?: string;
  icon?: string;
  iconColor?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onPress(): void;
  label?: string;
  /** Context-menu handlers (right-click / long-press). */
  menu?: object;
  /** Stable id for automation (UI-UX-SPEC §2, automation names). */
  testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      accessibilityLabel={label || title}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      {...(menu || {})}
      style={(state) => {
        const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        const hovered = hover;
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[3],
          minHeight: touch ? 52 : detail ? 48 : 36,
          paddingHorizontal: space[3],
          paddingVertical: space[1.5],
          borderRadius: radius.lg,
          backgroundColor: selected
            ? colors.surface2
            : hovered || pressed
              ? colors.surface1
              : "transparent",
          opacity: disabled ? 0.45 : 1,
        };
      }}
    >
      {leading}
      {icon && (
        <Icon name={icon} size={16} color={iconColor || colors.foregroundMuted} />
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label medium={selected} lines={1} selectable={false} size={font.base}>
          {title}
        </Label>
        {!!detail && (
          <Label muted size={font.sm} lines={1} selectable={false}>
            {detail}
          </Label>
        )}
      </View>
      {/* The check sits before the trailing value so trailing values stay in one column. */}
      {selected && <Icon name="Check" size={16} color={colors.foreground} />}
      {/* Never squeezed by a long title or detail ("just now", counts): the text truncates instead. */}
      {!!trailing && <View style={{ flexShrink: 0 }}>{trailing}</View>}
    </Pressable>
  );
}

/**
 * An accent ring drawn over its parent's edge (`inset` points outside it), fading in while `on`.
 * The welcome tour's autoplay uses it to show which control it is about to press.
 */
export function CueRing({ on, radius: round, inset = 0 }: { on: boolean; radius: number; inset?: number }) {
  const { colors } = useTheme();
  const opacity = useMotionValue(on ? 1 : 0, motionDuration.forward);
  return (
    <Animated.View
      pointerEvents="none"
      style={{ position: "absolute", top: -inset, left: -inset, right: -inset, bottom: -inset, borderRadius: round + inset, borderWidth: 2, borderColor: colors.accent, opacity }}
    />
  );
}

/** A right-pointing chevron that turns down as `open` becomes true, in step with the `Collapse` it controls. */
export function TurnChevron({ open, size = 14, color }: { open: boolean; size?: number; color: string }) {
  const turn = useMotionValue(open ? 1 : 0, open ? motionDuration.forward : motionDuration.reverse);
  return (
    <Animated.View style={{ transform: [{ rotate: lerp(turn, ["0deg", "90deg"]) }] }}>
      <Icon name="ChevronRight" size={size} color={color} />
    </Animated.View>
  );
}

/**
 * The mark of content an AI wrote or suggested (summaries, digests, ideas,
 * next steps, agent-added artifacts and tags): the Sparkles icon in the accent
 * color, the same one the next-move chips lead with. Decorative unless labelled.
 */
export function AiMark({ size = 13, label }: { size?: number; label?: string }) {
  const { colors } = useTheme();
  return label ? (
    <View accessible accessibilityRole="image" accessibilityLabel={label}>
      <Icon name="Sparkles" size={size} color={colors.accent} />
    </View>
  ) : (
    <Icon name="Sparkles" size={size} color={colors.accent} />
  );
}

export function SectionHeader({
  title,
  count,
  ai,
  open,
  onToggle,
  summary,
  children,
}: {
  title: string;
  count?: number;
  /** The section shows AI-written content: the title gets the AI mark. */
  ai?: boolean;
  /** With `onToggle`: the title collapses the section; a chevron after it shows the state. */
  open?: boolean;
  onToggle?(): void;
  /** One muted line after the title while the section is collapsed (what is inside). */
  summary?: string;
  children?: ReactNode;
}) {
  const { colors } = useTheme();
  const heading = (
    <>
      <Label bold size={font.md} selectable={false}>
        {title}
      </Label>
      {ai && <AiMark label={t("AI generated")} />}
      {count !== undefined && (
        <Label muted size={font.md} selectable={false}>
          {count}
        </Label>
      )}
      {onToggle && <TurnChevron open={!!open} size={14} color={colors.foregroundMuted} />}
    </>
  );
  const row = { flexDirection: "row", alignItems: "center", gap: space[1.5] } as const;
  const showSummary = !open && !!summary;
  // With a summary after it the title keeps its own width (the summary is the part that gives way), so a narrow phone
  // never wraps "Progress" onto two lines or draws the AI mark over the summary.
  const titleBox = showSummary ? { flexGrow: 0, flexShrink: 0 } : { flex: 1, minWidth: 0 };
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space[2],
        minHeight: control,
      }}
    >
      {onToggle ? (
        <View style={{ ...titleBox, flexDirection: "row" }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={title}
            accessibilityState={{ expanded: !!open }}
            onPress={onToggle}
            style={({ pressed }) => ({ ...noFocusRing, ...row, minHeight: touch ? 44 : control, flexShrink: 1, opacity: pressed ? 0.7 : 1 })}
          >
            {heading}
          </Pressable>
        </View>
      ) : (
        <View style={{ ...titleBox, ...row }}>{heading}</View>
      )}
      {showSummary && (
        // Pushed to the row's end, so every collapsed section's summary ends at one right edge.
        <View style={{ flexShrink: 1, minWidth: 0, maxWidth: "60%", marginLeft: "auto" }}>
          <Label muted size={font.sm} lines={1} selectable={false}>
            {summary}
          </Label>
        </View>
      )}
      {/* Actions keep their size too: only the summary gives way, so "Refresh" never shortens to "Ref…". */}
      {!!children && <View style={{ flexShrink: 0, flexDirection: "row", alignItems: "center", gap: space[2] }}>{children}</View>}
    </View>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return <View style={[{ height: 1, backgroundColor: colors.border }, style]} />;
}

/** Right-aligned modal footer: secondary actions first, primary last. */
export function Actions({ children }: { children: ReactNode }) {
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        justifyContent: "flex-end",
        gap: space[2],
        paddingTop: space[1],
      }}
    >
      {children}
    </View>
  );
}

/** "just now", "5m ago": one unit, so its words never wrap apart (non-breaking spaces). */
export function relativeTime(iso: string | null | undefined, now = Date.now()) {
  return relativeTimeText(iso, now).replace(/ /g, "\u00a0");
}

function relativeTimeText(iso: string | null | undefined, now: number) {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return t("just now");
  const m = Math.round(s / 60);
  if (m < 60) return t("{n}m ago", { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t("{n}h ago", { n: h });
  const d = Math.round(h / 24);
  if (d < 30) return t("{n}d ago", { n: d });
  return new Date(at).toLocaleDateString(formatLocale());
}

export const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);
export const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export const basename = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).pop() || path;

/** Switch row: title, optional detail, trailing track. */
/** A bare on/off switch (no title row); use Toggle for a labelled setting. */
export function Switch({
  value,
  onChange,
  label,
  disabled = false,
}: {
  value: boolean;
  onChange(value: boolean): void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      hitSlop={6}
      style={{ ...noFocusRing, opacity: disabled ? 0.45 : 1 }}
    >
      <SwitchTrack value={value} />
    </Pressable>
  );
}

export function SwitchTrack({ value }: { value: boolean }) {
  const { colors } = useTheme();
  const thumb = useMotionValue(value ? 1 : 0, motionDuration.feedback);
  return (
    <View
      style={{
        width: 34,
        height: 20,
        borderRadius: 10,
        padding: 2,
        justifyContent: "center",
        alignItems: "flex-start",
        backgroundColor: value ? colors.accent : colors.surface2,
        borderWidth: 1,
        borderColor: value ? colors.accent : colors.border,
      }}
    >
      <Animated.View
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          backgroundColor: value ? colors.accentForeground : colors.surface0,
          transform: [{ translateX: lerp(thumb, [0, 14]) }],
        }}
      />
    </View>
  );
}

export function Toggle({
  title,
  detail,
  value,
  onChange,
}: {
  title: string;
  detail?: string;
  value: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={{ ...noFocusRing,
        flexDirection: "row",
        alignItems: "center",
        gap: space[3],
        minHeight: touch ? 52 : 44,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.base} selectable={false}>{title}</Label>
        {!!detail && (
          <Label muted size={font.sm} selectable={false}>
            {detail}
          </Label>
        )}
      </View>
      <SwitchTrack value={value} />
    </Pressable>
  );
}
