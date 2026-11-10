import type { Status, Task } from "../shared/model";
import type { MenuEntry } from "./context-menu";
import { t } from "../shared/i18n";

export type CardMenuInput = {
  card: Task;
  /** The lanes the card's own project has. */
  statuses: Status[];
  laneName(status: Status): string;
  /** The card's own project is archived. */
  ownArchived: boolean;
  /** A write is in flight. */
  pending: boolean;
  /** Phone sheet: no card drag, so Move up / Move down stay. */
  compact: boolean;
  /** The All board: order is per project, so never Move up / Move down. */
  allView: boolean;
  actions: {
    open(): void;
    start(): void;
    move(status: Status): void;
    reorder(direction: "up" | "down"): void;
    archive(): void;
    remove(): void;
  };
};

/** The board card's menu: the ⋯ button, right-click and long-press all open this one. */
export function boardCardMenu({ card, statuses, laneName, ownArchived, pending, compact, allView, actions }: CardMenuInput): MenuEntry[] {
  const locked = pending || ownArchived || !!card.archivedAt;
  const reorder: MenuEntry[] =
    compact && !allView
      ? [
          { id: "up", label: t("Move up"), icon: "ArrowUp", disabled: locked, onPress: () => actions.reorder("up") },
          { id: "down", label: t("Move down"), icon: "ArrowDown", disabled: locked, onPress: () => actions.reorder("down") },
        ]
      : [];
  return [
    { id: "open", label: t("Open details"), icon: "PanelRightOpen", onPress: actions.open },
    { id: "start", label: t("Start session"), icon: "Play", disabled: locked, onPress: actions.start },
    {
      kind: "submenu",
      id: "move",
      label: t("Move to"),
      icon: "ArrowRight",
      entries: statuses.map((status) => ({
        id: `status-${status}`,
        label: laneName(status),
        checked: status === card.status,
        disabled: locked,
        onPress: () => {
          if (status !== card.status) actions.move(status);
        },
      })),
    },
    ...reorder,
    { kind: "separator", id: "s1" },
    {
      id: "archive",
      label: card.archivedAt ? t("Restore card") : t("Archive card"),
      icon: card.archivedAt ? "ArchiveRestore" : "Archive",
      danger: !card.archivedAt,
      disabled: pending || ownArchived,
      onPress: actions.archive,
    },
    { id: "delete", label: t("Delete permanently…"), icon: "Trash2", danger: true, disabled: pending || ownArchived, onPress: actions.remove },
  ];
}
