import { memo, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Label, font, noFocusRing, radius, space, touch, useTheme } from "./ui";
import { Chevron, Collapse } from "./disclosure";
import { Toggle } from "./content-card";
import { Code, DetailBox, EditLines, PathLine } from "./detail-block";
import { previewText, type ToolCallDetail } from "../shared/tool-call-detail";
import { t } from "../shared/i18n";

/**
 * Loads one tool call's details for a card session (`sessions.tool-call`, SESSION-PANE-SPEC §1.3). `scope` names the
 * session in the cache key; keep the object stable for the session.
 */
export type ToolCallLoader = { scope: string; load(callId: string, seq?: number): Promise<ToolCallDetail> };

/** Collapsed text shows this much before Show more. */
const PREVIEW_LINES = 12;
const PREVIEW_CHARS = 1_500;
/** Each side of an edit gets half the preview. */
const EDIT_LINES = 6;
const EDIT_CHARS = 750;

const toolCallKey = (scope: string, callId: string, status: string) => ["flowly", "tool-call", scope, callId, status] as const;

/**
 * A tool step of an activity block that expands to its arguments, with the result under its own collapsed
 * toggle (SESSION-PANE-SPEC §1.3). Details load on the first expand and are cached per call and status, so a call that
 * was running is read again once it finishes. All content is plain text.
 */
export const ToolStep = memo(function ToolStep({
  text,
  callId,
  seq,
  status,
  loader,
}: {
  text: string;
  callId: string;
  seq?: number;
  status?: string;
  loader: ToolCallLoader;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: toolCallKey(loader.scope, callId, status ?? ""),
    queryFn: () => loader.load(callId, seq),
    enabled: open,
    staleTime: Infinity,
    // A finished call's details replace the running ones without a loading flash.
    placeholderData: keepPreviousData,
    retry: false,
  });
  return (
    <View accessibilityLabel={t("Tool")} style={{ minWidth: 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${text}. ${open ? t("Collapse") : t("Expand")}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        hitSlop={touch ? { top: 4, bottom: 4 } : undefined}
        style={(state) => {
          const { hovered } = state as typeof state & { hovered?: boolean };
          return {
            ...noFocusRing,
            flexDirection: "row",
            alignItems: "center",
            gap: space[2],
            minWidth: 0,
            minHeight: touch ? 32 : 22,
            paddingHorizontal: space[1],
            marginHorizontal: -space[1],
            borderRadius: radius.md,
            backgroundColor: hovered || state.pressed ? colors.surface2 : "transparent",
          };
        }}
      >
        <Icon name="Wrench" size={12} color={colors.foregroundMuted} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label muted mono size={font.sm} lines={1} selectable={false}>{text}</Label>
        </View>
        <Chevron open={open} title={callId} size={12} color={colors.foregroundMuted} />
      </Pressable>
      <Collapse open={open} id={callId}>
        <View style={{ paddingTop: space[1.5], paddingBottom: space[1], paddingLeft: 12 + space[2], gap: space[1.5], minWidth: 0 }}>
          {query.data ? (
            <ToolCallBody detail={query.data} />
          ) : query.isError ? (
            <Label size={font.sm} color={colors.statusDanger}>{t("Couldn't load this tool call.")}</Label>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
              <ActivityIndicator size="small" color={colors.foregroundMuted} />
              <Label muted size={font.sm} selectable={false}>{t("Loading…")}</Label>
            </View>
          )}
        </View>
      </Collapse>
    </View>
  );
});

function ToolCallBody({ detail }: { detail: ToolCallDetail }) {
  const { colors } = useTheme();
  const [more, setMore] = useState(false);
  if (!detail.found) return <Label muted size={font.sm}>{t("This tool call is no longer in the session's timeline.")}</Label>;
  const args = detail.args !== undefined ? (more ? { text: detail.args, truncated: false } : previewText(detail.args, PREVIEW_LINES, PREVIEW_CHARS)) : undefined;
  const edits = detail.edits?.map((edit) => {
    const old = edit.old !== undefined && !more ? previewText(edit.old, EDIT_LINES, EDIT_CHARS) : undefined;
    const added = edit.new !== undefined && !more ? previewText(edit.new, EDIT_LINES, EDIT_CHARS) : undefined;
    return {
      shown: { old: old?.text ?? edit.old, new: added?.text ?? edit.new },
      truncated: !!old?.truncated || !!added?.truncated,
    };
  });
  // Show less stays once opened, even when the full text would have fit the preview.
  const canToggle = more || !!args?.truncated || !!edits?.some((e) => e.truncated);
  const hasResult = detail.result !== undefined || (detail.exitCode !== undefined && detail.exitCode !== null);
  return (
    <>
      {detail.argsMissing ? (
        <Label muted size={font.sm}>{t("This tool call's arguments aren't in the transcript.")}</Label>
      ) : (
        <View style={{ gap: space[1], minWidth: 0 }}>
          <Label muted size={font.xs} medium selectable={false}>{t("Arguments")}</Label>
          <DetailBox scroll={false}>
            {!!detail.label && <PathLine>{detail.label}</PathLine>}
            {!!edits?.length && <EditLines edits={edits.map((e) => e.shown)} />}
            {args !== undefined && <Code>{args.text}</Code>}
          </DetailBox>
          {canToggle && (
            <View style={{ alignSelf: "flex-start" }}>
              <Toggle open={more} onPress={() => setMore(!more)} />
            </View>
          )}
          {detail.argsTruncated && <ClippedNote />}
        </View>
      )}
      {!!detail.error && <Code color={colors.statusDanger}>{detail.error}</Code>}
      {hasResult && <ResultSection detail={detail} />}
    </>
  );
}

/** The result under its own toggle, collapsed by default. */
function ResultSection({ detail }: { detail: ToolCallDetail }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const result = detail.result !== undefined ? (more ? { text: detail.result, truncated: false } : previewText(detail.result, PREVIEW_LINES, PREVIEW_CHARS)) : undefined;
  const exit = detail.exitCode !== undefined && detail.exitCode !== null ? t("Exit {code}", { code: detail.exitCode }) : undefined;
  const failed = detail.resultError || (detail.exitCode !== undefined && detail.exitCode !== null && detail.exitCode !== 0);
  return (
    <View style={{ gap: space[1], minWidth: 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t("Result")}. ${open ? t("Collapse") : t("Expand")}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        hitSlop={touch ? { top: 4, bottom: 4 } : undefined}
        style={{ ...noFocusRing, flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: space[1], minHeight: touch ? 32 : 22 }}
      >
        <Chevron open={open} title="result" size={12} color={colors.foregroundMuted} />
        <Label muted size={font.xs} medium selectable={false}>{t("Result")}</Label>
        {!!exit && (
          <Label size={font.xs} color={failed ? colors.statusDanger : colors.foregroundMuted} selectable={false}>{`· ${exit}`}</Label>
        )}
      </Pressable>
      <Collapse open={open} id="result">
        {result !== undefined && (
          <View style={{ gap: space[1], minWidth: 0 }}>
            <DetailBox scroll={false}>
              <Code color={detail.resultError ? colors.statusDanger : undefined}>{result.text}</Code>
            </DetailBox>
            {(more || result.truncated) && (
              <View style={{ alignSelf: "flex-start" }}>
                <Toggle open={more} onPress={() => setMore(!more)} />
              </View>
            )}
            {detail.resultTruncated && <ClippedNote />}
          </View>
        )}
      </Collapse>
    </View>
  );
}

const ClippedNote = () => <Label muted size={font.xs}>{t("Clipped. Open the session in Paseo for the full text.")}</Label>;
