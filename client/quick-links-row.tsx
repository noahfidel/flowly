import { memo, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { openExternalUrl } from "@getpaseo/plugin/client";
import type { Artifact } from "../shared/model";
import { artifactsOf } from "../shared/artifacts";
import { withoutPlan } from "../shared/plans";
import { msg, t, tn } from "../shared/i18n";
import { useTaskDetail } from "./card-detail-query";
import { ArtifactPreview, useExternalStatuses } from "./task-artifacts";
import { ExternalPreview } from "./connectors";
import { Label, font, radius, space, tint, touch, useTheme, noFocusRing } from "./ui";
import { stateColors } from "./state-colors";
import { quickLinks, type PrState, type QuickChip, type QuickSession, type QuickSessionState } from "./quick-links";

const prText: Record<Exclude<PrState, "">, string> = {
  draft: msg("{number} · Draft"),
  open: msg("{number} · Open"),
  merged: msg("{number} · Merged"),
  closed: msg("{number} · Closed"),
};
const sessionStateText: Record<QuickSessionState, string> = {
  waiting: msg("Waiting"),
  running: msg("Running"),
  error: msg("Error"),
  done: msg("Done"),
};

/** Opens a link in the browser; a failure shows a toast. Shared by the PR chip and the R shortcut. */
export function openQuickLink(url: string, toast: ReturnType<typeof useToast>): void {
  void openExternalUrl(url).catch(() => toast.show(t("Could not open the link."), { variant: "error" }));
}

/**
 * Card home quick links (DRAWER-SPEC "Quick links"): the card's PRs, sessions and outputs as one wrapped row of chips
 * under the header, so none needs a scroll down to Sessions or Artifacts. Renders nothing when there is nothing to show.
 */
export const QuickLinks = memo(
  function QuickLinks({
    taskId,
    sessions,
    onOpenSession,
    onMore,
  }: {
    taskId: string;
    /** The card's main, non-archived sessions. Compared by content. */
    sessions: readonly QuickSession[];
    onOpenSession(id: string): void;
    /** Opens and scrolls to that section. */
    onMore(section: "sessions" | "artifacts"): void;
  }) {
    const { detail } = useTaskDetail();
    const toast = useToast();
    const [previewing, setPreviewing] = useState<Artifact | null>(null);
    const list = useMemo(() => (detail ? withoutPlan(artifactsOf(detail.artifacts, taskId)) : []), [detail, taskId]);
    const external = useExternalStatuses(taskId, list);
    const prStatus = useMemo(() => new Map((external.data?.items || []).map((x) => [x.artifactId, x.summary.status])), [external.data]);
    const chips = useMemo(() => quickLinks({ outputs: list.filter((a) => a.role === "output"), sessions, prStatus }), [list, sessions, prStatus]);
    if (!chips.length) return null;
    const openUrl = (url: string) => openQuickLink(url, toast);
    const press = (chip: QuickChip) => {
      if (chip.kind === "pr") return openUrl(chip.url);
      if (chip.kind === "session") return onOpenSession(chip.id);
      if (chip.kind === "more") return onMore(chip.section);
      const a = chip.artifact;
      if (!a.external && a.kind === "url") return openUrl(a.target);
      setPreviewing(a);
    };
    return (
      <>
        <View testID="quick-links" accessibilityLabel={t("Quick links")} style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1.5] }}>
          {chips.map((chip) => (
            <Chip key={chip.kind === "more" ? `more:${chip.section}` : `${chip.kind}:${chip.id}`} chip={chip} onPress={press} />
          ))}
        </View>
        {previewing &&
          (previewing.external ? (
            <ExternalPreview artifact={previewing} onClose={() => setPreviewing(null)} />
          ) : (
            <ArtifactPreview artifact={previewing} onClose={() => setPreviewing(null)} />
          ))}
      </>
    );
  },
  (a, b) =>
    a.taskId === b.taskId &&
    a.onOpenSession === b.onOpenSession &&
    a.onMore === b.onMore &&
    a.sessions.length === b.sessions.length &&
    a.sessions.every((s, i) => {
      const o = b.sessions[i]!;
      return s.id === o.id && s.title === o.title && s.state === o.state && s.createdAt === o.createdAt;
    }),
);

