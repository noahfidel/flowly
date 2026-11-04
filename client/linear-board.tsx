import { memo, useMemo, useState, type ReactNode } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useRpc, type PluginOpenScreenInput, type PluginScreenProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { familyOf } from "../shared/connectors";
import { groupIssues, type LinearBoardRow, type LinearColumn } from "../shared/linear-board";
import { LocaleRoot } from "./i18n";
import { MotionProvider } from "./motion";
import { useBoardView } from "./board-view";
import { ItemPreview, externalError, useConnections } from "./connectors";
import { LinearMark } from "./brand-icons";
import { linearOpenParams, linearStartParams } from "./linear-start";
import { isCompactLayout } from "./geometry";
import { useStableCallback, useStableTheme } from "./stable";
import { Badge, Button, Choices, IconButton, Label, Notice, Row, Theme, font, noFocusRing, radius, space, useTheme } from "./ui";
import { msg, t } from "../shared/i18n";

/**
 * The Linear board in Paseo's main bar (LINEAR-BOARD-SPEC): the user's Linear issues by state type,
 * as columns or one list, with Start card / Open card into Flowly. Nothing here writes to Linear.
 */

type OpenScreen = (input: PluginOpenScreenInput) => void;

const columnTitles: Record<LinearColumn, string> = {
  backlog: msg("Backlog"),
  unstarted: msg("Todo"),
  started: msg("In progress"),
  completed: msg("Done"),
  canceled: msg("Canceled"),
};

const requestId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const isLinear = (provider: string) => familyOf(provider as Parameters<typeof familyOf>[0]) === "linear";

/** Shown only while a Linear connection exists (LINEAR-BOARD-SPEC §2). */
export function LinearSidebarEntry(props: PluginSidebarItemProps) {
  return (
    <LocaleRoot>
      <LinearSidebarRow {...props} />
    </LocaleRoot>
  );
}

