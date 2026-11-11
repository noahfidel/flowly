import { useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { t } from "../shared/i18n";
import { Button, IconButton, Label, Notice, font, message, space, verticalContent, verticalScroll, useTheme } from "./ui";
import { AskRow } from "./dispatcher-asks";
import { dispatcherStartMessage } from "./start-again";
import { dispatcherStatusKey } from "./dispatcher-panel";
import { stepBarState, type AskItem, type ChangeItem, type StepKind } from "./step-through";

type Position = { index: number | null; total: number; prev: string | null; next: string | null };

/**
 * The step-through on top of the card sidebar (DISPATCHER-SPEC §9.4; Ruling, Noah 2026-11-09). Need you: "1 of N" with
 * ‹ Prev / Next ›, the card's asks pinned below, answered in place. Once its asks are answered the card stays and Next
 * is offered; nothing moves by itself. Updated: the same walk over the changed cards, with Mark seen and Ask dispatcher.
 */
export function StepThroughBar({
  kind,
  position,
  onPrev,
  onNext,
  onEnd,
  asks,
  asksLoading,
  onOpenCard,
  onChanged,
  change,
  onAskedDispatcher,
  groupId,
}: {
  kind: StepKind;
  position: Position;
  onPrev(): void;
  onNext(): void;
  onEnd(): void;
  /** Need you: the shown card's asks, pinned. */
  asks: readonly AskItem[];
  asksLoading: boolean;
  onOpenCard(taskId: string): void;
  /** An ask answered or dismissed, or the updates marked seen: read again. */
  onChanged(): void;
  /** Updated: the change line (Mark seen needs its revision). */
  change: ChangeItem | null;
  /** Ask dispatcher was sent: the dock opens on the chat. */
  onAskedDispatcher(): void;
  /** The board group whose dispatcher Mark seen and Ask dispatcher reach (DISPATCHER-SPEC §0); null: both are off. */
  groupId: string | null;
}) {
  const { colors } = useTheme();
  const bar = stepBarState(kind, position);
  const title = kind === "needs" ? t("Needs you") : t("Updates");
  const where =
    bar.where === "position"
      ? t("{index} of {total}", { index: position.index! + 1, total: position.total })
      : bar.where === "answered"
        ? t("Answered")
        : bar.where === "caught-up"
          ? t("All caught up")
          : "";
  return (
    <View style={{ flexShrink: 0, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[1], paddingLeft: space[3], paddingRight: space[2], paddingVertical: space[1.5], minWidth: 0 }}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline", gap: space[2] }}>
          <Label medium size={font.md} lines={1} selectable={false}>
            {title}
          </Label>
          <Label muted size={font.sm} lines={1} selectable={false}>
            {where}
          </Label>
        </View>
        <IconButton icon="ChevronLeft" label={t("Previous card")} disabled={!position.prev} onPress={onPrev} />
        {bar.next === "pill" ? (
          <Button small primary onPress={onNext}>
            {t("Next card")}
          </Button>
        ) : bar.next === "done" ? (
          <Button small onPress={onEnd}>
            {t("Done")}
          </Button>
        ) : (
          <IconButton icon="ChevronRight" label={t("Next card")} disabled={!position.next} onPress={onNext} />
        )}
      </View>
      {kind === "needs" ? (
        asksLoading && !asks.length ? (
          <View style={{ paddingBottom: space[3], alignItems: "center" }}>
            <ActivityIndicator size="small" color={colors.foregroundMuted} />
          </View>
        ) : asks.length ? (
          <ScrollView {...verticalScroll} style={{ maxHeight: 320 }} contentContainerStyle={{ ...verticalContent, paddingHorizontal: space[3], paddingBottom: space[3], gap: space[2] }}>
            {asks.map((ask) => (
              <AskRow key={ask.signal} item={ask} focused={false} onOpenCard={onOpenCard} onChanged={onChanged} />
            ))}
          </ScrollView>
        ) : null
      ) : (
        <UpdatedActions change={change} onChanged={onChanged} onAsked={onAskedDispatcher} groupId={groupId} />
      )}
    </View>
  );
}

/** Mark seen (every changed card, `dispatcher.mark-seen`) and Ask dispatcher (`dispatcher.what-next`, §9.2). */
function UpdatedActions({ change, onChanged, onAsked, groupId }: { change: ChangeItem | null; onChanged(): void; onAsked(): void; groupId: string | null }) {
  const markSeen = useRpc(rpc.dispatcherMarkSeen);
  const whatNext = useRpc(rpc.dispatcherWhatNext);
  const readStatus = useRpc(rpc.dispatcherStatus);
  // The dispatcher chat's own status read (shared key): an unguarded one takes no messages from the user (§3).
  const status = useQuery({
    queryKey: [...dispatcherStatusKey, groupId ?? "-"],
    queryFn: () => readStatus({ groupId: groupId! }),
    enabled: !!groupId,
    refetchInterval: groupId ? 5_000 : false,
    placeholderData: (p) => p,
  });
  const up = status.data?.state === "running" || status.data?.state === "idle";
  const locked = up && !!status.data?.unguarded;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = (job: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError("");
    void job()
      .then(
        () => {
          onChanged();
          after?.();
        },
        (e) => setError(dispatcherStartMessage(message(e))),
      )
      .finally(() => setBusy(false));
  };
  return (
    <View style={{ paddingHorizontal: space[3], paddingBottom: space[2], gap: space[2] }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
        <Button small disabled={busy || !change || !groupId} onPress={() => change && groupId && run(() => markSeen({ groupId, revision: change.revision, ids: change.ids }))}>
          {t("Mark seen")}
        </Button>
        <Button small primary disabled={busy || locked || !groupId} onPress={() => groupId && run(() => whatNext({ groupId }), onAsked)}>
          {t("Ask dispatcher")}
        </Button>
      </View>
      {!!error && <Notice>{error}</Notice>}
    </View>
  );
}
