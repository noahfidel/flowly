import { memo, useState } from "react";
import { Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { Project, Review, ReviewItem, ReviewItemState, Task } from "../shared/model";
import { autoReviewRuns, outputTail } from "../shared/auto-review";
import { invalidateCardViews } from "./card-detail-query";
import { IconButton, Label, font, message, noFocusRing, space, useTheme } from "./ui";
import { t } from "../shared/i18n";

/** The review state on the card face and in the drawer header (GUARDRAILS-SPEC §7.1). */
export function reviewLabel(review: Review): string {
  switch (review.state) {
    case "running":
      return t("Reviewing");
    case "passed":
      return t("Checked");
    case "rework":
      return t("Sent back");
    case "failed":
      return t("Review failed");
    case "unavailable":
      return t("Review unavailable");
    default:
      return t("Review cancelled");
  }
}

export function reviewIcon(review: Review): string {
  return review.state === "running" ? "Loader" : review.state === "passed" ? "ShieldCheck" : review.state === "rework" ? "RotateCcw" : review.state === "failed" ? "ShieldAlert" : "CircleHelp";
}

/** phase B: `Review.tokens` (§6.4) is not on this branch's model yet. */

const seconds = (ms: number) => t("{n} s", { n: Math.max(1, Math.round(ms / 1000)) });
const compactCount = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

/** Failed first, then disputed, then what is still going, then passed or not applicable (§7.1). */
const itemRank: Record<ReviewItemState, number> = { failed: 0, disputed: 1, running: 2, queued: 3, unavailable: 4, passed: 5, na: 5, skipped: 6 };
export const sortedItems = (items: readonly ReviewItem[]) => items.map((item, index) => ({ item, index })).sort((a, b) => itemRank[a.item.state] - itemRank[b.item.state] || a.index - b.index).map((x) => x.item);

function resultText(r: ReviewItem): string {
  switch (r.state) {
    case "queued":
    case "running":
      return "";
    case "na":
      return t("Not applicable");
    case "skipped":
      return t("Skipped");
    case "disputed":
      return t("Disputed");
    case "unavailable":
      return r.timedOut ? t("Timed out") : t("Unavailable");
    case "failed":
      if (r.kind === "command") return r.exitCode === null || r.exitCode === undefined ? t("Stopped") : t("Exit {code}", { code: r.exitCode });
      return "";
    default:
      return r.kind === "command" && r.ms ? seconds(r.ms) : "";
  }
}

/** One checked item: icon, name, result; failures open with their output or evidence (§7.1). */
const ItemRow = memo(function ItemRow({ item }: { item: ReviewItem }) {
  const { colors } = useTheme();
  const evidence = item.kind === "command" ? item.tail : item.detail;
  const body = item.state === "disputed" ? item.disputeReason || item.detail : item.state === "skipped" || item.state === "unavailable" ? evidence || item.reason : evidence;
  const where = item.file ? `${item.file}${item.line ? `:${item.line}` : ""}` : "";
  // A command's detail is where it ran in a multi-repository root (GUARDRAILS-SPEC §6.3).
  const ranIn = item.kind === "command" ? item.detail : undefined;
  const more = !!body || !!where || !!item.quote || !!ranIn || (item.kind === "command" && !!item.argv);
  // Unset until the user toggles, so a row that fails while the drawer is open still opens.
  const [toggled, setOpen] = useState<boolean | null>(null);
  const open = toggled ?? item.state === "failed";
  const icon =
    item.state === "passed"
      ? { name: "CircleCheck", color: colors.statusSuccess }
      : item.state === "failed"
        ? { name: "CircleX", color: colors.statusDanger }
        : item.state === "disputed"
          ? { name: "CircleAlert", color: colors.statusWarning }
          : item.state === "running"
            ? { name: "Loader", color: colors.accent }
            : item.state === "na"
              ? { name: "CircleMinus", color: colors.foregroundMuted }
              : item.state === "unavailable"
                ? { name: "CircleHelp", color: colors.statusWarning }
                : { name: "CircleDashed", color: colors.foregroundMuted };
  const name = item.kind === "goal" ? t("Does what you asked") : item.name;
  const result = resultText(item);
  return (
    <View style={{ gap: 2 }}>
      <Pressable
        accessibilityRole={more ? "button" : undefined}
        accessibilityState={more ? { expanded: open } : undefined}
        disabled={!more}
        onPress={() => setOpen(!open)}
        style={{ ...noFocusRing, flexDirection: "row", alignItems: "center", gap: space[1.5] }}
      >
        <Icon name={icon.name} size={16} color={icon.color} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label size={font.md} lines={open ? undefined : 1}>
            {name}
          </Label>
        </View>
        {item.kind === "command" && !item.gating && (
          <Label size={font.sm} muted selectable={false}>
            {t("observing")}
          </Label>
        )}
        {!!result && (
          <Label size={font.sm} muted selectable={false}>
            {result}
          </Label>
        )}
      </Pressable>
      {open && more && (
        <View style={{ paddingLeft: 16 + space[1.5], gap: 2 }}>
          {item.kind === "command" && !!item.argv && (
            <Label size={font.sm} muted mono selectable>
              {item.argv.join(" ")}
            </Label>
          )}
          {!!ranIn && (
            <Label size={font.sm} muted selectable>
              {ranIn}
            </Label>
          )}
          {!!where && (
            <Label size={font.sm} muted mono selectable>
              {where}
            </Label>
          )}
          {!!item.quote && (
            <Label size={font.sm} muted italic selectable>
              “{item.quote}”
            </Label>
          )}
          {!!body && (
            <Label size={font.sm} muted mono={item.kind === "command" && body === item.tail} selectable>
              {item.kind === "command" && body === item.tail ? outputTail(body, 1500) : body}
            </Label>
          )}
        </View>
      )}
    </View>
  );
});

/** Whether a person can rerun the card's review now (AUTO-REVIEW-SPEC §9.2). */
export const canRerun = (task: Task, project: Project, disabled: boolean) =>
  !!task.review && !disabled && task.status === "in_review" && task.review.state !== "running" && autoReviewRuns(project);

/** Rerun the card's review; failures toast. */
export function useRerun(taskId: string) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const rerunRpc = useRpc(rpc.rerunReview);
  const [busy, setBusy] = useState(false);
  const rerun = async () => {
    setBusy(true);
    try {
      await rerunRpc({ taskId });
      await invalidateCardViews(queryClient);
    } catch (e) {
      toast.show(message(e), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };
  return { busy, rerun };
}

export function RerunButton({ taskId }: { taskId: string }) {
  const { busy, rerun } = useRerun(taskId);
  return <IconButton icon="RefreshCw" label={t("Rerun")} disabled={busy} onPress={() => void rerun()} />;
}

/**
 * The Workpad's Review group (GUARDRAILS-SPEC §7.1): the latest review's state, round and model, then every
 * checked item, failures first.
 */
export function ReviewBlock({ review }: { review: Review }) {
  const meta = [
    reviewLabel(review),
    t("Round {round}", { round: review.round }),
    review.model ?? "",
  ].filter(Boolean);
  return (
    <View style={{ gap: space[1.5] }}>
      <Label size={font.sm} muted selectable={false}>
        {meta.join(" · ")}
      </Label>
      {!!review.reason && (
        <Label size={font.sm} muted selectable>
          {review.reason}
        </Label>
      )}
      {review.shared && (
        <Label size={font.sm} muted selectable={false}>
          {t("Ran in a shared workspace, with other cards' uncommitted changes.")}
        </Label>
      )}
      {sortedItems(review.items ?? []).map((item) => (
        <ItemRow key={item.id} item={item} />
      ))}
    </View>
  );
}