function LinearSidebarRow({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const connections = useConnections();
  if (!connections.data?.connections.some((c) => isLinear(c.provider))) return null;
  return <SidebarRow icon={LinearMark} active={currentScreen?.screenId === "linear"} onPress={() => openScreen({ screenId: "linear" })} />;
}

/** The screen; `openScreen` comes from the plugin context, since screens are not handed one. */
export function linearScreen(openScreen: OpenScreen) {
  return function LinearScreen(props: PluginScreenProps) {
    const theme = useStableTheme(props.theme);
    return (
      <LocaleRoot>
        <MotionProvider>
          <Theme.Provider value={theme}>
            <LinearBoard compact={props.layout.compact} openScreen={openScreen} />
          </Theme.Provider>
        </MotionProvider>
      </LocaleRoot>
    );
  };
}

function LinearBoard({ compact: hostCompact, openScreen }: { compact: boolean; openScreen: OpenScreen }) {
  const { colors } = useTheme();
  const width = useWindowDimensions().width;
  const compact = hostCompact || isCompactLayout(width);
  const view = useBoardView();
  const connections = useConnections();
  const linear = useMemo(() => (connections.data?.connections || []).filter((c) => isLinear(c.provider)), [connections.data]);
  const remembered = view.values?.lastConnections.linear || "";
  const connection = linear.find((c) => c.id === remembered) || linear[0];
  const readTeams = useRpc(rpc.linearTeams),
    readBoard = useRpc(rpc.linearBoard),
    readItem = useRpc(rpc.readExternalItem);
  const teams = useQuery({
    queryKey: ["flowly", "linear-teams", connection?.id ?? ""],
    queryFn: () => readTeams({ connectionId: connection!.id }),
    enabled: !!connection,
    staleTime: 10 * 60_000,
    retry: false,
  });
  const stored = view.values?.linearScope || "me";
  // A team the key no longer sees falls back to Assigned to me.
  const teamId = stored === "me" || (teams.data && !teams.data.teams.some((x) => x.id === stored)) ? undefined : stored;
  const recentDays = view.values?.hideFinishedAfterDays ?? 14;
  const board = useQuery({
    queryKey: ["flowly", "linear-board", connection?.id ?? "", teamId ?? "me", recentDays],
    queryFn: () => readBoard({ connectionId: connection!.id, ...(teamId ? { teamId } : {}), recentDays }),
    enabled: !!connection && !!view.values,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const groups = useMemo(() => groupIssues(board.data?.issues || []), [board.data]);
  const layoutChoice = view.values?.linearLayout || "auto";
  const layout = layoutChoice === "auto" ? (compact ? "list" : "board") : layoutChoice;
  const [scopeOpen, setScopeOpen] = useState(false);
  const [previewing, setPreviewing] = useState<LinearBoardRow | null>(null);

  const startCard = useStableCallback((issue: LinearBoardRow) => {
    if (!connection) return;
    setPreviewing(null);
    openScreen({ screenId: "board", params: linearStartParams({ connectionId: connection.id, key: issue.key }, requestId()) });
  });
  const openCard = useStableCallback((issue: LinearBoardRow) => {
    if (!issue.card) return;
    setPreviewing(null);
    openScreen({ screenId: "board", params: linearOpenParams(issue.card, requestId()) });
  });
  const preview = useStableCallback((issue: LinearBoardRow) => setPreviewing(issue));
  const act = useStableCallback((issue: LinearBoardRow) => (issue.card ? openCard(issue) : startCard(issue)));
  const chooseScope = (next: string) => {
    setScopeOpen(false);
    if (next !== stored) void view.update({ linearScope: next });
  };
  const chooseConnection = (id: string) => {
    if (view.values && id !== remembered) void view.update({ lastConnections: { ...view.values.lastConnections, linear: id } });
  };
  const refresh = () => {
    void board.refetch();
    void teams.refetch();
  };

  if (connections.isPending) return <Page><Label muted>{t("Loading…")}</Label></Page>;
  if (!connection)
    return (
      <Page>
        <Notice tone="info">{t("Add a Linear connection in Flowly → Settings → Connections.")}</Notice>
        <View style={{ flexDirection: "row" }}>
          <Button onPress={() => openScreen({ screenId: "board" })}>{t("Open Flowly")}</Button>
        </View>
      </Page>
    );

  const team = teamId ? teams.data?.teams.find((x) => x.id === teamId) : undefined;
  const scopeLabel = team ? `${team.key} · ${team.name}` : t("Assigned to me");
  const total = board.data?.issues.length ?? 0;
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space[4], gap: space[3] }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space[2] }}>
        <Label bold size={font.lg} selectable={false}>Linear</Label>
        <View style={{ flex: 1 }} />
        <Button small icon="ChevronDown" onPress={() => setScopeOpen((open) => !open)} label={t("Scope: {scope}", { scope: scopeLabel })}>
          {scopeLabel}
        </Button>
        <Button small icon={layout === "board" ? "List" : "Columns3"} onPress={() => void view.update({ linearLayout: layout === "board" ? "list" : "board" })}>
          {layout === "board" ? t("List") : t("Board")}
        </Button>
        <IconButton icon="RefreshCw" label={t("Refresh")} disabled={board.isFetching} onPress={refresh} />
      </View>
      {linear.length > 1 && (
        <Choices title={t("Connection")} hideTitle value={connection.id} options={linear.map((c) => ({ value: c.id, label: c.name }))} onChange={chooseConnection} />
      )}
      {scopeOpen && (
        <View style={{ padding: space[1], gap: 2, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border }}>
          <Row title={t("Assigned to me")} icon="User" selected={!teamId} onPress={() => chooseScope("me")} />
          {teams.isPending ? (
            <Label muted size={font.sm}>{t("Loading…")}</Label>
          ) : teams.error ? (
            <Notice tone="warning">{externalError(teams.error, "linear")}</Notice>
          ) : (
            (teams.data?.teams || []).map((x) => <Row key={x.id} title={`${x.key} · ${x.name}`} icon="Users" selected={x.id === teamId} onPress={() => chooseScope(x.id)} />)
          )}
        </View>
      )}
      {board.isPending ? (
        <Label muted>{t("Loading…")}</Label>
      ) : board.error ? (
        <Notice tone="warning">{externalError(board.error, "linear")}</Notice>
      ) : total === 0 ? (
        <Label muted>{t("No issues in this view.")}</Label>
      ) : layout === "board" ? (
        <ScrollView horizontal contentContainerStyle={{ gap: space[3], alignItems: "flex-start" }}>
          {groups.map((g) => (
            <View key={g.column} style={{ width: 272, gap: space[2] }}>
              <ColumnHeader column={g.column} count={g.issues.length} />
              {g.issues.map((issue) => (
                <IssueCard key={issue.key} issue={issue} column={g.column} onPress={preview} onAct={act} />
              ))}
            </View>
          ))}
        </ScrollView>
      ) : (
        <View style={{ gap: space[3] }}>
          {groups.map((g) => (
            <View key={g.column} style={{ gap: space[1] }}>
              <ColumnHeader column={g.column} count={g.issues.length} />
              {g.issues.map((issue) => (
                <IssueCard key={issue.key} issue={issue} column={g.column} onPress={preview} onAct={act} />
              ))}
            </View>
          ))}
        </View>
      )}
      {board.data?.truncated && <Label muted size={font.sm}>{t("Showing the {n} most recently updated issues.", { n: total })}</Label>}
      {previewing && (
        <ItemPreview
          title={`${previewing.key} ${previewing.title}`}
          family="linear"
          url={previewing.url}
          queryKey={`linear:${connection.id}:${previewing.key}`}
          read={(again) => readItem({ connectionId: connection.id, key: previewing.key, itemType: "issue", refresh: again })}
          actions={
            previewing.card ? (
              <Button small primary icon="PanelsTopLeft" onPress={() => openCard(previewing)}>
                {t("Open card")}
              </Button>
            ) : (
              <Button small primary icon="Play" onPress={() => startCard(previewing)}>
                {t("Start card")}
              </Button>
            )
          }
          onClose={() => setPreviewing(null)}
        />
      )}
    </ScrollView>
  );
}

