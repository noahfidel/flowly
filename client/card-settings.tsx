import { useMemo } from "react";
import { View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { Task } from "../shared/model";
import type { SessionAttentionSummary } from "../shared/session-attention";
import { cardActivityModes, cardDisplay, cardFields, defaultCardDisplay, withCardField, type CardActivity, type CardField } from "../shared/card-display";
import { msg, t } from "../shared/i18n";
import { useBoardView } from "./board-view";
import { TaskCard } from "./card";
import { SettingRow, SettingSelect, SettingSwitch, SettingsGroup, SettingsPage } from "./settings-ui";
import { IconButton, Label, Switch, font, space, touch, useTheme } from "./ui";
import { SortableList } from "./sortable-list";
import {
  defaultDrawerLayout,
  drawerSectionOrder,
  drawerSectionsOpen,
  fixedDrawerSections,
  isDefaultDrawerOpen,
  isDefaultDrawerOrder,
  withDrawerSectionMoved,
  withSectionOpen,
  type AnyDrawerSection,
  type DrawerSection,
} from "../shared/drawer-sections";

const activityText: Record<CardActivity, { label: string; detail: string }> = {
  auto: { label: msg("Summary, else output"), detail: msg("The progress summary; the latest output until there is one") },
  progress: { label: msg("Progress summary"), detail: msg("What the summary model wrote after the last turn") },
  output: { label: msg("Latest output"), detail: msg("The newest agent message, as it arrives") },
  both: { label: msg("Both"), detail: msg("Two lines: summary, then output") },
  none: { label: msg("None"), detail: msg("Title and signals only") },
};

const fieldText: Record<CardField, { title: string; detail: string }> = {
  workspace: { title: msg("Workspace"), detail: msg("Whether the card works in its own worktree or locally.") },
  priority: { title: msg("Priority"), detail: msg("Urgent, High and Low, and the coloured edge of Urgent and High cards.") },
  type: { title: msg("Type"), detail: msg("Feature, Bug fix, Research and the other card types.") },
  external: { title: msg("Ticket or issue"), detail: msg("The key of the ticket, issue or pull request the card works from.") },
  tags: { title: msg("Tags"), detail: msg("The first two tags, then how many more.") },
  sessions: { title: msg("Session activity"), detail: msg("Running and unread sessions. Approvals and errors always show.") },
  workpad: { title: msg("Workpad checks"), detail: msg("How many of the agent's checks passed.") },
  ideas: { title: msg("Ideas"), detail: msg("How many ideas agents proposed on the card.") },
};

const sectionText: Record<AnyDrawerSection, string> = {
  progress: msg("Progress"),
  workpad: msg("Workpad"),
  artifacts: msg("Artifacts"),
  sessions: msg("Sessions"),
  ideas: msg("Ideas"),
  links: msg("Links"),
  details: msg("Details & workspace"),
  usage: msg("Usage"),
  activity: msg("Activity"),
};

const noop = () => {};

/** Settings → Cards: what a board card shows, with a live preview (CARD-DISPLAY-SPEC §3). */
export function CardsPage() {
  const view = useBoardView();
  const display = cardDisplay(view.values);
  const hidden = view.values?.cardHidden || [];
  const busy = !view.values;
  const isDefault = display.activity === "auto" && cardFields.every((field) => display[field]);
  return (
    <SettingsPage title={t("Cards")}>
      <CardPreview display={display} />
      <SettingsGroup title={t("Activity line")}>
        <SettingSelect
          title={t("Show")}
          value={display.activity}
          placeholder={t(activityText[display.activity].label)}
          disabled={busy}
          options={cardActivityModes.map((mode) => ({ value: mode, label: t(activityText[mode].label), detail: t(activityText[mode].detail) }))}
          onChange={(next) => void view.update({ cardActivity: next as CardActivity })}
        />
      </SettingsGroup>
      <SettingsGroup>
        <SettingSwitch title={t("Running sweep")} value={view.values?.runningSweep ?? true} disabled={busy} onChange={(runningSweep) => void view.update({ runningSweep })} />
      </SettingsGroup>
      <SettingsGroup title={t("Details")}>
        {cardFields.map((field) => (
          <SettingSwitch
            key={field}
            title={t(fieldText[field].title)}
            detail={t(fieldText[field].detail)}
            value={display[field]}
            disabled={busy}
            onChange={(shown) => void view.update({ cardHidden: withCardField(hidden, field, shown) })}
          />
        ))}
      </SettingsGroup>
      <SidebarLayout
        busy={busy}
        order={view.values?.drawerOrder || []}
        open={view.values?.drawerOpen || {}}
        onChange={(patch) => void view.update(patch)}
      />
      <SettingsGroup>
        <SettingRow
          title={t("Reset to defaults")}
          detail={isDefault ? t("Cards show the default details") : undefined}
          disabled={busy || isDefault}
          onPress={() => void view.update({ cardActivity: defaultCardDisplay.activity, cardHidden: hidden.filter((id) => !(cardFields as readonly string[]).includes(id)) })}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}

/**
 * The card sidebar's layout (DRAWER-SPEC, Section order): the order of the
 * movable sections (drag the grip on desktop, arrows on touch) and which
 * sections start open. The description stays first; Details & workspace,
 * Usage and Activity stay last and only choose open or closed.
 */
function SidebarLayout({ busy, order: storedOrder, open: storedOpen, onChange }: {
  busy: boolean;
  order: readonly string[];
  open: Readonly<Record<string, boolean>>;
  onChange(patch: { drawerOrder?: string[]; drawerOpen?: Record<string, boolean> }): void;
}) {
  const { colors } = useTheme();
  const order = drawerSectionOrder(storedOrder);
  const opened = drawerSectionsOpen(storedOpen);
  const items = order.map((id) => ({ id }));
  const move = (id: DrawerSection, to: number) => onChange({ drawerOrder: withDrawerSectionMoved(storedOrder, id, to) });
  const isDefault = isDefaultDrawerOrder(storedOrder) && isDefaultDrawerOpen(storedOpen);
  const openSwitch = (id: AnyDrawerSection, name: string) => (
    <Switch
      value={opened[id]}
      label={opened[id] ? t("{section} starts open", { section: name }) : t("{section} starts closed", { section: name })}
      disabled={busy}
      onChange={(next) => onChange({ drawerOpen: withSectionOpen(storedOpen, id, next) })}
    />
  );
  const row = { flexDirection: "row", alignItems: "center", gap: space[2], minHeight: touch ? 48 : 38, paddingHorizontal: space[1.5] } as const;
  return (
    <SettingsGroup title={t("Card sidebar")}>
      <View style={{ padding: 4 }}>
        <View style={{ ...row, minHeight: 28 }}>
          <View style={{ flex: 1 }} />
          <Label muted size={font.xs} selectable={false}>{t("Starts open")}</Label>
        </View>
        <SortableList
          items={items}
          handle
          disabled={busy || touch}
          onMove={(id, to) => move(id as DrawerSection, to)}
          renderItem={(item, index, _pressable, handleProps) => {
            const id = item.id as DrawerSection;
            const name = t(sectionText[id]);
            return (
              <View style={row}>
                {touch ? (
                  <View style={{ flexDirection: "row" }}>
                    <IconButton icon="ChevronUp" size={32} label={t("Move {section} up", { section: name })} disabled={busy || index === 0} onPress={() => move(id, index - 1)} />
                    <IconButton icon="ChevronDown" size={32} label={t("Move {section} down", { section: name })} disabled={busy || index === order.length - 1} onPress={() => move(id, index + 1)} />
                  </View>
                ) : (
                  <View
                    {...handleProps}
                    accessibilityLabel={t("Drag to reorder {section}", { section: name })}
                    style={{ width: 16, alignItems: "center", ...({ cursor: "grab" } as object) }}
                  >
                    <Icon name="GripVertical" size={14} color={colors.foregroundMuted} />
                  </View>
                )}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Label size={font.md} lines={1} selectable={false}>{name}</Label>
                </View>
                {openSwitch(id, name)}
              </View>
            );
          }}
        />
        <View style={{ height: 1, backgroundColor: colors.border, marginVertical: space[1], marginHorizontal: space[1.5] }} />
        {fixedDrawerSections.map((id) => {
          const name = t(sectionText[id]);
          return (
            <View key={id} style={row}>
              <View style={{ width: touch ? 64 : 16, alignItems: "center" }}>
                <Icon name="Pin" size={13} color={colors.foregroundMuted} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Label size={font.md} lines={1} selectable={false}>{name}</Label>
              </View>
              {openSwitch(id, name)}
            </View>
          );
        })}
      </View>
      <SettingRow
        title={t("Reset sidebar layout")}
        detail={isDefault ? t("The sidebar uses the default layout") : undefined}
        disabled={busy || isDefault}
        onPress={() => onChange(defaultDrawerLayout(storedOrder, storedOpen))}
      />
    </SettingsGroup>
  );
}

/** A sample card drawn by the real TaskCard with the current choices. Not interactive. */
function CardPreview({ display }: { display: ReturnType<typeof cardDisplay> }) {
  const sample = useMemo(() => {
    const now = Date.now();
    const ago = (minutes: number) => new Date(now - minutes * 60000).toISOString();
    const task: Task = {
      id: "preview",
      projectId: "preview",
      workspaceId: "preview",
      sourcePath: "",
      repoPaths: [],
      title: t("Fix rounding in coupon totals"),
      description: "",
      status: "development",
      priority: "high",
      type: "bugfix",
      tags: ["checkout", "mobile", "payments"].map((tag) => ({ tag, by: "human" as const, at: ago(60) })),
      position: 0,
      revision: 1,
      operationId: "preview",
      createdAt: ago(120),
      updatedAt: ago(5),
      archivedAt: null,
    };
    const summary: SessionAttentionSummary = { total: 2, running: 1, starting: 0, finished: 1, unread: 1, attention: 0, permissions: 0, questions: 0, errors: 0, unknownRead: 0 };
    return {
      task,
      summary,
      progress: { state: t("Rounding fixed; adding tests for split payments"), at: ago(4) },
      output: { text: t("All 42 cart tests pass. Next I'll cover refunds."), at: ago(1) },
    };
  }, []);
  return (
    <View style={{ gap: space[2] }}>
      <View style={{ paddingHorizontal: space[1] }}>
        <Label bold size={font.base} selectable={false}>
          {t("Preview")}
        </Label>
      </View>
      <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 300, maxWidth: "100%" }}>
        <TaskCard
          task={sample.task}
          selected={false}
          legacy={false}
          available
          workspace="worktree"
          running={1}
          sessions={2}
          summary={sample.summary}
          output={sample.output}
          progress={sample.progress}
          ideas={1}
          externalKey="SHOP-142"
          workpad={{ kind: "acceptance", done: 2, total: 3 }}
          display={display}
          onOpen={noop}
          onActions={noop}
        />
      </View>
    </View>
  );
}
