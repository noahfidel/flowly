import { memo } from "react";
import { View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { cardConfirmChoices, cardConfirmFacts, cardConfirmReply, type CardConfirmChoice, type CardConfirmFacts } from "../shared/card-confirm";
import { priorityLabels, taskTypeLabels, type TaskType } from "../shared/model";
import type { PendingRequest, PermissionReply } from "../shared/permission-question";
import { Button, Label, font, space, useTheme } from "./ui";
import { t } from "../shared/i18n";

/** The project the dispatcher's card goes to, as the board knows it; null when it does not. */
export type CardConfirmProject = { title: string; linearTicket?: boolean } | null;

const choiceLabel = (choice: CardConfirmChoice) =>
  choice === "create"
    ? t("Create")
    : choice === "without-linear"
      ? t("Create without Linear ticket")
      : choice === "with-linear"
        ? t("Create with Linear ticket")
        : t("Cancel");

/** The one settings line: project · type · priority · workspace · Linear ask (left out when the project has none). */
export function cardSettingsLine(facts: CardConfirmFacts) {
  const linear =
    facts.linear === "ask" ? t("Linear ticket") : facts.linear === "skip" ? t("No Linear ticket") : facts.linear === "linked" ? t("Linear issue linked") : "";
  return [
    facts.project,
    facts.type && facts.type in taskTypeLabels ? taskTypeLabels[facts.type as TaskType] : facts.type,
    priorityLabels[facts.priority as keyof typeof priorityLabels] ?? facts.priority,
    facts.workspace === "worktree" ? t("Worktree") : t("Directory"),
    linear,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The dispatcher's flowly_create_card waiting on the user (DISPATCHER-SPEC §5.2): the card's title, one settings line
 * and its buttons, in place of the generic approval. A button answers the permission request, with the Linear toggle
 * as a changed input.
 */
export const CardConfirm = memo(function CardConfirm({
  request,
  project,
  disabled,
  onRespond,
}: {
  request: PendingRequest;
  project: CardConfirmProject;
  disabled: boolean;
  onRespond(request: PendingRequest, reply: PermissionReply): void;
}) {
  const { colors } = useTheme();
  const facts = cardConfirmFacts(request.input ?? {}, project);
  return (
    <View accessibilityLabel={t("Create this card?")} testID="dispatcher-card-confirm" style={{ gap: space[1.5] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
        <Icon name="Plus" size={14} color={colors.statusWarning} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label medium size={font.md} lines={2}>
            {facts.title}
          </Label>
        </View>
      </View>
      <Label muted size={font.sm} lines={2}>
        {cardSettingsLine(facts)}
      </Label>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space[2], paddingTop: space[1] }}>
        {cardConfirmChoices(facts).map((choice) => (
          <Button key={choice} small primary={choice === "create"} quiet={choice !== "create"} disabled={disabled} onPress={() => onRespond(request, cardConfirmReply(request, choice))}>
            {choiceLabel(choice)}
          </Button>
        ))}
      </View>
    </View>
  );
});
