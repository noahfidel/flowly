import { memo } from "react";
import { View } from "react-native";
import { t } from "../shared/i18n";
import type { LinearProjectIssue, SuggestedMember } from "../shared/umbrella";
import { PartTitle } from "./umbrella-feed";
import { Button, Notice, Row, space } from "./ui";

/** The umbrella's Linear project (UMBRELLA-SPEC §10), read-only: its issues without a card here, and cards that look like members. */

const IssueRow = memo(function IssueRow({ issue, canMake, busy, onOpen, onMake }: {
  issue: LinearProjectIssue;
  canMake: boolean;
  busy: boolean;
  onOpen(url: string): void;
  onMake(issue: LinearProjectIssue): void;
}) {
  return (
    <Row
      icon="Link"
      title={`${issue.identifier} ${issue.title}`}
      detail={[issue.state, t("no card")].filter(Boolean).join(" · ")}
      label={t("Open {issue} in Linear", { issue: issue.identifier })}
      onPress={() => onOpen(issue.url)}
      trailing={
        canMake ? (
          <Button small quiet disabled={busy} label={t("Make a card for {issue}", { issue: issue.identifier })} onPress={() => onMake(issue)}>
            {t("Make card")}
          </Button>
        ) : undefined
      }
    />
  );
});

const SuggestedRow = memo(function SuggestedRow({ card, canAdd, busy, onOpen, onAdd }: {
  card: SuggestedMember;
  canAdd: boolean;
  busy: boolean;
  onOpen(taskId: string): void;
  onAdd(taskId: string): void;
}) {
  return (
    <Row
      title={card.title}
      detail={[card.projectTitle, card.issue].join(" · ")}
      label={t("Open card {card}", { card: card.title })}
      onPress={() => onOpen(card.taskId)}
      trailing={
        canAdd ? (
          <Button small quiet disabled={busy} label={t("Add {card} to the umbrella", { card: card.title })} onPress={() => onAdd(card.taskId)}>
            {t("Add")}
          </Button>
        ) : undefined
      }
    />
  );
});

/** Nothing shows until the one read comes back; a refusal is one inline line and never blocks the panel. */
export function LinearIssues({ withoutCard, suggested, error, writable, busy, onOpenIssue, onOpenCard, onMake, onAdd }: {
  withoutCard: readonly LinearProjectIssue[] | undefined;
  suggested: readonly SuggestedMember[];
  error: string;
  writable: boolean;
  busy: boolean;
  onOpenIssue(url: string): void;
  onOpenCard(taskId: string): void;
  onMake(issue: LinearProjectIssue): void;
  onAdd(taskId: string): void;
}) {
  if (error) return <Notice tone="warning">{error}</Notice>;
  if (!withoutCard || (!withoutCard.length && !suggested.length)) return null;
  return (
    <View style={{ gap: space[2] }}>
      {withoutCard.length > 0 && (
        <>
          <PartTitle title={t("Linear issues without a card")} count={withoutCard.length} />
          {withoutCard.map((issue) => (
            <IssueRow key={issue.identifier} issue={issue} canMake={writable} busy={busy} onOpen={onOpenIssue} onMake={onMake} />
          ))}
        </>
      )}
      {suggested.length > 0 && (
        <>
          <PartTitle title={t("Cards that may belong here")} count={suggested.length} />
          {suggested.map((card) => (
            <SuggestedRow key={card.taskId} card={card} canAdd={writable} busy={busy} onOpen={onOpenCard} onAdd={onAdd} />
          ))}
        </>
      )}
    </View>
  );
}
