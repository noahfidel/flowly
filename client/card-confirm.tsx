import { memo } from "react";
import { View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import {
  cardConfirmChoices,
  cardConfirmFacts,
  cardConfirmReply,
  umbrellaConfirmFacts,
  umbrellaConfirmReply,
  type CardConfirmChoice,
  type CardConfirmFacts,
  type CardConfirmProject as Project,
  type UmbrellaConfirmAction,
  type UmbrellaConfirmBoard,
} from "../shared/card-confirm";
import { priorityLabels, taskTypeLabels, type TaskType } from "../shared/model";
import type { PendingRequest, PermissionReply } from "../shared/permission-question";
import { Button, Label, font, space, useTheme } from "./ui";
import { msg, t } from "../shared/i18n";

/** The project the dispatcher's card goes to, as the board knows it; null when it does not. */
export type CardConfirmProject = Project;

const choiceLabel = (choice: CardConfirmChoice) =>
  choice === "create"
    ? t("Create")
    : choice === "without-linear"
      ? t("Create without Linear ticket")
      : choice === "with-linear"
        ? t("Create with Linear ticket")
        : t("Cancel");

/** The one settings line: project · umbrella (when the call names one) · type · priority · workspace · Linear ask (left out when the project has none). */
export function cardSettingsLine(facts: CardConfirmFacts) {
  const linear =
    facts.linear === "ask" ? t("Linear ticket") : facts.linear === "skip" ? t("No Linear ticket") : facts.linear === "linked" ? t("Linear issue linked") : "";
  return [
    facts.project,
    facts.umbrella ? t("In umbrella {title}", { title: facts.umbrella }) : "",
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
  umbrella,
  disabled,
  onRespond,
}: {
  request: PendingRequest;
  project: CardConfirmProject;
  /** The umbrella the call names (`umbrellaId`), as the board knows it. */
  umbrella?: { title: string } | null;
  disabled: boolean;
  onRespond(request: PendingRequest, reply: PermissionReply): void;
}) {
  const { colors } = useTheme();
  const facts = cardConfirmFacts(request.input ?? {}, project, umbrella);
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
          <Button key={choice} small primary={choice === "create"} quiet={choice !== "create"} disabled={disabled} onPress={() => onRespond(request, cardConfirmReply(request, choice, project))}>
            {choiceLabel(choice)}
          </Button>
        ))}
      </View>
    </View>
  );
});

const changeTitles: Record<UmbrellaConfirmAction, string> = {
  create: msg("Create this umbrella?"),
  join: msg("Add this card to an umbrella?"),
  member: msg("Change this card's role or order?"),
  leave: msg("Take this card out of its umbrella?"),
  update: msg("Update this umbrella?"),
  manage_groups: msg("Change the board groups?"),
};
const changeButtons: Record<UmbrellaConfirmAction, string> = {
  create: msg("Create"),
  join: msg("Add"),
  member: msg("Update"),
  leave: msg("Remove"),
  update: msg("Update"),
  manage_groups: msg("Apply"),
};

/**
 * The dispatcher's umbrella tools and flowly_manage_groups waiting on the user (UMBRELLA-SPEC §4.3, DISPATCHER-SPEC
 * §5.2): what the call does, one line each, and Cancel / the action's button, in place of the generic approval.
 */
export const UmbrellaConfirm = memo(function UmbrellaConfirm({
  request,
  board,
  disabled,
  onRespond,
}: {
  request: PendingRequest;
  board: UmbrellaConfirmBoard;
  disabled: boolean;
  onRespond(request: PendingRequest, reply: PermissionReply): void;
}) {
  const { colors } = useTheme();
  const facts = umbrellaConfirmFacts(request, board);
  if (!facts) return null;
  const [first, ...rest] = facts.lines;
  return (
    <View accessibilityLabel={t(changeTitles[facts.action])} testID="dispatcher-umbrella-confirm" style={{ gap: space[1.5] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
        <Icon name="Umbrella" size={14} color={colors.statusWarning} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label medium size={font.md} lines={2}>
            {first ?? t(changeTitles[facts.action])}
          </Label>
        </View>
      </View>
      {rest.map((line, i) => (
        <Label key={i} muted size={font.sm} lines={2}>
          {line}
        </Label>
      ))}
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space[2], paddingTop: space[1] }}>
        <Button small quiet disabled={disabled} onPress={() => onRespond(request, umbrellaConfirmReply("cancel"))}>
          {t("Cancel")}
        </Button>
        <Button small primary disabled={disabled} onPress={() => onRespond(request, umbrellaConfirmReply("confirm"))}>
          {t(changeButtons[facts.action])}
        </Button>
      </View>
    </View>
  );
});
