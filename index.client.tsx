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
import { intentParams } from "./client/shortcuts";
import { commandItemTitle, commandItems } from "./client/command-items";
import { installDoubleTapCtrl } from "./client/double-tap-install";
import { Platform } from "react-native";
import { settingsRpc } from "@getpaseo/plugin";
import { shortcutSettings, shortcutSettingsValues } from "./shared/settings";
import { deviceLocale, setLocale, t } from "./shared/i18n";
import { loadCatalog } from "./client/catalog";
import { perfEarly, perfNow } from "./client/perf";
import { i18nCatalog } from "./shared/rpc";

/**
 * The Command Center entries; their titles follow the device language, so they are built again when its catalog
 * arrives, and View board names the double tap of Ctrl while it is on (SHORTCUTS-SPEC §5).
 */
function registerCommandItems(client: PluginClientContext, doubleTap: boolean) {
  const cleanups: (() => void)[] = [];
  // In list order: the host ranks a plugin's items by registration order. forEach, not a for loop: Hermes gives a
  // loop's `const` one binding, so every onSelect would see the last item.
  commandItems.forEach((item) =>
    cleanups.push(
      client.addCommandCenterItem({
        id: item.id,
        title: t(commandItemTitle(item, doubleTap)),
        icon: item.icon,
        keywords: item.keywords,
        context: "global",
        onSelect: ({ openScreen }) =>
          openScreen(item.intent ? { screenId: "board", params: intentParams(item.intent) } : { screenId: "board" }),
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
  // The double tap of Ctrl is on by default and only exists on the web; a read that finds it off drops the hint.
  let doubleTap = Platform.OS === "web";
  let commandItems = registerCommandItems(client, doubleTap);
  let stopped = false;
  // The bundle carries no translations: ask the daemon for the device language, then rebuild the titles.
  if (device !== "en")
    void loadCatalog((input) => client.rpc(i18nCatalog, input as { locale: Exclude<typeof device, "en"> }), device).then((ok) => {
      if (!ok || stopped) return;
      commandItems();
      commandItems = registerCommandItems(client, doubleTap);
    });
  // Double tap of Ctrl opens the board from anywhere in Paseo (web only; SHORTCUTS-SPEC §5). No read at load: the
  // setting is read about 3 s later, or when the gesture is first used.
  const stopDoubleTap = installDoubleTapCtrl({
    open: () => client.openScreen({ screenId: "board" }),
    readEnabled: () =>
      client.rpc(settingsRpc(shortcutSettings.id).read, {}).then((read) => shortcutSettingsValues(read.status === "ready" ? read.values : {}).doubleTapCtrl),
    changed: (enabled) => {
      if (stopped || enabled === doubleTap) return;
      doubleTap = enabled;
      commandItems();
      commandItems = registerCommandItems(client, doubleTap);
    },
  });
  // The Task chip, plus the Ideas chip on Flowly-managed sessions (NATIVE-SESSION-SPEC §7) and, when switched on,
  // on sessions Flowly does not manage (§12).
  const stopChips = registerSessionChips(client, undefined, undefined, { ideas: IdeasPopover, outsideIdeas: OutsideIdeasPopover });
  perfEarly("plugin.load", perfNow() - bootAt);
  return () => {
    stopped = true;
    stopChips();
    stopDoubleTap();
  };
}
