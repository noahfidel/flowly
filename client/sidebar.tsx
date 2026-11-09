import { Pressable } from "react-native";
import { LocaleRoot } from "./i18n";
import { useRpc, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { readAttentionCount } from "../shared/rpc";
import { attentionBadgeText, attentionScreenParams } from "./attention";
import { CountPill, Theme, noFocusRing } from "./ui";
import { tn } from "../shared/i18n";

/**
 * Background refresh of a tiny {count} response (the daemon decodes board and agents). Short, so the badge stays close to the board's live Attention button.
 */
const SIDEBAR_POLL_MS = 3_000;

/** Same sources and rule as the board Attention button; null while unavailable or failed. */
function useAttentionCount() {
  const count = useRpc(readAttentionCount);
  const badge = useQuery({ queryKey: ["flowly", "attention-count"], queryFn: () => count({}),
    refetchInterval: SIDEBAR_POLL_MS, retry: 1 });
  return badge.isError ? null : badge.data?.count ?? null;
}

export function SidebarEntry(props: PluginSidebarItemProps) {
  return (
    <LocaleRoot>
      <SidebarEntryRow {...props} />
    </LocaleRoot>
  );
}

function SidebarEntryRow({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  const count = useAttentionCount();
  const text = attentionBadgeText(count);
  return (
    <SidebarRow
      icon="PanelsTopLeft"
      active={currentScreen?.screenId === "board"}
      onPress={() => openScreen({ screenId: "board" })}
      trailing={
        text ? (
          <Theme.Provider value={theme}>
            <Pressable style={noFocusRing}
              accessibilityRole="button"
              accessibilityLabel={tn(count ?? 0, "Open Needs attention, {text} item", "Open Needs attention, {text} items", { text })}
              hitSlop={10}
              onPress={() =>
                openScreen({
                  screenId: "board",
                  params: attentionScreenParams(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
                })
              }
            >
              <CountPill text={text} />
            </Pressable>
          </Theme.Provider>
        ) : null
      }
    />
  );
}
