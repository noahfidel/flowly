import { Fragment, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction, type ReactNode } from "react";
import { Animated, Pressable, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMotionPresence, lerp } from "./motion";
import { Label, SectionHeader, font, space, touch, useTheme, noFocusRing } from "./ui";
import { FocusTarget } from "./drawer-focus";
import { t, tn } from "../shared/i18n";

export function Disclosure({ title, summary, titleMinWidth, open, disabled, flush, onChange, children }: {
  title: string;
  summary?: string;
  /** Rows stacked under each other pass the same value: their summaries then start at one left edge instead of ending at the right one. */
  titleMinWidth?: number;
  open: boolean;
  disabled?: boolean;
  /** The body starts at the title's left edge instead of under the title text (lists of bordered items). */
  flush?: boolean;
  onChange(open: boolean): void;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open, disabled: !!disabled }}
        disabled={disabled}
        onPress={() => onChange(!open)}
        style={({ pressed }) => ({ ...noFocusRing,
          minHeight: touch ? 44 : 32, flexDirection: "row", alignItems: "center", gap: 6,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        })}
      >
        <Chevron open={open} title={title} color={colors.foregroundMuted} />
        {/* With a summary the title keeps its own width and the summary gives way (as in SectionHeader). */}
        <View style={summary ? { flexShrink: 0, minWidth: titleMinWidth } : { flex: 1, minWidth: 0 }}>
          <Label bold size={font.md} selectable={false}>{title}</Label>
        </View>
        {!!summary && (
          <View style={titleMinWidth ? { flex: 1, minWidth: 0 } : { flexShrink: 1, minWidth: 0, maxWidth: "50%", marginLeft: "auto" }}>
            <Label muted size={font.sm} lines={1} selectable={false}>{summary}</Label>
          </View>
        )}
      </Pressable>
      <Collapse open={open} id={title} style={{ paddingTop: 8, paddingBottom: 4, paddingLeft: flush ? 0 : 22, gap: 10 }}>
        {children}
      </Collapse>
    </View>
  );
}

/** A chevron that turns from right to down with the same progress as `Collapse`. */
export function Chevron({ open, title, color, size = 16 }: { open: boolean; title: string; color: string; size?: number }) {
  const presence = useMotionPresence(open ? true : undefined, open ? title : "");
  const moving = !!presence.item && !presence.settled;
  return (
    <Animated.View style={{ transform: [{ rotate: moving ? lerp(presence.progress, ["0deg", "90deg"]) : open ? "90deg" : "0deg" }] }}>
      <Icon name="ChevronRight" size={size} color={color} />
    </Animated.View>
  );
}

type CollapseProps = {
  open: boolean;
  /** Identity of the content; a new id restarts the reveal. */
  id: string;
  style?: object;
  children: ReactNode;
};

/** Local measured-height accordion; text keeps its width and natural size. */
export function Collapse(props: CollapseProps) {
  return <HeightCollapse {...props} />;
}

function HeightCollapse({ open, id, style, children }: CollapseProps) {
  // Mounted open (a section shown expanded): stay in the normal layout until measured, so nothing jumps.
  const [height, setHeight] = useState<number | null>(() => (open ? null : 0));
  const presence = useMotionPresence(open ? true : undefined, open ? id : "", false);
  if (!presence.item) return null;
  const measured = height !== null;
  return (
    <Animated.View
      testID="disclosure-body"
      pointerEvents={presence.active ? "auto" : "none"}
      accessibilityElementsHidden={!presence.active}
      importantForAccessibility={presence.active ? "auto" : "no-hide-descendants"}
      style={{
        overflow: "hidden",
        ...(measured ? { height: lerp(presence.progress, [0, height]) } : null),
        opacity: presence.progress,
      }}
    >
      <View
        onLayout={(event) => setHeight(Math.max(0, event.nativeEvent.layout.height))}
        style={{ ...(measured ? { position: "absolute", top: 0, left: 0, right: 0 } : null), ...style }}
      >{children}</View>
    </Animated.View>
  );
}

