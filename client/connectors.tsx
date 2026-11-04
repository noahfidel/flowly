import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Linking, View } from "react-native";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { Artifact } from "../shared/model";
import {
  classifyQuery,
  connectorFamilies,
  familyOf,
  familyProviders,
  itemTypeOf,
  providerInfo,
  type Connection,
  type ConnectorFamily,
  type ConnectorProvider,
  type ExternalSummary,
  type ItemType,
} from "../shared/connectors";
import { boardViewSettings, boardViewValues } from "../shared/settings";
import { Modal } from "./modal";
import { SessionMarkdown } from "./session-content";
import { boardKey } from "./queries";
import { useStableCallback } from "./stable";
import { SettingRow, SettingsGroup, SettingsPage } from "./settings-ui";
import { Actions, Badge, Button, Choices, Field, IconButton, Label, Notice, Row, Theme, font, message, radius, relativeTime, space, useTheme } from "./ui";
import { msg, t, tn } from "../shared/i18n";
import { BrandIcon } from "./brand-icons";

/**
 * External items as read-only card inputs (CONNECTORS-SPEC, EXTERNAL-TRACKER-SPEC):
 * the connections settings page, the item picker used by New task and by the
 * drawer, and the item preview. Nothing here writes to any service.
 */

export const connectionsKey = ["flowly", "connections"] as const;

export function useConnections(enabled = true) {
  const list = useRpc(rpc.listConnections);
  return useQuery({ queryKey: connectionsKey, queryFn: () => list({}), enabled, staleTime: 60_000, retry: false });
}

/** Service names are brands: shown as written in every language. */
export const familyNames: Record<ConnectorFamily, string> = { jira: "Jira", confluence: "Confluence", github: "GitHub", gitlab: "GitLab", azure: "Azure DevOps", linear: "Linear" };

/** The row icon of an item: its kind, not its service. */
export function itemIcon(provider: ConnectorProvider, itemType: ItemType) {
  if (itemType === "page") return "BookOpen";
  if (itemType === "pull" || itemType === "merge_request") return "GitPullRequest";
  const family = familyOf(provider);
  return family === "jira" ? "Ticket" : family === "azure" ? "ClipboardList" : "CircleDot";
}

/** "Jira ticket", "GitLab merge request", for row details. */
export function itemKindLabel(provider: ConnectorProvider, itemType: ItemType) {
  const family = familyOf(provider);
  if (family === "jira") return t("Jira ticket");
  if (family === "confluence") return t("Confluence page");
  if (family === "azure") return t("Azure DevOps work item");
  const service = familyNames[family];
  if (itemType === "pull") return t("{service} pull request", { service });
  if (itemType === "merge_request") return t("{service} merge request", { service });
  return t("{service} issue", { service });
}

/** The + menu entry and picker title per service (CONNECTORS-SPEC §8.1). */
export const linkTitles: Record<ConnectorFamily, string> = {
  jira: msg("Jira ticket"),
  confluence: msg("Confluence page"),
  github: msg("GitHub issue or pull request"),
  gitlab: msg("GitLab issue or merge request"),
  azure: msg("Azure DevOps work item"),
  linear: msg("Linear issue"),
};

const searchHints: Record<ConnectorFamily, string> = {
  jira: msg("Ticket number, link or words from the title"),
  confluence: msg("Page link, id or words from the title"),
  github: msg("owner/repo#12, #12, a link or words from the title"),
  gitlab: msg("group/project!34, #12, !34, a link or words from the title"),
  azure: msg("Work item number, AB#123, a link or words from the title"),
  linear: msg("ENG-123, a link or words from the title"),
};

const recentTitles: Record<ConnectorFamily, string> = {
  jira: msg("My recent tickets"),
  confluence: msg("Pages I viewed or edited recently"),
  github: msg("Open issues and pull requests I'm involved in"),
  gitlab: msg("Open issues and merge requests assigned to me or awaiting my review"),
  azure: msg("Open work items assigned to me"),
  linear: msg("Open issues assigned to me"),
};

const emptyRecent: Record<ConnectorFamily, string> = {
  jira: msg("No open tickets are assigned to you."),
  confluence: msg("You haven't viewed or edited any pages recently."),
  github: msg("No open issues or pull requests involve you."),
  gitlab: msg("Nothing open is assigned to you or awaiting your review."),
  azure: msg("No open work items are assigned to you."),
  linear: msg("No open issues are assigned to you."),
};

