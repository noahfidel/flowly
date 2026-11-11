import { useEffect, useState, type ReactNode } from "react";
import { Marked } from "./drawer-focus";
import { Animated, Pressable, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMotionHeight, useMotionValue } from "./motion";
import { Label, font, noFocusRing, radius, space, tint, touch, useTheme } from "./ui";
import { t } from "../shared/i18n";
import type { Status, Task } from "../shared/model";
import { StatusIcon } from "./status";

/** The bordered surface every content card sits on; the native timeline cards share it. */
export const cardFrameStyle = (colors: { border: string; surface1: string }) =>
  ({ borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }) as const;

/**
 * The content card style first built for the drawer's Progress card, shared so
 * Progress, Ideas and later cards read the same: one bordered surface, 12 pt
 * padding, a body clamped to `clampHeight` (about five lines by default) with
 * a fade, and one footer row with Show more / Show less on the left and
 * `footer` (a timestamp or the card's actions) on the right. `after` renders
 * below the padded area, full width (e.g. the Ideas page's source line).
 */
export function ContentCard({
  footer,
  after,
  defaultOpen = false,
  openWhen,
  clampHeight = CLAMP_HEIGHT,
  stripe,
  children,
}: {
  footer?: ReactNode;
  after?: ReactNode;
  /** Start expanded (the welcome tour shows every field, the timeline Progress row); Show less still collapses it. */
  defaultOpen?: boolean;
  /** Expands whenever this changes to a value (a search hit on the card); Show less still collapses it. */
  openWhen?: unknown;
  /** Collapsed body height; the drawer's Progress card uses PROGRESS_CLAMP_HEIGHT. */
  clampHeight?: number;
  /** A 3 pt left edge in this color (the Memory page's kind). */
  stripe?: string;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={stripe ? [cardFrameStyle(colors), { borderLeftWidth: 3, borderLeftColor: stripe }] : cardFrameStyle(colors)}>
      <View style={{ padding: space[3], paddingBottom: space[3] }}>
        <Clamped background={colors.surface1} footer={footer} defaultOpen={defaultOpen} openWhen={openWhen} clampHeight={clampHeight}>
          {children}
        </Clamped>
      </View>
      {after}
    </View>
  );
}

/** Stacks a card's blocks (headline, text, fields) with the card's block spacing. */
export function CardBody({ children }: { children: ReactNode }) {
  return <View style={{ gap: space[2] }}>{children}</View>;
}

/** The card's lead line (Progress state, idea title). */
export function CardHeadline({ children, selectable = true }: { children: ReactNode; selectable?: boolean }) {
  return (
    <Label medium size={font.base} selectable={selectable}>
      {children}
    </Label>
  );
}

/** A paragraph of card body text. */
export function CardText({ children }: { children: ReactNode }) {
  return (
    <Label size={font.md} selectable>
      {children}
    </Label>
  );
}

/** A titled block (Target, Recap, What to do…). Renders nothing for empty text. `terms` are marked (search). */
export function CardField({ title, text, terms }: { title: string; text: string; terms?: readonly string[] | null }) {
  if (!text.trim()) return null;
  return (
    <View style={{ gap: 2 }}>
      <Label muted size={font.xs} selectable={false}>
        {title}
      </Label>
      <CardText>
        <Marked text={text} terms={terms} />
      </CardText>
    </View>
  );
}

/** A wrapping row of small muted facts under the headline. */
export function CardMetaRow({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space[3], rowGap: 2 }}>{children}</View>;
}

/** One fact in a CardMetaRow, with an optional 12 pt icon. */
export function CardMeta({ icon, text }: { icon?: ReactNode; text: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
      {icon}
      <Label muted size={font.sm} selectable={false}>{text}</Label>
    </View>
  );
}

/** Small muted footer text (a timestamp line). */
export function CardFootnote({ children }: { children: ReactNode }) {
  return (
    <Label muted size={font.sm} selectable={false}>
      {children}
    </Label>
  );
}

/** About five lines of content; longer content collapses as a whole to this height (Ideas, Memory, the timeline Progress row). */
const CLAMP_HEIGHT = 104;

/**
 * The drawer's Progress card: about twelve lines, so State, four Recap lines and
 * Next show in full at the default drawer width; a summary that still shows
 * Target usually collapses (TASK-SUMMARY-SPEC §7).
 */
export const PROGRESS_CLAMP_HEIGHT = 240;

/**
 * Clamps its children as one block to `clampHeight` with a fade, and offers
 * Show more / Show less with an animated height (TASK-SUMMARY-SPEC §7).
 * Content that fits shows in full without a toggle. The toggle sits in the
 * bottom-left corner and `footer` on the right of the same row.
 * `background` is the surface the fade blends into.
 */
