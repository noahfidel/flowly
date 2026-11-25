import { memo } from "react";
import { View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { UmbrellaEntry } from "../shared/model";
import { msg, t } from "../shared/i18n";
import { recentEntries, umbrellaRefetchKey, type UmbrellaSummary } from "../shared/umbrella";
import { Section, type SectionState } from "./disclosure";
import { Button, Label, font, relativeTime, space } from "./ui";

const kindText: Record<UmbrellaEntry["kind"], string> = {
  decision: msg("Decision"),
  ruling: msg("Ruling"),
  finding: msg("Finding"),
  convention: msg("Convention"),
  pitfall: msg("Pitfall"),
  question: msg("Question"),
  contract_change: msg("Contract change"),
};

/**
 * Drawer "Umbrella" (UMBRELLA-SPEC §7): the card's role, a link to the panel, when the brief and contract last
 * changed, and the last 5 feed entries. The feed is read when the section opens and again when the umbrella's
 * `umbrellaRefetchKey` changes (an edit or a feed write); never polled. Unread is per agent session, so no unread marker.
 */
export const UmbrellaSection = memo(function UmbrellaSection({
  hostId,
  taskId,
  summary,
  role,
  section,
  onOpenUmbrella,
}: {
  hostId: string;
  taskId: string;
  summary: UmbrellaSummary;
  role?: string;
  section: SectionState;
  /** Opens the umbrella panel; the link is left out without it. */
  onOpenUmbrella?(id: string): void;
}) {
  const get = useRpc(rpc.getUmbrella);
  const refetchKey = umbrellaRefetchKey(summary);
  const detail = useQuery({
    queryKey: ["flowly", "umbrella", hostId, summary.id, refetchKey],
    queryFn: () => get({ id: summary.id }),
    enabled: section.open,
    staleTime: Infinity,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const entries = detail.data ? recentEntries(detail.data.entries) : [];
  const brief = detail.data && detail.data.umbrella.brief.revision > 0 ? detail.data.umbrella.brief.updatedAt : "";
  const contract = detail.data && detail.data.umbrella.contract.revision > 0 ? detail.data.umbrella.contract.updatedAt : "";
  return (
    <Section
      id={`${taskId}:umbrella`}
      focusId="umbrella"
      title={t("Umbrella")}
      open={section.open}
      onToggle={section.onToggle}
      actions={
        onOpenUmbrella && (
          <Button small quiet label={t("Open umbrella {title}", { title: summary.title })} onPress={() => onOpenUmbrella(summary.id)}>
            {t("Open umbrella")}
          </Button>
        )
      }
    >
      <View style={{ gap: space[1.5] }}>
        <Label size={font.md} medium lines={2}>
          {summary.title}
        </Label>
        {!!role && (
          <Label muted size={font.sm}>
            {t("Role: {role}", { role })}
          </Label>
        )}
        {!!brief && (
          <Label muted size={font.sm}>
            {t("Brief changed {time}", { time: relativeTime(brief) })}
          </Label>
        )}
        {!!contract && (
          <Label muted size={font.sm}>
            {t("Contract changed {time}", { time: relativeTime(contract) })}
          </Label>
        )}
        {detail.isError && (
          <Label muted size={font.sm}>
            {t("Could not load the umbrella feed.")}
          </Label>
        )}
        {entries.map((entry) => (
          <View key={entry.id} style={{ gap: 1 }}>
            <Label size={font.sm} lines={2}>
              <Label muted size={font.sm}>{`${t(kindText[entry.kind])} · `}</Label>
              {entry.title}
            </Label>
            <Label muted size={font.xs}>
              {relativeTime(entry.createdAt)}
            </Label>
          </View>
        ))}
      </View>
    </Section>
  );
});