/** Identity of an item across connections of one service: keys repeat between services (team/app#12 on GitHub and GitLab). */
export const pickKey = (family: ConnectorFamily, key: string) => `${family}:${key}`;

/** Connections grouped by service, in a stable order. */
export function connectionsByFamily(connections: readonly Connection[]) {
  const map = new Map<ConnectorFamily, Connection[]>();
  for (const family of connectorFamilies) {
    const list = connections.filter((c) => familyOf(c.provider) === family);
    if (list.length) map.set(family, list);
  }
  return map;
}

/** "SHOPSR-123 Title [status]" chip with an optional remove button (New task form). */
export function ExternalChip({ item, provider, onRemove }: { item: ExternalSummary; provider: ConnectorProvider; onRemove?(): void }) {
  const { colors } = useTheme();
  const page = item.itemType === "page";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space[1.5],
        paddingLeft: space[2],
        paddingRight: onRemove ? 0 : space[2],
        minHeight: 32,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      <BrandIcon family={familyOf(provider)} size={14} />
      {!page && <Label medium size={font.sm} selectable={false}>{item.key}</Label>}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.sm} lines={1} selectable={false}>{item.summary || item.key}</Label>
      </View>
      {!!item.status && <Badge>{item.status}</Badge>}
      {onRemove && <IconButton icon="X" size={28} label={t("Remove {key}", { key: page ? item.summary : item.key })} onPress={onRemove} />}
    </View>
  );
}

const ExternalResult = memo(function ExternalResult({
  item,
  provider,
  usedBy,
  picked,
  onPick,
}: {
  item: ExternalSummary;
  provider: ConnectorProvider;
  usedBy?: string;
  picked: boolean;
  onPick(item: ExternalSummary): void;
}) {
  const page = item.itemType === "page";
  const where = page ? item.container : "";
  const detail = [item.status, page ? where : item.type, item.updated ? relativeTime(item.updated) : ""].filter(Boolean).join(" · ");
  const title = page ? item.summary : `${item.key}  ${item.summary}`;
  return (
    <Row
      title={title}
      detail={usedBy ? `${detail} · ${t("On card {title}", { title: usedBy })}` : detail}
      icon={itemIcon(provider, item.itemType)}
      selected={picked}
      disabled={picked}
      label={t("Choose {key}: {summary}", { key: page ? item.summary : item.key, summary: page ? where : item.summary })}
      onPress={() => onPick(item)}
    />
  );
});

/**
 * Inline picker (EXTERNAL-TRACKER-SPEC §5.2, CONNECTORS-SPEC §5–§7): my recent
 * items, or a search by key, link, number or text. Choosing only reports the
 * item; the caller decides what to do with it.
 */
