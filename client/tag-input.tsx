import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { t } from "../shared/i18n";
import { normalizeTag, splitTagInput } from "../shared/tags";
import { tagLimits } from "../shared/model";
import { AiMark, Label, TextBox, font, noFocusRing, radius, space, tint, touch, useTheme } from "./ui";
import { useShortcutBlock } from "./shortcuts";

type Hoverable = { hovered?: boolean; focused?: boolean; pressed?: boolean };
/** Chip height; read at render (no module-load work on `./ui`). */
const chipSize = () => (touch ? 30 : 24);

/**
 * A `#tag` chip (CARD-TAGS-SPEC §6.3). The label filters the board when `onPress`
 * is given; the × removes it and is always visible, so removing needs no mode.
 * `agent` marks tags an agent added.
 */
export function TagPill({
  tag,
  agent = false,
  onPress,
  onRemove,
  inert = false,
}: {
  tag: string;
  agent?: boolean;
  onPress?: () => void;
  onRemove?: () => void;
  /** Keep the × in place but ignore presses (a drawer that is closing). */
  inert?: boolean;
}) {
  const { colors } = useTheme();
  const [hovered, setHovered] = useState(false);
  return (
    <View
      // Hover over the whole chip brightens the ×, so it reads as part of the tag.
      {...({ onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) } as object)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        height: chipSize(),
        borderRadius: radius.md,
        backgroundColor: hovered ? colors.surface2 : tint(colors.foregroundMuted, 0.1),
        maxWidth: "100%",
        overflow: "hidden",
      }}
    >
      <Pressable
        accessibilityRole={onPress ? "button" : undefined}
        accessibilityLabel={agent ? t("{tag}, added by an agent", { tag }) : tag}
        accessibilityHint={onPress ? t("Filter the board by this tag") : undefined}
        disabled={!onPress || inert}
        onPress={onPress}
        style={{
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: 3,
          height: "100%",
          paddingLeft: space[2],
          paddingRight: onRemove ? 2 : space[2],
          flexShrink: 1,
          minWidth: 0,
        }}
      >
        {agent && <AiMark size={12} />}
        <Label size={font.sm} lines={1} selectable={false}>{`#${tag}`}</Label>
      </Pressable>
      {!!onRemove && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Remove tag {tag}", { tag })}
          disabled={inert}
          onPress={onRemove}
          hitSlop={touch ? 8 : 4}
          style={(state) => ({
            ...noFocusRing,
            height: "100%",
            paddingLeft: 2,
            paddingRight: space[1.5],
            justifyContent: "center",
            opacity: (state as Hoverable).hovered || hovered || touch ? 1 : 0.55,
          })}
        >
          <Icon name="X" size={touch ? 14 : 12} color={colors.foregroundMuted} />
        </Pressable>
      )}
    </View>
  );
}

/**
 * Tags as one editable row: chips (× removes) followed by "+ Add tag", which
 * becomes an inline input in place. Enter, comma or a suggestion adds and keeps
 * the input open for the next tag; Esc, or leaving it empty, closes it;
 * Backspace in the empty input removes the last tag. Values are normalized.
 */
