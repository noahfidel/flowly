import { memo, useContext, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import {
  isInlineUiFence,
  linkBareCardIds,
  parseSessionInline,
  parseSessionMarkdown,
  type MarkdownBlock,
} from "./session-markdown";
import { Chevron, Collapse } from "./disclosure";
import { CardLinkContext, cardChipState } from "./card-links";
import { Label, noFocusRing, useTheme } from "./ui";
import { t } from "../shared/i18n";

/** A local file cannot be opened from a plugin, so pressing its link copies the absolute path. */
function localPath(url: string) {
  const file = /^file:\/\//i.test(url);
  const raw = file ? url.replace(/^file:\/\//i, "") : url;
  if (!file && !/^(\/|~\/|[A-Za-z]:[\\/])/.test(raw)) return null;
  try {
    return file ? decodeURIComponent(raw) : raw;
  } catch {
    return raw;
  }
}

const mono = Platform.OS === "ios" ? "Menlo" : "monospace";

// Memoized by its text: a transcript re-render must not re-parse unchanged messages.
const Inline = memo(function Inline({
  text,
  size = 14,
  bold = false,
}: {
  text: string;
  size?: number;
  bold?: boolean;
}) {
  const { colors } = useTheme();
  const toast = useToast();
  const [linkError, setLinkError] = useState(false);
  const cards = useContext(CardLinkContext);
  const version = cards?.version;
  // Parsed once per text; with a card resolver, bare ids of cards on the board also become chips (re-read when the board changes).
  const parts = useMemo(() => {
    const base = parseSessionInline(text);
    return cards ? linkBareCardIds(base, (id) => !!cards.resolve(id)) : base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, !!cards, version]);
  return (
    <View style={{ minWidth: 0, flexShrink: 1 }}>
      <Text
        selectable
        style={{
          color: colors.foreground,
          fontSize: size,
          lineHeight: size * 1.55,
          fontWeight: bold ? "600" : "400",
          flexShrink: 1,
        }}
      >
        {parts.map((part, index) => {
          if (part.card && cards) {
            const id = part.card.taskId,
              info = cards.resolve(id),
              state = cardChipState(info),
              title = info?.title || part.text;
            const missing = state === "missing";
            return (
              <Text
                key={index}
                accessibilityRole="link"
                accessibilityLabel={t("Open {title}", { title })}
                onPress={() =>
                  state === "project-archived"
                    ? toast.show(t("This card's project is archived."), { variant: "info" })
                    : missing
                      ? toast.show(t("This card no longer exists."), { variant: "info" })
                      : cards.open(id)
                }
                style={{
                  color: missing ? colors.foregroundMuted : colors.accent,
                  textDecorationLine: missing ? "line-through" : "underline",
                }}
              >
                {title}
                {info?.archived && <Text style={{ color: colors.foregroundMuted, textDecorationLine: "none" }}>{` (${t("archived")})`}</Text>}
              </Text>
            );
          }
          const path = part.kind === "link" ? localPath(part.url!) : null;
          const link =
            part.kind === "link" &&
            (!!path || /^https?:\/\//i.test(part.url || ""));
          return (
            <Text
              key={index}
              accessibilityRole={link ? "link" : undefined}
              onPress={
                link
                  ? () => {
                      if (path)
                        void copyText(path).then(
                          () =>
                            toast.show(t("Path copied"), {
                              variant: "success",
                            }),
                          () => setLinkError(true),
                        );
                      else
                        void openExternalUrl(part.url!).catch(() =>
                          setLinkError(true),
                        );
                    }
                  : undefined
              }
              style={{
                color: link ? colors.accent : colors.foreground,
                fontWeight: part.kind === "bold" ? "600" : undefined,
                fontStyle: part.kind === "italic" ? "italic" : undefined,
                fontFamily: part.kind === "code" ? mono : undefined,
                fontSize: part.kind === "code" ? size - 1 : undefined,
                backgroundColor:
                  part.kind === "code" ? colors.surface2 : undefined,
                textDecorationLine: link ? "underline" : undefined,
              }}
            >
              {part.text}
              {part.kind === "link" && !link ? ` (${part.url})` : ""}
            </Text>
          );
        })}
      </Text>
      {linkError && <Label muted>{t("Unable to open this link.")}</Label>}
    </View>
  );
});

/** Column width from the longest cell, so short columns stay narrow and long ones wrap. */
function columnWidth(cells: string[]) {
  const longest = Math.max(...cells.map((cell) => cell.length), 1);
  return Math.min(Math.max(longest * 8 + 24, 64), 260);
}

const TableBlock = memo(function TableBlock({
  block,
}: {
  block: Extract<MarkdownBlock, { kind: "table" }>;
}) {
  const { colors } = useTheme();
  const widths = useMemo(
    () =>
      block.headers.map((_, col) =>
        columnWidth([block.headers[col], ...block.rows.map((r) => r[col] || "")]),
      ),
    [block],
  );
  const rows = [block.headers, ...block.rows];
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ maxWidth: "100%" }}
    >
      <View
        style={{
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {rows.map((row, rowIndex) => (
          <View
            key={rowIndex}
            style={{
              flexDirection: "row",
              borderTopWidth: rowIndex ? 1 : 0,
              borderColor: colors.border,
              backgroundColor: rowIndex === 0 ? colors.surface1 : undefined,
            }}
          >
            {widths.map((width, col) => (
              <View
                key={col}
                style={{
                  width,
                  paddingHorizontal: 10,
                  paddingVertical: 7,
                  borderLeftWidth: col ? 1 : 0,
                  borderColor: colors.border,
                  alignItems:
                    block.align[col] === "right"
                      ? "flex-end"
                      : block.align[col] === "center"
                        ? "center"
                        : "flex-start",
                }}
              >
                <Inline text={row[col] || ""} size={13} bold={rowIndex === 0} />
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
});

/**
 * A ui/app fence renders live in the host session view but never here, so it
 * becomes one compact notice; expanding reveals the selectable source.
 */
const UiFenceBlock = memo(function UiFenceBlock({
  block,
}: {
  block: Extract<MarkdownBlock, { kind: "code" }>;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const notice = t("Inline UI — open in Paseo to view it live");
  return (
    <View
      style={{
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        minWidth: 0,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${notice}. ${open ? t("Collapse") : t("Expand")}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={(state) => {
          const { hovered } = state as typeof state & { hovered?: boolean };
          return {
            ...noFocusRing,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            padding: 10,
            borderRadius: 8,
            opacity: state.pressed ? 0.7 : 1,
            backgroundColor: hovered ? colors.surface2 : "transparent",
          };
        }}
      >
        <Chevron open={open} title={notice} color={colors.foregroundMuted} size={14} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label muted size={12} selectable={false}>
            {notice}
          </Label>
        </View>
      </Pressable>
      <Collapse
        open={open}
        id="ui-fence"
        style={{ paddingHorizontal: 12, paddingBottom: 12 }}
      >
        <Text
          selectable
          style={{
            color: colors.foreground,
            fontSize: 12,
            lineHeight: 19,
            fontFamily: mono,
          }}
        >
          {block.text}
        </Text>
      </Collapse>
    </View>
  );
});

export const SessionMarkdown = memo(function SessionMarkdown({ text }: { text: string }) {
  const { colors } = useTheme();
  const blocks = useMemo(() => parseSessionMarkdown(text), [text]);
  return (
    <View style={{ gap: 10, minWidth: 0, maxWidth: "100%" }}>
      {blocks.map((block, index) => {
        if (block.kind === "rule")
          return (
            <View
              key={index}
              style={{
                height: 1,
                backgroundColor: colors.border,
                marginVertical: 4,
              }}
            />
          );
        if (block.kind === "code")
          return isInlineUiFence(block.language) ? (
            <UiFenceBlock key={index} block={block} />
          ) : (
            <View
              key={index}
              style={{
                gap: 6,
                padding: 12,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
                minWidth: 0,
              }}
            >
              {!!block.language && (
                <Label muted size={11} lines={1}>
                  {block.language}
                </Label>
              )}
              <Text
                selectable
                style={{
                  color: colors.foreground,
                  fontSize: 12,
                  lineHeight: 19,
                  fontFamily: mono,
                }}
              >
                {block.text}
              </Text>
            </View>
          );
        if (block.kind === "table")
          return <TableBlock key={index} block={block} />;
        if (block.kind === "heading")
          return (
            <View key={index} style={{ paddingTop: 6 }}>
              <Inline
                text={block.text}
                bold
                size={block.level <= 2 ? 17 : 15}
              />
            </View>
          );
        if (block.kind === "quote")
          return (
            <View
              key={index}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 8,
                backgroundColor: colors.surface1,
                borderRadius: 8,
              }}
            >
              <Inline text={block.text} />
            </View>
          );
        if (block.kind === "list")
          return (
            <View
              key={index}
              style={{
                flexDirection: "row",
                gap: 8,
                paddingLeft: block.indent * 2,
                minWidth: 0,
              }}
            >
              {block.checked !== undefined ? (
                <Icon
                  name={block.checked ? "SquareCheck" : "Square"}
                  size={16}
                  color={colors.foregroundMuted}
                />
              ) : (
                <Text
                  style={{
                    color: colors.foregroundMuted,
                    fontSize: 14,
                    lineHeight: 22,
                  }}
                >
                  {/\d/.test(block.marker) ? block.marker : "•"}
                </Text>
              )}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Inline text={block.text} />
              </View>
            </View>
          );
        return <Inline key={index} text={block.text} />;
      })}
    </View>
  );
});
