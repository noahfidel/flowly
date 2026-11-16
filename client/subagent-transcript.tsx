import { memo, useEffect, useRef, useState } from "react";
import { Animated, View } from "react-native";
import { IconButton, Label, font, space, useTheme } from "./ui";
import { SessionTranscript, type TranscriptHandle, type TranscriptNotice } from "./session-transcript";
import { RunningDots } from "./running-motion";
import { stateColors } from "./state-colors";
import { providerDetail, providerDisplayTitle } from "./subagents";
import type { PendingRequest } from "../shared/permission-question";
import type { ProviderSubagent } from "../shared/subagents";
import { t } from "../shared/i18n";

const noNotices: TranscriptNotice[] = [];
const noRequests: readonly PendingRequest[] = [];
const ignore = () => undefined;

/**
 * A provider subagent's work, read-only, in place of the session's transcript
 * and message box (SUBAGENTS-SPEC §9.4): a header with Back, the title and
 * the state · subtitle, then the session transcript's own blocks for the
 * subagent's timeline. Polls newer output every 3 s while it runs, then reads
 * once more when it stops.
 */
export const SubagentTranscript = memo(function SubagentTranscript({
  taskId,
  agentId,
  subagentId,
  subagent,
  visible,
  onBack,
}: {
  taskId: string;
  /** The parent session. */
  agentId: string;
  subagentId: string;
  /** The latest descriptor from the session's list; the last known one is kept when it drops out. */
  subagent: ProviderSubagent | undefined;
  visible: boolean;
  onBack(): void;
}) {
  const { colors } = useTheme();
  const handle = useRef<TranscriptHandle | null>(null);
  const [lift] = useState(() => new Animated.Value(0));
  const known = useRef(subagent);
  if (subagent) known.current = subagent;
  const shown = subagent ?? known.current;
  const running = shown?.status === "running";
  // Once it is no longer running: one last read, and polling stops (the transcript polls only while live).
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) handle.current?.refresh();
    wasRunning.current = running;
  }, [running]);
  return (
    <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
      <View
        style={{
          paddingHorizontal: space[2],
          paddingVertical: space[2],
          flexDirection: "row",
          alignItems: "center",
          gap: space[1],
          borderBottomWidth: 1,
          borderColor: colors.border,
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        {running && <RunningDots color={stateColors(colors).running} seed={subagentId} />}
        <IconButton icon="ArrowLeft" label={t("Back to session")} onPress={onBack} />
        <View style={{ flex: 1, minWidth: 0, paddingHorizontal: space[1] }}>
          <Label medium size={font.base} lines={1}>
            {shown ? providerDisplayTitle(shown) : t("Untitled agent")}
          </Label>
          {!!shown && (
            <Label muted size={font.xs} lines={1}>
              {providerDetail(shown)}
            </Label>
          )}
        </View>
      </View>
      <SessionTranscript
        handle={handle}
        taskId={taskId}
        agentId={agentId}
        subagent={subagentId}
        enabled={visible}
        subscribe={false}
        settled
        showOutput
        live={running}
        starting={false}
        loadingSession={false}
        notices={noNotices}
        requests={noRequests}
        requestsDisabled
        onRespond={ignore}
        lift={lift}
        inset={0}
        onStreamError={ignore}
      />
    </View>
  );
});