/**
 * A card sidebar section (DRAWER-SPEC, Section order): a header whose title
 * collapses it, a one-line summary while collapsed, actions on the right, and
 * the body revealed by `Collapse`. The drawer owns `open`, so the user's
 * defaults apply each time the sidebar opens.
 */
export function Section({ id, title, count, ai, summary, open, onToggle, actions, empty, focusId, children }: {
  id: string;
  title: string;
  count?: number;
  ai?: boolean;
  summary?: string;
  open: boolean;
  onToggle(): void;
  actions?: ReactNode;
  /** Nothing to show yet: a plain header (with its actions), no chevron and no body. */
  empty?: boolean;
  /** The drawer section this is, so a search hit can land on it (DRAWER-SPEC "Focus from search"). */
  focusId?: string;
  children?: ReactNode;
}) {
  const body = (
    <View style={{ gap: space[2] }}>
      <SectionHeader title={title} count={count} ai={ai} open={open || empty} onToggle={empty ? undefined : onToggle} summary={summary}>
        {actions}
      </SectionHeader>
      {!empty && (
        <Collapse open={open} id={id} style={{ gap: space[2] }}>
          {children}
        </Collapse>
      )}
    </View>
  );
  return focusId ? <FocusTarget id={`section:${focusId}`}>{body}</FocusTarget> : body;
}

/** "Show N more": adds the next rows to the same list, lined up with the rows' icons. There is no Show less. */
export function ShowMore({ count, onPress }: { count: number; onPress(): void }) {
  const { colors } = useTheme();
  const label = tn(count, "Show {n} more", "Show {n} more");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({ ...noFocusRing, flexDirection: "row", alignItems: "center", gap: space[1.5], minHeight: touch ? 44 : 30, opacity: pressed ? 0.7 : 1 })}
    >
      <Icon name="ChevronDown" size={14} color={colors.foregroundMuted} />
      <Label muted size={font.sm} selectable={false}>{label}</Label>
    </Pressable>
  );
}

/** How the drawer controls a section (open state lives in the drawer). */
export type SectionState = { open: boolean; onToggle(): void };

/** Keep memoized sibling sections untouched when only one section toggles. */
export function useSectionStates<T extends string>(opened: Record<T, boolean>, set: Dispatch<SetStateAction<Record<T, boolean>>>) {
  const previous = useRef<Partial<Record<T, SectionState>>>({});
  return useMemo(() => {
    const next = {} as Record<T, SectionState>;
    (Object.keys(opened) as T[]).forEach((id) => {
      const old = previous.current[id];
      next[id] = old?.open === opened[id] ? old : {
        open: opened[id],
        onToggle: old?.onToggle || (() => set((current) => ({ ...current, [id]: !current[id] }))),
      };
    });
    previous.current = next;
    return next;
  }, [opened, set]);
}


/** Rows shown at first and added by each Show more. */
export const pageSize = 5;

/**
 * A paged list: the first page as plain rows, each page added by Show more opening
 * like a section (measured height and fade), so new rows never just pop in.
 */
export function PagedRows<T>({ items, limit, gap = 2, render }: { items: readonly T[]; limit: number; gap?: number; render(item: T): ReactNode }) {
  const end = Math.min(limit, items.length);
  const pages: T[][] = [];
  for (let start = 0; start < end; start += pageSize) pages.push(items.slice(start, Math.min(start + pageSize, end)));
  return (
    <>
      {pages.map((page, index) =>
        index === 0 ? <Fragment key={0}>{page.map(render)}</Fragment> : <RevealPage key={index} gap={gap}>{page.map(render)}</RevealPage>,
      )}
    </>
  );
}

function RevealPage({ gap, children }: { gap: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => setOpen(true), []);
  return <Collapse open={open} id="page" style={{ gap }}>{children}</Collapse>;
}