function Page({ children }: { children: ReactNode }) {
  return <View style={{ padding: space[4], gap: space[3] }}>{children}</View>;
}

function ColumnHeader({ column, count }: { column: LinearColumn; count: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5], paddingHorizontal: space[1] }}>
      <Label bold size={font.sm} selectable={false}>{t(columnTitles[column])}</Label>
      <Label muted size={font.sm} selectable={false}>{String(count)}</Label>
    </View>
  );
}

/** One issue: key, state when it is a custom one, title, priority, assignee, and the card marker. */
const IssueCard = memo(function IssueCard({
  issue,
  column,
  onPress,
  onAct,
}: {
  issue: LinearBoardRow;
  column: LinearColumn;
  onPress(issue: LinearBoardRow): void;
  onAct(issue: LinearBoardRow): void;
}) {
  const { colors } = useTheme();
  const customState = issue.stateName && issue.stateName.toLowerCase() !== columnTitles[column].toLowerCase() ? issue.stateName : "";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: space[1],
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Preview {key}: {title}", { key: issue.key, title: issue.title })}
        onPress={() => onPress(issue)}
        style={[noFocusRing, { flex: 1, minWidth: 0, padding: space[2], gap: space[1] }]}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
          <Label muted medium size={font.sm} selectable={false}>{issue.key}</Label>
          {!!customState && <Label muted size={font.sm} lines={1} selectable={false}>{customState}</Label>}
        </View>
        <Label size={font.md} lines={2} selectable={false}>{issue.title}</Label>
        {(!!issue.priorityLabel || !!issue.assignee || !!issue.card) && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space[1.5] }}>
            {!!issue.priorityLabel && <Badge>{issue.priorityLabel}</Badge>}
            {!!issue.assignee && <Label muted size={font.sm} lines={1} selectable={false}>{issue.assignee}</Label>}
            {!!issue.card && <Badge color={colors.accent}>{t("Card")}</Badge>}
          </View>
        )}
      </Pressable>
      <IconButton
        icon={issue.card ? "PanelsTopLeft" : "Play"}
        size={32}
        label={issue.card ? t("Open card {title}", { title: issue.card.title }) : t("Start card from {key}", { key: issue.key })}
        onPress={() => onAct(issue)}
      />
    </View>
  );
});
