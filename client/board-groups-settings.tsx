import { useRef } from "react";
import { Pressable, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useSettings } from "@getpaseo/plugin/client";
import { boardViewSettings, boardViewValues, type BoardGroup } from "../shared/settings";
import type { Project } from "../shared/model";
import { t } from "../shared/i18n";
import { addGroup, deleteGroup, renameGroup, toggleMember } from "./board-groups";
import { SettingRow, SettingsGroup } from "./settings-ui";
import { useStored } from "./stored-settings";
import { Field, IconButton, Label, Notice, font, noFocusRing, radius, space, tint, useTheme } from "./ui";

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Settings → Workflow → Board groups (BOARD-GROUPS-SPEC §2): add, rename and delete groups and tick their projects.
 * Stored in the host's board-view settings; a project can be in several groups.
 */
export function BoardGroupsGroup({ projects }: { projects: readonly Project[] }) {
  const stored = useStored(useSettings(boardViewSettings), boardViewValues);
  const groups = stored.values?.boardGroups ?? [];
  // Debounced name edits can land after another change; always edit the latest list.
  const latest = useRef<BoardGroup[]>(groups);
  latest.current = groups;
  const save = (next: BoardGroup[]) => {
    latest.current = next;
    void stored.saveSure({ boardGroups: next });
  };
  return (
    <SettingsGroup title={t("Board groups")}>
      {!!stored.problem && <Notice tone="warning">{stored.problem}</Notice>}
      {groups.map((group) => (
        <View key={group.id} style={{ gap: space[2], padding: space[3] }}>
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space[2] }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Field
                title={t("Name")}
                value={group.name}
                placeholder={t("Group name")}
                commitDelay={600}
                onChange={(name) => save(renameGroup(latest.current, group.id, name))}
              />
            </View>
            <IconButton icon="Trash2" label={t("Delete {name}", { name: group.name || t("Untitled group") })} disabled={stored.busy} onPress={() => save(deleteGroup(latest.current, group.id))} />
          </View>
          {projects.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1.5] }}>
              {projects.map((p) => (
                <MemberChip
                  key={p.id}
                  title={p.title}
                  checked={group.projectIds.includes(p.id)}
                  onPress={() => save(toggleMember(latest.current, group.id, p.id))}
                />
              ))}
            </View>
          ) : (
            <Label muted size={font.sm}>
              {t("No projects yet.")}
            </Label>
          )}
        </View>
      ))}
      <SettingRow
        title={t("Add group")}
        disabled={stored.busy}
        trailing={<Icon name="Plus" size={16} />}
        onPress={() => save(addGroup(latest.current, t("New group"), newId()))}
      />
    </SettingsGroup>
  );
}

function MemberChip({ title, checked, onPress }: { title: string; checked: boolean; onPress(): void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={title}
      accessibilityState={{ checked }}
      onPress={onPress}
      style={{
        ...noFocusRing,
        flexDirection: "row",
        alignItems: "center",
        gap: space[1],
        maxWidth: 220,
        paddingVertical: space[1],
        paddingHorizontal: space[2],
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: checked ? colors.accent : colors.border,
        backgroundColor: checked ? tint(colors.accent, 0.14) : "transparent",
      }}
    >
      <Icon name={checked ? "Check" : "Plus"} size={12} color={checked ? colors.foreground : colors.foregroundMuted} />
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Label lines={1} size={font.sm} selectable={false} color={checked ? colors.foreground : colors.foregroundMuted}>
          {title}
        </Label>
      </View>
    </Pressable>
  );
}
