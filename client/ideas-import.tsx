import { memo, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { importOutcome, type ImportRow } from "../shared/ideas-import";
import { invalidateCardViews } from "./card-detail-query";
import { Modal } from "./modal";
import { Actions, Button, Field, Label, Notice, Theme, font, message, radius, space, noFocusRing, useTheme } from "./ui";
import { t, tn } from "../shared/i18n";

const operationId = () => `ideas-import-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

type Preview = { rows: ImportRow[]; duplicates: ReadonlySet<number> };

/** A row's checkbox, title and flags. Memoized: a review of a long backlog re-renders one row per tap. */
const ReviewRow = memo(function ReviewRow({ index, row, kept, duplicate, disabled, onToggle }: {
  index: number;
  row: ImportRow;
  kept: boolean;
  duplicate: boolean;
  disabled: boolean;
  onToggle(index: number): void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: kept, disabled }}
      accessibilityLabel={row.title}
      disabled={disabled}
      onPress={() => onToggle(index)}
      style={{ ...noFocusRing, flexDirection: "row", alignItems: "flex-start", gap: space[2], paddingVertical: space[1.5], opacity: kept ? 1 : 0.6 }}
    >
      <View
        style={{
          width: 16,
          height: 16,
          marginTop: 2,
          borderRadius: radius.sm,
          borderWidth: 1,
          borderColor: kept ? colors.accent : colors.border,
          backgroundColor: kept ? colors.accent : colors.surface0,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {kept && <Icon name="Check" size={12} color={colors.accentForeground} />}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Label size={font.base}>{row.title}</Label>
        {(duplicate || row.done) && (
          <Label muted size={font.sm}>
            {[duplicate ? t("Already open") : "", row.done ? t("Done") : ""].filter(Boolean).join(" · ")}
          </Label>
        )}
      </View>
    </Pressable>
  );
});

/**
 * Import a markdown backlog into the project's ideas (IDEAS-IMPORT-EXPORT-SPEC §5): paste, review the rows
 * (finished and already-open ones start unchecked), then import the checked ones.
 */
export function IdeasImportModal({ projectId, open, onClose }: { projectId: string; open: boolean; onClose(): void }) {
  const theme = useTheme();
  const toast = useToast();
  const queryClient = useQueryClient();
  const readPreview = useRpc(rpc.importIdeasPreview);
  const runImport = useRpc(rpc.importIdeas);
  const [markdown, setMarkdown] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [kept, setKept] = useState<ReadonlySet<number>>(() => new Set());
  const [pending, setPending] = useState<"preview" | "import" | null>(null);
  const [error, setError] = useState("");
  // One operation per review: pressing Import again after a lost reply cannot create the ideas twice.
  const [operation, setOperation] = useState(operationId);
  useEffect(() => {
    if (!open) return;
    setMarkdown("");
    setPreview(null);
    setKept(new Set());
    setPending(null);
    setError("");
  }, [open]);
  const busy = pending !== null;
  async function review() {
    if (busy || !markdown.trim()) return;
    setPending("preview");
    setError("");
    try {
      const result = await readPreview({ projectId, markdown });
      const duplicates = new Set(result.duplicates);
      setPreview({ rows: result.rows, duplicates });
      setKept(new Set(result.rows.flatMap((row, i) => (row.keep && !duplicates.has(i) ? [i] : []))));
      setOperation(operationId());
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(null);
    }
  }
  async function submit() {
    if (!preview || busy || !kept.size) return;
    setPending("import");
    setError("");
    try {
      const rows = preview.rows.flatMap((row, i) => (kept.has(i) ? [{ ...row, keep: true }] : []));
      const result = await runImport({ projectId, rows, operationId: operation });
      await invalidateCardViews(queryClient);
      const outcome = importOutcome(result);
      const skipped = result.skipped.length;
      // A retry after a daemon restart finds every title already open: neutral, not an error.
      if (outcome === "already") toast.show(t("Already imported."), { variant: "info" });
      else
        toast.show(`${tn(result.created, "Imported {n} idea", "Imported {n} ideas")}${skipped ? `, ${t("{n} skipped", { n: skipped })}` : ""}`, {
          variant: outcome === "skipped" ? "error" : "success",
        });
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(null);
    }
  }
  const toggle = useMemo(
    () => (index: number) =>
      setKept((current) => {
        const next = new Set(current);
        if (!next.delete(index)) next.add(index);
        return next;
      }),
    [],
  );
  const rows = preview?.rows;
  return (
    <Modal
      open={open}
      title={t("Import ideas")}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
          {!preview ? (
            <Field
              title={t("Backlog markdown")}
              value={markdown}
              onChange={setMarkdown}
              multiline
              editable={!busy}
              autoFocus
              placeholder={t("Paste a markdown backlog")}
            />
          ) : rows && rows.length ? (
            <View style={{ gap: space[2] }}>
              <View style={{ flexDirection: "row", gap: space[2] }}>
                <Button small quiet disabled={busy} onPress={() => setKept(new Set(rows.flatMap((_, i) => (preview.duplicates.has(i) ? [] : [i]))))}>
                  {t("Select all")}
                </Button>
                <Button small quiet disabled={busy} onPress={() => setKept(new Set())}>
                  {t("Select none")}
                </Button>
              </View>
              <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
                {rows.map((row, i) => (
                  <ReviewRow key={row.line} index={i} row={row} kept={kept.has(i)} duplicate={preview.duplicates.has(i)} disabled={busy} onToggle={toggle} />
                ))}
              </ScrollView>
            </View>
          ) : (
            <Label muted>{t("No backlog items found.")}</Label>
          )}
          {!!error && <Notice>{error}</Notice>}
          <Actions>
            <Button quiet disabled={busy} onPress={preview ? () => setPreview(null) : onClose}>
              {preview ? t("Back") : t("Cancel")}
            </Button>
            {preview ? (
              <Button primary disabled={busy || !kept.size} onPress={() => void submit()}>
                {pending === "import" ? t("Importing…") : tn(kept.size, "Import {n} idea", "Import {n} ideas")}
              </Button>
            ) : (
              <Button primary disabled={busy || !markdown.trim()} onPress={() => void review()}>
                {t("Review")}
              </Button>
            )}
          </Actions>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}
