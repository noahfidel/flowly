import { memo, useState } from "react";
import { View } from "react-native";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { t } from "../shared/i18n";
import type { QueuedMessageView } from "../shared/dispatcher";
import { Button, Label, Notice, font, message, radius, relativeTime, space, useTheme } from "./ui";
import { queuedMessagesKey } from "./queries";

/**
 * Dispatcher messages queued while a card's session waits on the user, shown on its ask (DISPATCHER-SPEC §5.3, §9.4;
 * ruling, Noah 2026-11-16), with the user's "Cancel question and re-read card".
 */

/** One session's queued messages on one card, oldest first. */
export function queuedFor(list: readonly QueuedMessageView[] | undefined, taskId: string, agentId: string | null | undefined): QueuedMessageView[] {
  if (!list || !agentId) return [];
  return list.filter((m) => m.taskId === taskId && m.agentId === agentId);
}

/** Whether two lists show the same messages (for memoized rows). */
export const sameQueued = (a: readonly QueuedMessageView[], b: readonly QueuedMessageView[]) =>
  a.length === b.length && a.every((m, i) => m.id === b[i].id);

/**
 * The queued messages and the button that withdraws the ask and delivers them; nothing when none is queued. The button
 * denies only `requestId`, the pending request this banner sits on (none on a question or blocker report); the messages
 * go out once no other request of the session waits on the user (ruling, Noah 2026-11-16).
 */
export const QueuedMessages = memo(function QueuedMessages({
  taskId,
  agentId,
  requestId,
  messages,
  disabled = false,
}: {
  taskId: string;
  agentId: string;
  requestId?: string;
  messages: readonly QueuedMessageView[];
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const cancel = useRpc(rpc.asksCancelQuestion);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!messages.length) return null;
  const press = () => {
    if (busy) return;
    setBusy(true);
    setError("");
    void cancel(requestId ? { taskId, agentId, requestId } : { taskId, agentId })
      .then(
        (result) =>
          toast.show(result.delivered ? t("Queued message sent") : t("The message waits for the session's other requests"), {
            variant: result.delivered ? "success" : "info",
          }),
        (e) => setError(message(e)),
      )
      .finally(() => {
        setBusy(false);
        void queryClient.invalidateQueries({ queryKey: queuedMessagesKey });
      });
  };
  return (
    <View
      testID="queued-messages"
      style={{ gap: space[1.5], padding: space[2], borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}
    >
      <Label medium size={font.sm} selectable={false}>
        {t("Scope changed since this was asked:")}
      </Label>
      {messages.map((m) => (
        <View key={m.id} style={{ gap: 2 }}>
          <Label size={font.md} lines={8} selectable>
            {m.text}
          </Label>
          <Label muted size={font.xs} selectable={false}>
            {relativeTime(m.at)}
          </Label>
        </View>
      ))}
      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <Button small icon="RotateCcw" disabled={disabled || busy} onPress={press}>
          {t("Cancel question and re-read card")}
        </Button>
      </View>
      {!!error && <Notice>{error}</Notice>}
    </View>
  );
}, (a, b) => a.taskId === b.taskId && a.agentId === b.agentId && a.requestId === b.requestId && a.disabled === b.disabled && sameQueued(a.messages, b.messages));
