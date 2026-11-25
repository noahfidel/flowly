import { memo, useRef, useState } from "react";
import { View } from "react-native";
import type { UmbrellaEntry } from "../shared/model";
import { msg, t } from "../shared/i18n";
import { useStableCallback } from "./stable";
import { PartTitle } from "./umbrella-feed";
import { Button, Label, font, space, useTheme } from "./ui";

/** After Close (UMBRELLA-SPEC §6): the entries worth keeping as project memory, each ticked off by the user. */
const kindText: Partial<Record<UmbrellaEntry["kind"], string>> = {
  decision: msg("Decision"),
  convention: msg("Convention"),
  pitfall: msg("Pitfall"),
};

/**
 * One *Keep for the project* button per entry, one `createGuardrail` call per tap, nothing moves on its own. A kept
 * entry stays listed, marked Kept, so a second tap cannot save it twice; the marks live in this view only.
 */
export function CloseOffer({ entries, sourceOf, onKeep }: {
  entries: readonly UmbrellaEntry[];
  sourceOf(taskId: string | undefined): string;
  /** Saves one entry as a project note; true when it was saved. */
  onKeep(entry: UmbrellaEntry): Promise<boolean>;
}) {
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const pending = useRef(new Set<string>());
  const keep = useStableCallback(async (entry: UmbrellaEntry) => {
    if (pending.current.has(entry.id)) return;
    pending.current.add(entry.id);
    try {
      if (await onKeep(entry)) setKept((old) => new Set(old).add(entry.id));
    } finally {
      pending.current.delete(entry.id);
    }
  });
  if (!entries.length) return null;
  return (
    <View style={{ gap: space[2] }}>
      <PartTitle title={t("Keep for the project")} count={entries.length} />
      {entries.map((e) => (
        <OfferRow key={e.id} entry={e} source={sourceOf(e.sourceTaskId)} kept={kept.has(e.id)} onKeep={keep} />
      ))}
    </View>
  );
}

const OfferRow = memo(function OfferRow({ entry, source, kept, onKeep }: { entry: UmbrellaEntry; source: string; kept: boolean; onKeep(entry: UmbrellaEntry): void }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: space[1], paddingVertical: space[1.5], borderBottomWidth: 1, borderColor: colors.border }}>
      <Label muted size={font.xs}>
        {[t(kindText[entry.kind] ?? ""), source].filter(Boolean).join(" · ")}
      </Label>
      <Label medium size={font.md}>
        {entry.title}
      </Label>
      {!!entry.body && <Label size={font.sm}>{entry.body}</Label>}
      <View style={{ flexDirection: "row" }}>
        {kept ? (
          <Label muted size={font.sm}>{t("Kept")}</Label>
        ) : (
          <Button small onPress={() => onKeep(entry)}>
            {t("Keep for the project")}
          </Button>
        )}
      </View>
    </View>
  );
});