function chipText(chip: QuickChip): string {
  switch (chip.kind) {
    case "pr":
      return chip.state ? t(prText[chip.state], { number: chip.number }) : chip.number;
    case "session":
      return `${chip.title || t("Session {n}", { n: chip.number })} · ${t(sessionStateText[chip.state])}`;
    case "output":
      return chip.title;
    case "more":
      return tn(chip.count, "+{n} more", "+{n} more");
  }
}

function chipLabel(chip: QuickChip, text: string): string {
  switch (chip.kind) {
    case "pr":
      return chip.title ? t("Open pull request {label}: {title}", { label: text, title: chip.title }) : t("Open pull request {label}", { label: text });
    case "session":
      return t("Open session {label}", { label: text });
    case "output":
      return t("Open output {title}", { title: chip.title });
    case "more":
      return chip.section === "sessions"
        ? tn(chip.count, "Show {n} more sessions", "Show {n} more sessions")
        : tn(chip.count, "Show {n} more outputs", "Show {n} more outputs");
  }
}

function Chip({ chip, onPress }: { chip: QuickChip; onPress(chip: QuickChip): void }) {
  const { colors } = useTheme();
  const tones = stateColors(colors);
  // A session waiting on the user gets the card's Needs-you colour (UI-REFRESH-SPEC status colours).
  const waiting = chip.kind === "session" && chip.state === "waiting";
  const tone =
    chip.kind === "session"
      ? chip.state === "waiting"
        ? tones.needsYou
        : chip.state === "running"
          ? tones.running
          : chip.state === "error"
            ? tones.error
            : colors.foregroundMuted
      : chip.kind === "pr"
        ? chip.state === "merged"
          ? tones.unread
          : chip.state === "open"
            ? tones.running
            : colors.foregroundMuted
        : colors.foregroundMuted;
  const icon =
    chip.kind === "pr"
      ? chip.state === "merged"
        ? "GitMerge"
        : chip.state === "closed"
          ? "GitPullRequestClosed"
          : chip.state === "draft"
            ? "GitPullRequestDraft"
            : "GitPullRequest"
      : chip.kind === "session"
        ? waiting
          ? "MessageCircleQuestion"
          : "MessageSquare"
        : chip.kind === "output"
          ? chip.file
            ? "FileText"
            : "Link"
          : "ChevronDown";
  const text = chipText(chip);
  const external = chip.kind === "pr" || (chip.kind === "output" && !chip.file && !chip.artifact.external);
  return (
    <Pressable
      accessibilityRole={external ? "link" : "button"}
      accessibilityLabel={chipLabel(chip, text)}
      onPress={() => onPress(chip)}
      style={(state) => {
        const { pressed, hovered, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[1],
          maxWidth: "100%",
          height: touch ? 36 : 26,
          paddingHorizontal: space[2],
          borderRadius: radius.md,
          borderWidth: 1,
          // Keyboard focus draws the accent border (the browser outline is off for every Pressable).
          borderColor: focused ? colors.accent : waiting ? tint(tones.needsYou, 0.5) : colors.border,
          backgroundColor: waiting
            ? tint(tones.needsYou, hovered || pressed ? 0.16 : 0.08)
            : hovered || pressed
              ? colors.surface2
              : colors.surface0,
        };
      }}
    >
      <Icon name={icon} size={13} color={tone} />
      {/* A long title is cut, so one chip never takes the whole row; the full text is in the label. */}
      <View style={{ flexShrink: 1, minWidth: 0, maxWidth: 220 }}>
        <Label size={font.sm} medium lines={1} selectable={false} color={waiting ? tones.needsYou : undefined}>
          {text}
        </Label>
      </View>
    </Pressable>
  );
}
