import { useState } from "react";
import { View } from "react-native";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { StorageReason } from "../shared/storage";
import { msg, t } from "../shared/i18n";
import { SettingRow, SettingsGroup, SettingsPage } from "./settings-ui";
import { Actions, Button, Label, Notice, font, message, relativeTime, space } from "./ui";
import { boardKey } from "./queries";

const statusKey = ["flowly", "storage-status"];
const reasonText: Record<StorageReason, string> = {
  exported: msg("The board is in board.json. You can install an earlier Flowly version, or move the board back to SQLite."),
  unsupported: msg("This Paseo cannot use SQLite, so the board stays in board.json."),
  "migration-failed": msg("Moving the board to SQLite failed. It stays in board.json, and Flowly tries again at the next start."),
  busy: msg("Another Flowly process is still using the data. Reload the plugin if this persists."),
  diverged: msg("flowly.sqlite and a different board.json both exist. Flowly changed neither; move one of them aside."),
  missing: msg("flowly.sqlite is missing. Restore a backup below."),
  invalid: msg("The board database cannot be read. Restore a backup below."),
};
const megabytes = (bytes: number) => t("{size} MB", { size: (bytes / 1048576).toFixed(1) });

/** Settings > Storage (SQLITE-STORAGE-SPEC §9): where the board is, backups, restore, and the way back to JSON. Works while the board cannot be read. */
export function StoragePage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const read = useRpc(rpc.readStorageStatus);
  const backup = useRpc(rpc.backupStorage);
  const restore = useRpc(rpc.restoreStorage);
  const exportJson = useRpc(rpc.exportStorage);
  const useSqlite = useRpc(rpc.useSqliteStorage);
  const exportMarkdown = useRpc(rpc.exportBoardMarkdown);
  const status = useQuery({ queryKey: statusKey, queryFn: () => read({}), staleTime: 0, retry: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<{ kind: "restore"; name: string; at: string } | { kind: "export" } | null>(null);
  const run = async (action: () => Promise<unknown>, done: string) => {
    setPending(true);
    setError("");
    try {
      await action();
      setConfirming(null);
      toast.show(done, { variant: "success" });
      await Promise.all([queryClient.invalidateQueries({ queryKey: statusKey }), queryClient.invalidateQueries({ queryKey: boardKey })]);
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };
  const copyMarkdown = async () => {
    setPending(true);
    setError("");
    try {
      await copyText((await exportMarkdown({})).markdown);
      toast.show(t("Copied the board as Markdown"), { variant: "success" });
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };
  const value = status.data;
  const backend = value?.backend === "sqlite" ? t("SQLite") : value?.backend === "json" ? t("JSON file") : value ? t("Needs attention") : "";
  const canRestore = value?.backend === "sqlite" || (value?.backend === "error" && (value.reason === "missing" || value.reason === "invalid"));
  return (
    <SettingsPage title={t("Storage")}>
      {(!!error || status.error) && <Notice>{error || message(status.error)}</Notice>}
      {value && (
        <SettingsGroup>
          <SettingRow title={t("Board data")} detail={value.directory} trailing={<Label muted>{backend}</Label>} />
          {value.backend === "sqlite" && value.databaseBytes !== undefined && (
            <SettingRow title={t("Database")} detail={value.migratedAt ? t("Moved from board.json {time}", { time: relativeTime(value.migratedAt) }) : undefined} trailing={<Label muted>{megabytes(value.databaseBytes)}</Label>} />
          )}
        </SettingsGroup>
      )}
      {value?.reason && (
        <Notice tone={value.backend === "error" ? "danger" : "warning"}>
          {t(reasonText[value.reason])}
          {value.detail ? `\n${value.detail}` : ""}
        </Notice>
      )}
      {value && (value.backend !== "json" || value.backups.length > 0) && (
        <SettingsGroup title={t("Backups")} description={t("Flowly backs up the board once a day and keeps the newest 7.")}>
          {value.backend === "sqlite" && <SettingRow title={t("Back up now")} disabled={pending} onPress={() => void run(() => backup({}), t("Backed up"))} />}
          {value.backups.map((b) => (
            <SettingRow
              key={b.name}
              title={relativeTime(b.at)}
              detail={`${b.name} · ${megabytes(b.bytes)}`}
              trailing={
                canRestore ? (
                  <Button small quiet disabled={pending} onPress={() => setConfirming({ kind: "restore", name: b.name, at: b.at })}>
                    {t("Restore…")}
                  </Button>
                ) : undefined
              }
            />
          ))}
        </SettingsGroup>
      )}
      {confirming?.kind === "restore" && (
        <View style={{ gap: space[2] }}>
          <Notice tone="warning">{t("The board goes back to {name} ({time}). Changes since then leave the board; the current data stays in the data folder.", { name: confirming.name, time: relativeTime(confirming.at) })}</Notice>
          <Actions>
            <Button quiet disabled={pending} onPress={() => setConfirming(null)}>
              {t("Cancel")}
            </Button>
            <Button danger disabled={pending} onPress={() => void run(() => restore({ name: confirming.name }), t("Backup restored"))}>
              {t("Restore")}
            </Button>
          </Actions>
        </View>
      )}
      {value && (
        <SettingsGroup>
          <SettingRow title={t("Export as Markdown")} disabled={pending} onPress={() => void copyMarkdown()} />
          {value.backend === "sqlite" && <SettingRow title={t("Export to JSON…")} disabled={pending} onPress={() => setConfirming({ kind: "export" })} />}
        </SettingsGroup>
      )}
      {value?.backend === "json" && value.reason === "exported" && (
        <SettingsGroup>
          <SettingRow title={t("Move the board back to SQLite")} disabled={pending} onPress={() => void run(() => useSqlite({}), t("The board is in SQLite again"))} />
        </SettingsGroup>
      )}
      {confirming?.kind === "export" && (
        <View style={{ gap: space[2] }}>
          <Notice tone="warning">{t("Flowly writes the board to board.json and stops using SQLite. Then you can install an earlier Flowly version, or move the board back here.")}</Notice>
          <Actions>
            <Button quiet disabled={pending} onPress={() => setConfirming(null)}>
              {t("Cancel")}
            </Button>
            <Button danger disabled={pending} onPress={() => void run(() => exportJson({}), t("Board exported to board.json"))}>
              {t("Export to JSON")}
            </Button>
          </Actions>
        </View>
      )}
      {status.isLoading && <Label muted size={font.sm}>{t("Loading…")}</Label>}
    </SettingsPage>
  );
}