export function ExternalPicker({
  family,
  connections,
  projectId,
  picked,
  usedBy,
  onPick,
  onClose,
}: {
  family: ConnectorFamily;
  /** This service's connections. */
  connections: readonly Connection[];
  /** The card's project: GitHub/GitLab search its repositories (CONNECTORS-SPEC §4.3). */
  projectId?: string;
  /** `pickKey`s already chosen (or already on this card): shown as chosen and not choosable. */
  picked: ReadonlySet<string>;
  /** `pickKey` → title of another card that already references it. */
  usedBy?: ReadonlyMap<string, string>;
  onPick(item: ExternalSummary, provider: ConnectorProvider): void;
  onClose(): void;
}) {
  const { colors } = useTheme();
  const search = useRpc(rpc.searchExternal);
  const view = useSettings(boardViewSettings);
  const values = view.status === "ready" ? boardViewValues(view.values) : null;
  const remembered = values ? values.lastConnections[family] || (family === "jira" ? values.lastTicketConnection : "") : "";
  const [chosen, setChosen] = useState("");
  const connection = connections.find((c) => c.id === (chosen || remembered)) || connections[0];
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const git = family === "github" || family === "gitlab";
  const kind = connection ? classifyQuery(query, connection).kind : "recent";
  // Text needs two characters; keys, links and numbers search at once.
  const ready = !!connection && (kind !== "text" || query.trim().length >= 2);
  const text = kind === "recent" ? "" : query.trim();
  const results = useQuery({
    queryKey: ["flowly", "external-search", connection?.id ?? "", text, projectId ?? "", git && all],
    queryFn: () => search({ connectionId: connection!.id, query: text, ...(projectId ? { projectId } : {}), ...(git && all ? { all: true } : {}) }),
    enabled: ready,
    staleTime: 30_000,
    retry: false,
  });
  const pick = useStableCallback((item: ExternalSummary) => {
    if (view.status === "ready" && values && item.connectionId !== remembered)
      void (view.save as (v: unknown, r: unknown) => Promise<unknown>)({ ...values, lastConnections: { ...values.lastConnections, [family]: item.connectionId } }, view.revision);
    onPick(item, connection!.provider);
  });
  if (!connection) return null;
  const list = results.data?.results || [];
  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: space[2], gap: space[2] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label medium size={font.sm} selectable={false}>
            {kind === "recent" ? t(recentTitles[family]) : t("Search results")}
          </Label>
        </View>
        <IconButton icon="X" label={t("Close picker")} onPress={onClose} />
      </View>
      {connections.length > 1 && (
        <Choices
          title={t("Connection")}
          hideTitle
          value={connection.id}
          options={connections.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setChosen}
        />
      )}
      <Field
        title={t("Search {service}", { service: familyNames[family] })}
        value={query}
        onChange={setQuery}
        commitDelay={300}
        placeholder={t(searchHints[family])}
      />
      {git && kind === "text" && (
        <Choices
          title={t("Search in")}
          hideTitle
          value={all ? "all" : "project"}
          options={[
            { value: "project", label: t("This project's repositories") },
            { value: "all", label: t("Everything I'm involved in") },
          ]}
          onChange={(v) => setAll(v === "all")}
        />
      )}
      {results.error ? (
        <View style={{ gap: space[2] }}>
          <Notice tone="warning">{externalError(results.error, family)}</Notice>
          <Actions>
            <Button small onPress={() => void results.refetch()}>{t("Retry")}</Button>
          </Actions>
        </View>
      ) : !ready ? (
        <Label muted size={font.sm}>{t("Type at least 2 characters.")}</Label>
      ) : results.isPending ? (
        <Label muted size={font.sm}>{t("Loading…")}</Label>
      ) : !list.length ? (
        <Label muted size={font.sm}>
          {kind === "recent"
            ? t(emptyRecent[family])
            : kind === "number" && git
              ? t("No match in this project's repositories. Try owner/repo#12 or a link.")
              : t("Nothing matches.")}
        </Label>
      ) : (
        <ScrollView style={{ maxHeight: 300 }} nestedScrollEnabled keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 1 }}>
          {list.map((item) => (
            <ExternalResult
              key={`${item.itemType}:${item.key}`}
              item={item}
              provider={connection.provider}
              usedBy={usedBy?.get(pickKey(family, item.key))}
              picked={picked.has(pickKey(family, item.key))}
              onPick={pick}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

/** A readable reason for a failed request. */
export function externalError(error: unknown, family?: ConnectorFamily) {
  const text = message(error);
  const service = family ? familyNames[family] : "";
  if (/refused the token|login page/i.test(text))
    return service
      ? t("{service} refused the connection's token. Update it in Flowly settings → Connections.", { service })
      : t("The service refused the connection's token. Update it in Flowly settings → Connections.");
  if (/unreachable|busy or unavailable|asked Flowly to wait|rate limit|slow down/i.test(text))
    return service ? t("{service} is unreachable right now. Try again shortly.", { service }) : t("The service is unreachable right now. Try again shortly.");
  if (/connection was removed/i.test(text)) return t("This connection was removed. Add it again in Settings → Connections to read the item here; opening it in the browser still works.");
  return text;
}

/** Drawer action: choose an item and add it to the card as an input (EXTERNAL-TRACKER-SPEC §5.1). */
export function LinkExternal({
  taskId,
  projectId,
  family,
  linked,
  connections,
  onClose,
}: {
  taskId: string;
  projectId: string;
  family: ConnectorFamily;
  linked: ReadonlySet<string>;
  connections: readonly Connection[];
  onClose(): void;
}) {
  const theme = useTheme();
  const toast = useToast();
  const queryClient = useQueryClient();
  const create = useRpc(rpc.createArtifact);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const pick = async (item: ExternalSummary) => {
    setPending(true);
    setError("");
    try {
      await create({ taskId, role: "input", target: item.url, external: { connectionId: item.connectionId, key: item.key, itemType: item.itemType } });
      await queryClient.invalidateQueries({ queryKey: boardKey });
      toast.show(t("Linked {key}", { key: item.itemType === "page" ? item.summary : item.key }), { variant: "success" });
      onClose();
    } catch (e) {
      setError(externalError(e, family));
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal open title={t("Add {item}", { item: t(linkTitles[family]) })} icon={<BrandIcon family={family} size={18} />} onOpenChange={(open) => !open && !pending && onClose()}>
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: space[3] }}>
            <Label muted size={font.sm}>
              {t("It becomes an input of this card. Agents read it every turn; Flowly never changes it in {service}.", { service: familyNames[family] })}
            </Label>
            {!!error && <Notice>{error}</Notice>}
            <ExternalPicker
              family={family}
              connections={connections}
              projectId={projectId}
              picked={linked}
              onPick={(item) => void pick(item)}
              onClose={onClose}
            />
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

/** Read-only view of an external input (EXTERNAL-TRACKER-SPEC §6). */
export function ExternalPreview({ artifact, onClose }: { artifact: Artifact; onClose(): void }) {
  const read = useRpc(rpc.readExternal);
  return (
    <ItemPreview
      title={artifact.title}
      family={artifact.external ? familyOf(artifact.external.provider) : "jira"}
      url={artifact.target}
      note={artifact.note}
      queryKey={artifact.id}
      read={(refresh) => read({ artifactId: artifact.id, refresh })}
      onClose={onClose}
    />
  );
}

/** The same view for an item that is not a card input, e.g. an issue on the Linear board (LINEAR-BOARD-SPEC §5). */
export function ItemPreview({
  title,
  family,
  url,
  note,
  queryKey,
  read,
  actions,
  onClose,
}: {
  title: string;
  family: ConnectorFamily;
  url: string;
  note?: string;
  queryKey: string;
  read(refresh: boolean): Promise<{ markdown: string; stale: boolean; fetchedAt: string }>;
  /** Buttons after Open and Refresh. */
  actions?: ReactNode;
  onClose(): void;
}) {
  const theme = useTheme();
  const toast = useToast();
  const [refresh, setRefresh] = useState(0);
  const preview = useQuery({
    queryKey: ["flowly", "external-preview", queryKey, refresh],
    queryFn: () => read(refresh > 0),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const data = preview.data;
  return (
    <Modal open title={title} icon={<BrandIcon family={family} size={18} />} onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: space[2] }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
              {actions}
              <Button small icon="ExternalLink" onPress={() => void Linking.openURL(url).catch(() => toast.show(t("Could not open the link."), { variant: "error" }))}>
                {t("Open in {service}", { service: familyNames[family] })}
              </Button>
              <Button small icon="RefreshCw" disabled={preview.isFetching} onPress={() => setRefresh((n) => n + 1)}>
                {t("Refresh")}
              </Button>
            </View>
            {!!note && <Label size={font.sm} selectable>{note}</Label>}
            {preview.isPending ? (
              <Label muted>{t("Loading…")}</Label>
            ) : preview.error ? (
              <Notice tone="warning">{externalError(preview.error, family)}</Notice>
            ) : data ? (
              <View style={{ gap: space[2] }}>
                {data.stale && (
                  <Notice tone="warning">
                    {t("{service} is unreachable; showing the copy from {time}.", { service: familyNames[family], time: relativeTime(data.fetchedAt) })}
                  </Notice>
                )}
                <SessionMarkdown text={data.markdown} />
              </View>
            ) : null}
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

/** Connection types per service, for the editor (CONNECTORS-SPEC §8.4). */
const providerLabels: Record<ConnectorProvider, string> = {
  "jira-dc": msg("Self-hosted (Data Center)"),
  "jira-cloud": msg("Cloud"),
  "confluence-dc": msg("Self-hosted (Data Center)"),
  "confluence-cloud": msg("Cloud"),
  github: "GitHub",
  gitlab: "GitLab",
  "azure-devops": "Azure DevOps",
  linear: "Linear",
};

const addTitles: Record<ConnectorFamily, string> = {
  jira: msg("Add a Jira connection"),
  confluence: msg("Add a Confluence connection"),
  github: msg("Add a GitHub connection"),
  gitlab: msg("Add a GitLab connection"),
  azure: msg("Add an Azure DevOps connection"),
  linear: msg("Add a Linear connection"),
};

/**
 * Settings → Connections (EXTERNAL-TRACKER-SPEC §2, CONNECTORS-SPEC §8.4). Tokens are write-only.
 * Adding or editing replaces the list in place: the settings window is itself a modal, and a host
 * Modal opened on top of it fights it for focus and locks the app.
 */
export function ConnectionsPage() {
  const { colors } = useTheme();
  const connections = useConnections();
  const [editing, setEditing] = useState<{ family: ConnectorFamily; connection: Connection | null } | null>(null);
  const list = connections.data?.connections || [];
  if (editing) return <ConnectionEditor family={editing.family} connection={editing.connection} onClose={() => setEditing(null)} />;
  return (
    <SettingsPage
      title={t("Connections")}    >
      {connections.error && <Notice>{message(connections.error)}</Notice>}
      {connectorFamilies.map((family) => (
        <SettingsGroup key={family} title={familyNames[family]}>
          {list
            .filter((c) => familyOf(c.provider) === family)
            .map((c) => (
              <SettingRow
                key={c.id}
                leading={<BrandIcon family={family} size={20} />}
                title={c.name}
                detail={c.authFailed ? t("Token refused. Edit to replace it.") : c.account ? t("Connected as {name}", { name: c.account }) : c.baseUrl}
                onPress={() => setEditing({ family, connection: c })}
                trailing={<Icon name={c.authFailed ? "TriangleAlert" : "ChevronRight"} size={16} color={colors.foregroundMuted} />}
              />
            ))}
          <SettingRow title={t(addTitles[family])} leading={<BrandIcon family={family} size={20} />} onPress={() => setEditing({ family, connection: null })} trailing={<Icon name="Plus" size={16} color={colors.foregroundMuted} />} />
        </SettingsGroup>
      ))}
    </SettingsPage>
  );
}

/** Where to create a token, per connection type. */
function tokenHint(provider: ConnectorProvider, hosted: boolean) {
  switch (provider) {
    case "jira-cloud":
    case "confluence-cloud":
      return t("Create one at id.atlassian.com → Security → API tokens.");
    case "jira-dc":
      return t("Create one in Jira under your profile → Personal access tokens. Read access is enough.");
    case "confluence-dc":
      return t("Create one in Confluence under your profile → Settings → Personal access tokens.");
    case "github":
      return hosted
        ? t("Create one at github.com → Settings → Developer settings → Personal access tokens. Fine-grained: read-only Issues, Pull requests and Metadata.")
        : t("Create one in GitHub → Settings → Developer settings → Personal access tokens, with read access to issues and pull requests.");
    case "azure-devops":
      return t("Create one in Azure DevOps → User settings → Personal access tokens, with the Work Items (Read) scope.");
    case "linear":
      return t("Create one in Linear → Settings → Security & access → Personal API keys. Read access is enough.");
    default:
      return t("Create one in GitLab → Preferences → Access tokens with the read_api scope.");
  }
}

const addressPlaceholders: Record<ConnectorProvider, string> = {
  "jira-dc": "https://jira.example.com",
  "jira-cloud": "https://your-team.atlassian.net",
  "confluence-dc": "https://confluence.example.com",
  "confluence-cloud": "https://your-team.atlassian.net/wiki",
  github: "https://github.example.com",
  gitlab: "https://gitlab.example.com",
  "azure-devops": "https://dev.azure.com/your-organization",
  linear: "https://linear.app",
};

function ConnectionEditor({ family, connection, onClose }: { family: ConnectorFamily; connection: Connection | null; onClose(): void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const save = useRpc(rpc.saveConnection);
  const remove = useRpc(rpc.deleteConnection);
  const check = useRpc(rpc.testConnection);
  // Cards whose inputs read through this connection (or its service), for the removal warning; counted by the daemon.
  const listed = useConnections();
  useEffect(() => void listed.refetch(), []);
  const linkedCards = (connection && listed.data?.linkedCards[connection.id]) || 0;
  const providers = familyProviders(family);
  const [provider, setProvider] = useState<ConnectorProvider>(connection?.provider ?? providers[0]!);
  const info = providerInfo[provider];
  const defaultBase = info.defaultBaseUrl || "";
  // GitHub/GitLab: the hosted service, or a self-hosted address. Linear has no address to choose.
  const [hosted, setHosted] = useState(() => !!info.noAddress || (!!defaultBase && (!connection || connection.baseUrl === defaultBase)));
  const [baseUrl, setBaseUrl] = useState(connection && connection.baseUrl !== defaultBase ? connection.baseUrl : "");
  const [name, setName] = useState(connection?.name ?? "");
  const [email, setEmail] = useState("");
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  // The last Test connection result; it only describes the values it was run with.
  const [tested, setTested] = useState<{ key: string; ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const address = hosted ? defaultBase : baseUrl.trim();
  const ready = !pending && !testing && !!address && (!!connection || (!!secret.trim() && (!info.email || !!email.trim())));
  const values = { ...(connection ? { id: connection.id } : {}), provider, baseUrl: address, name, email, secret };
  const valuesKey = JSON.stringify([provider, address, email.trim(), secret.trim()]);
  const result = tested?.key === valuesKey ? tested : null;
  const service = familyNames[family];
  const test = async () => {
    if (!ready) return;
    setTesting(true);
    setError("");
    try {
      const ok = await check(values);
      setTested({ key: valuesKey, ok: true, text: t("Connection works. Connected as {name}.", { name: ok.account || ok.baseUrl }) });
    } catch (e) {
      setTested({ key: valuesKey, ok: false, text: message(e) });
    } finally {
      setTesting(false);
    }
  };
  const submit = async () => {
    if (!ready) return;
    setPending(true);
    setError("");
    try {
      const saved = await save(values);
      await queryClient.invalidateQueries({ queryKey: connectionsKey });
      toast.show(t("Connected as {name}", { name: saved.account || saved.name }), { variant: "success" });
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };
  const drop = async () => {
    if (!connection) return;
    setPending(true);
    setError("");
    try {
      await remove({ id: connection.id });
      await queryClient.invalidateQueries({ queryKey: connectionsKey });
      toast.show(t("Connection removed. Items already on cards stay as links."), { variant: "success" });
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };
  const typeOptions = useMemo(() => providers.map((value) => ({ value, label: t(providerLabels[value]) })), [providers]);
  const hostedOptions = useMemo(
    () => [
      { value: "hosted", label: new URL(defaultBase || "https://example.com").host },
      { value: "self", label: family === "github" ? t("GitHub Enterprise Server") : t("Self-managed") },
    ],
    [defaultBase, family],
  );
  return (
    <View style={{ gap: space[3] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
        <IconButton icon="ArrowLeft" label={t("Back to connections")} disabled={pending} onPress={onClose} />
        <BrandIcon family={family} size={22} />
        <Label bold size={font.xl} selectable={false}>
          {connection ? t("Edit {service} connection", { service }) : t(addTitles[family])}
        </Label>
      </View>
      {!!error && <Notice>{error}</Notice>}
      {providers.length > 1 && <Choices title={t("{service} type", { service })} value={provider} options={typeOptions} onChange={setProvider} />}
      {!!defaultBase && !info.noAddress && <Choices title={t("Where")} value={hosted ? "hosted" : "self"} options={hostedOptions} onChange={(v) => setHosted(v === "hosted")} />}
      {!hosted && (
        <Field title={t("{service} address", { service })} value={baseUrl} onChange={setBaseUrl} placeholder={addressPlaceholders[provider]} />
      )}
      <Field title={t("Name")} value={name} onChange={setName} placeholder={t("Defaults to the address")} />
      {info.email && <Field title={t("Account email")} value={email} onChange={setEmail} placeholder={connection ? t("Unchanged") : "you@example.com"} />}
      <Field
        title={info.email ? t("API token") : family === "linear" ? t("API key") : t("Personal access token")}
        value={secret}
        onChange={setSecret}
        placeholder={connection ? t("Unchanged") : ""}
        secure
        hint={tokenHint(provider, hosted)}
        onSubmit={ready ? () => void submit() : undefined}
      />
      {result && <Notice tone={result.ok ? "success" : "danger"}>{result.text}</Notice>}
      {confirming && (
        <Notice tone="warning">
          {linkedCards
            ? tn(
                linkedCards,
                "{n} card has items from this {service}. They keep the link and key, but Flowly and agents can't read them until you add this {service} again; then they work as before.",
                "{n} cards have items from this {service}. They keep the link and key, but Flowly and agents can't read them until you add this {service} again; then they work as before.",
                { service },
              )
            : t("No card has items from this {service}.", { service })}
        </Notice>
      )}
      <Label muted size={font.xs}>{t("Saving checks the token with {service} first. It is stored only on the computer running Paseo and never shown again.", { service })}</Label>
      <Actions>
        {connection &&
          (confirming ? (
            <Button danger onPress={() => void drop()} disabled={pending}>{t("Remove connection")}</Button>
          ) : (
            <Button quiet onPress={() => setConfirming(true)} disabled={pending}>{t("Remove…")}</Button>
          ))}
        <Button quiet onPress={onClose} disabled={pending}>{t("Cancel")}</Button>
        <Button icon="PlugZap" onPress={() => void test()} disabled={!ready}>{testing ? t("Testing…") : t("Test connection")}</Button>
        <Button primary onPress={() => void submit()} disabled={!ready}>{pending ? t("Checking…") : t("Save")}</Button>
      </Actions>
    </View>
  );
}
