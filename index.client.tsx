import { bootAt } from "./client/boot";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BoardScreen, WorkspaceBoard } from "./client/board";
import { registerSessionChips } from "./client/session-link";
import { NativeSummaryItem } from "./client/summary-row";
import { IdeasPopover, OutsideIdeasPopover } from "./client/native-popovers";
import { NativeNextMovesItem } from "./client/next-move-card";
import { nextRowKind, nextRowSchema, nextRowVersion, summaryRowKind, summaryRowSchema, summaryRowVersion } from "./shared/native-session";
import { SidebarEntry } from "./client/sidebar";
import { LinearSidebarEntry, linearScreen } from "./client/linear-board";
import { intentParams, type BoardIntent } from "./client/shortcuts";
import { deviceLocale, msg, setLocale, t } from "./shared/i18n";
import { loadCatalog } from "./client/catalog";
import { perfEarly, perfNow } from "./client/perf";
import { i18nCatalog } from "./shared/rpc";

// Flowly's Command Center items are Open Flowly plus these two (QUICK-TASK-SPEC §7). The other board intents
// (new task, projects, search, filters, shortcuts, welcome) stay reachable on the board and as screen params.
const intentItems: { intent: BoardIntent; title: string; icon: string; keywords: string[] }[] = [
  { intent: "attention", title: msg("Flowly: Needs attention"), icon: "Bell", keywords: ["kanban", "attention", "unread", "approval"] },
  { intent: "quick-task", title: msg("Flowly: Quick task"), icon: "Zap", keywords: ["kanban", "card", "create", "task", "agent", "quick"] },
];

/** The Command Center entries; their titles follow the device language, so they are built again when its catalog arrives. */
function registerCommandItems(client: PluginClientContext) {
  const cleanups: (() => void)[] = [];
  cleanups.push(
    client.addCommandCenterItem({
      id: "open-board",
      title: t("Open Flowly"),
      icon: "PanelsTopLeft",
      context: "global",
      onSelect: ({ openScreen }) => openScreen({ screenId: "board" }),
    }),
  );
  // forEach, not a for loop: Hermes gives a loop's `const` one binding, so every onSelect would see the last item.
  intentItems.forEach((item) =>
    cleanups.push(
      client.addCommandCenterItem({
        id: `board-${item.intent}`,
        title: t(item.title),
        icon: item.icon,
        keywords: item.keywords,
        context: "global",
        onSelect: ({ openScreen }) =>
          openScreen({ screenId: "board", params: intentParams(item.intent) }),
      }),
    ),
  );
  return () => cleanups.forEach((cleanup) => cleanup());
}

export default function contribute(client: PluginClientContext) {
  // Command Center entries are registered once, before any setting can be read: they follow the device language.
  const device = deviceLocale();
  setLocale(device);
  client.addScreen({
    id: "board",
    title: "Flowly",
    Component: BoardScreen,
  });
  client.addSidebarHeaderItem({
    id: "board",
    title: "Flowly",
    Component: SidebarEntry,
  });
  // The Linear board in the main bar (LINEAR-BOARD-SPEC §2); its row shows only with a Linear connection.
  client.addScreen({
    id: "linear",
    title: "Linear",
    Component: linearScreen((input) => client.openScreen(input)),
  });
  client.addSidebarHeaderItem({
    id: "linear",
    title: "Linear",
    Component: LinearSidebarEntry,
  });
  client.addWorkspacePanel({
    id: "board",
    title: "Flowly",
    icon: "PanelsTopLeft",
    context: "workspace",
    Component: WorkspaceBoard,
  });
  // The progress summary as a row in Paseo's own timeline (NATIVE-SESSION-SPEC §5).
  client.addTimelineRenderer({
    kind: summaryRowKind,
    version: summaryRowVersion,
    schema: summaryRowSchema,
    Component: NativeSummaryItem,
  });
  // This turn's suggested next steps as a card under the agent's last reply (NATIVE-SESSION-SPEC §6).
  client.addTimelineRenderer({
    kind: nextRowKind,
    version: nextRowVersion,
    schema: nextRowSchema,
    Component: NativeNextMovesItem,
  });
  let commandItems = registerCommandItems(client);
  let stopped = false;
  // The bundle carries no translations: ask the daemon for the device language, then rebuild the titles.
  if (device !== "en")
    void loadCatalog((input) => client.rpc(i18nCatalog, input as { locale: Exclude<typeof device, "en"> }), device).then((ok) => {
      if (!ok || stopped) return;
      commandItems();
      commandItems = registerCommandItems(client);
    });
  // The Task chip, plus the Ideas chip on Flowly-managed sessions (NATIVE-SESSION-SPEC §7) and, when switched on,
  // on sessions Flowly does not manage (§12).
  const stopChips = registerSessionChips(client, undefined, undefined, { ideas: IdeasPopover, outsideIdeas: OutsideIdeasPopover });
  perfEarly("plugin.load", perfNow() - bootAt);
  return () => {
    stopped = true;
    stopChips();
  };
}