export const TagEditor = memo(function TagEditor({
  tags,
  agentTags,
  suggestions,
  onAdd,
  onRemove,
  onPressTag,
  disabled,
  inert = false,
  startOpen = false,
}: {
  tags: readonly string[];
  /** Tags an agent added, marked with an icon. */
  agentTags?: ReadonlySet<string>;
  suggestions: readonly string[];
  onAdd: (tags: string[]) => void;
  onRemove: (tag: string) => void;
  /** Tapping a chip's label (the drawer filters the board by it). */
  onPressTag?: (tag: string) => void;
  disabled?: boolean;
  /**
   * Keep the editable layout (× and "+ Add") but ignore presses. A drawer that
   * is closing passes this instead of `disabled`, so the chips do not reflow.
   */
  inert?: boolean;
  /** Open the input at once (an empty form field). */
  startOpen?: boolean;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(startOpen),
    [draft, setDraft] = useState(""),
    [error, setError] = useState(""),
    [focused, setFocused] = useState(false);
  useShortcutBlock(focused);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
  }, []);
  const full = tags.length >= tagLimits.perTask;
  const close = () => {
    setOpen(false);
    setDraft("");
    setError("");
  };
  const add = (text: string) => {
    const parts = splitTagInput(text);
    if (!parts.length) return;
    try {
      const values = [...new Set(parts.map(normalizeTag))].filter((v) => !tags.includes(v));
      if (tags.length + values.length > tagLimits.perTask)
        throw new Error(t("A card can have at most {n} tags.", { n: tagLimits.perTask }));
      setError("");
      setDraft("");
      if (values.length) onAdd(values);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const typedKey = useMemo(() => {
    try {
      return draft.trim() ? normalizeTag(draft) : "";
    } catch {
      return draft.trim().toLowerCase();
    }
  }, [draft]);
  // Only while the input is open: prefix matches first, then other matches.
  const shown = useMemo(() => {
    if (!open) return [];
    const free = suggestions.filter((s) => !tags.includes(s));
    if (!typedKey) return free.slice(0, 8);
    const starts = free.filter((s) => s.startsWith(typedKey)),
      contains = free.filter((s) => !s.startsWith(typedKey) && s.includes(typedKey));
    return [...starts, ...contains].slice(0, 8);
  }, [open, typedKey, suggestions, tags]);
  const editable = !disabled;
  return (
    <View style={{ gap: space[1.5] }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space[1] }}>
        {tags.map((tag) => (
          <TagPill
            key={tag}
            tag={tag}
            agent={agentTags?.has(tag)}
            onPress={onPressTag ? () => onPressTag(tag) : undefined}
            onRemove={editable ? () => onRemove(tag) : undefined}
            inert={inert}
          />
        ))}
        {editable && !full && !open && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Add a tag")}
            disabled={inert}
            onPress={() => setOpen(true)}
            style={(state) => ({
              ...noFocusRing,
              flexDirection: "row",
              alignItems: "center",
              gap: 3,
              height: chipSize(),
              paddingHorizontal: space[2],
              borderRadius: radius.md,
              borderWidth: 1,
              borderStyle: "dashed",
              borderColor: (state as Hoverable).hovered ? colors.foregroundMuted : colors.border,
            })}
          >
            <Icon name="Plus" size={12} color={colors.foregroundMuted} />
            <Label size={font.sm} muted selectable={false}>
              {tags.length ? t("Add") : t("Add tag")}
            </Label>
          </Pressable>
        )}
        {editable && !full && open && (
          <TextBox
            accessibilityLabel={t("Add a tag")}
            value={draft}
            onChangeText={(text) => {
              setError("");
              // A typed comma ends a tag.
              if (/[,，、]/u.test(text)) add(text);
              else setDraft(text);
            }}
            autoFocus
            editable={!inert}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t("e.g. drawer, performance")}
            onSubmitEditing={() => (draft.trim() ? add(draft) : close())}
            blurOnSubmit={false}
            returnKeyType="done"
            {...(Platform.OS === "web"
              ? {
                  onKeyPress: (event: { nativeEvent: { key?: string }; preventDefault(): void }) => {
                    const key = event.nativeEvent.key;
                    if (key === "Escape") {
                      event.preventDefault();
                      close();
                    } else if (key === "Backspace" && !draft && tags.length) onRemove(tags[tags.length - 1]);
                  },
                }
              : {})}
            onFocus={() => {
              if (blurTimer.current) clearTimeout(blurTimer.current);
              setFocused(true);
            }}
            onBlur={() => {
              setFocused(false);
              // Let a suggestion tap land first; keep typed text instead of losing it.
              if (blurTimer.current) clearTimeout(blurTimer.current);
              blurTimer.current = setTimeout(() => {
                if (!draftRef.current.trim()) close();
              }, 200);
            }}
            style={{
              // Android pads single-line inputs vertically by default, which clips text in a short box.
              height: touch ? 36 : chipSize(),
              minWidth: 140,
              flexGrow: 1,
              flexBasis: 140,
              paddingHorizontal: space[2],
              paddingVertical: 0,
              textAlignVertical: "center",
              includeFontPadding: false,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: focused ? colors.foregroundMuted : colors.border,
              color: colors.foreground,
              backgroundColor: colors.surface0,
              fontSize: touch ? font.base : font.sm,
              outlineStyle: "none",
            } as never}
          />
        )}
        {!editable && !tags.length && (
          <Label muted size={font.sm}>
            {t("No tags")}
          </Label>
        )}
      </View>
      {!!shown.length && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space[1] }}>
          <Label size={font.xs} muted selectable={false}>
            {typedKey ? t("Matching") : t("Used in this project")}
          </Label>
          {shown.map((s) => (
            <Pressable
              key={s}
              accessibilityRole="button"
              accessibilityLabel={t("Add tag {tag}", { tag: s })}
              onPress={() => {
                if (blurTimer.current) clearTimeout(blurTimer.current);
                add(s);
              }}
              style={(state) => ({
                ...noFocusRing,
                height: chipSize() - 2,
                paddingHorizontal: space[1.5],
                justifyContent: "center",
                borderRadius: radius.sm,
                backgroundColor: (state as Hoverable).hovered ? colors.surface2 : "transparent",
              })}
            >
              <Label size={font.sm} muted selectable={false}>{`#${s}`}</Label>
            </Pressable>
          ))}
        </View>
      )}
      {!!error && (
        <Label size={font.sm} color={colors.statusDanger}>
          {error}
        </Label>
      )}
      {full && editable && (
        <Label size={font.xs} muted>
          {t("A card can have at most {n} tags.", { n: tagLimits.perTask })}
        </Label>
      )}
    </View>
  );
});