function Clamped({
  background,
  footer,
  defaultOpen = false,
  openWhen,
  clampHeight,
  children,
}: {
  background: string;
  footer?: ReactNode;
  defaultOpen?: boolean;
  openWhen?: unknown;
  clampHeight: number;
  children: ReactNode;
}) {
  const [natural, setNatural] = useState(0);
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (openWhen) setOpen(true);
  }, [openWhen]);
  const overflows = natural > clampHeight + 8;
  const target = natural ? (open || !overflows ? natural : clampHeight) : null;
  const height = useMotionHeight(target);
  const fade = useMotionValue(overflows && !open ? 1 : 0);
  return (
    <View style={{ gap: space[2] }}>
      <Animated.View
        style={{
          overflow: "hidden",
          // Until measured, cap a closed card without animating so long content never flashes open;
          // an open one lays out at its natural height so it never mounts short and then jumps.
          ...(target !== null ? { height } : open ? null : { maxHeight: clampHeight }),
        }}
      >
        <View onLayout={(e) => setNatural(Math.ceil(e.nativeEvent.layout.height))}>{children}</View>
        {overflows && (
          <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 32, opacity: fade }}>
            {[0.15, 0.45, 0.75, 0.95].map((alpha) => (
              <View key={alpha} style={{ flex: 1, backgroundColor: tint(background, alpha) }} />
            ))}
          </Animated.View>
        )}
      </Animated.View>
      {/* Footer row: the toggle in the bottom-left corner, `footer` on the right. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], minHeight: 24 }}>
        {overflows && <Toggle open={open} onPress={() => setOpen(!open)} />}
        <View style={{ flex: 1, minWidth: 0, alignItems: "flex-end" }}>{footer}</View>
      </View>
    </View>
  );
}

/**
 * Show more / Show less. Its icon and label sit on the content's left edge so
 * it lines up with the text above while idle; the hover highlight pads out
 * past that edge by a few points but stays well inside the card's own padding.
 * Also the collapsed timeline Progress row's toggle (NATIVE-SESSION-SPEC §5.3).
 */
export function Toggle({ open, onPress }: { open: boolean; onPress(): void }) {
  const { colors } = useTheme();
  const label = open ? t("Show less") : t("Show more");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      style={(state) => {
        const { pressed, hovered, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[1.5],
          height: touch ? 44 : 32,
          paddingHorizontal: space[1.5],
          marginLeft: -space[1.5],
          borderRadius: radius.md,
          backgroundColor: pressed || hovered ? colors.surface2 : "transparent",
        };
      }}
    >
      <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={colors.foreground} />
      <Label medium size={font.md} selectable={false}>{label}</Label>
    </Pressable>
  );
}

/** "From <card> · <lane>" under a memory or an idea; also the welcome tour's demo. */
export function SourceLine({ task, nameOf, onOpenTask }: { task: Task | undefined; nameOf(status: Status): string; onOpenTask(id: string): void }) {
  const { colors } = useTheme();
  if (!task)
    return (
      <View style={{ marginHorizontal: space[3], marginBottom: space[1.5], paddingHorizontal: space[2], minHeight: touch ? 36 : 28, justifyContent: "center" }}>
        <Label muted size={font.xs}>{t("From a deleted card")}</Label>
      </View>
    );
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={t("From card {title}, {state}. Open it", { title: task.title, state: task.archivedAt ? t("archived") : nameOf(task.status) })}
      onPress={() => onOpenTask(task.id)}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        ...noFocusRing,
        flexDirection: "row",
        alignItems: "center",
        gap: space[1.5],
        marginHorizontal: space[3],
        marginBottom: space[1.5],
        paddingHorizontal: space[2],
        minHeight: touch ? 36 : 28,
        borderRadius: radius.md,
        backgroundColor: pressed || hovered ? colors.surface2 : tint(colors.foreground, 0.03),
      })}
    >
      <Label muted size={font.xs} selectable={false}>{t("From")}</Label>
      <StatusIcon status={task.status} size={12} />
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Label size={font.sm} lines={1} selectable={false}>{task.title}</Label>
      </View>
      <View style={{ flexShrink: 0 }}>
        <Label muted size={font.xs} lines={1} selectable={false}>· {task.archivedAt ? t("Archived") : nameOf(task.status)}</Label>
      </View>
      <View style={{ flex: 1 }} />
      <Icon name="ChevronRight" size={13} color={colors.foregroundMuted} />
    </Pressable>
  );
}
