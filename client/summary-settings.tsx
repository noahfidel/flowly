import { useEffect, useState } from "react";
import { Modal as RNModal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { Enter } from "./motion";
import type { PluginTheme } from "@getpaseo/plugin";
import type { Project } from "../shared/model";
import { useShortcutBlock } from "./shortcuts";
import { AiPage, GeneralPage, ModelsPage, WorkflowPage } from "./settings-pages";
import { CardsPage } from "./card-settings";
import { ConnectionsPage } from "./connectors";
import { StoragePage } from "./storage-settings";
import { Button, IconButton, Label, Theme, font, noFocusRing, radius, space, tint, touch, useTheme } from "./ui";
import { msg, t } from "../shared/i18n";

/** The settings window is wider than the host modal (about 520 px) so the two columns have room. */
const modalMaxWidth = 900;

/**
 * The one-time callout under the toolbar's settings gear (ONBOARDING-SETUP-SPEC §5): placed by the board under the
 * measured gear, right-aligned to it and kept inside the window. A sibling of the toolbar, not a child of the button,
 * so Android neither clips it nor drops its touches.
 */
export function SettingsHint({ text, top, right, onDismiss }: { text: string; top: number; right: number; onDismiss(): void }) {
  const { colors } = useTheme();
  return (
    <Enter
      distance={6}
      style={{
        position: "absolute",
        top,
        right,
        zIndex: 40,
        width: 280,
        maxWidth: "90%",
        flexDirection: "row",
        alignItems: "center",
        gap: space[2],
        paddingLeft: space[3],
        paddingRight: space[1.5],
        paddingVertical: space[2],
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: tint(colors.accent, 0.45),
        backgroundColor: colors.surface2,
        shadowColor: "#000",
        shadowOpacity: 0.16,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 4 },
        elevation: 4,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.md}>{text}</Label>
      </View>
      <View style={{ flexShrink: 0 }}>
        <Button small quiet onPress={onDismiss}>
          {t("Got it")}
        </Button>
      </View>
    </Enter>
  );
}

/** The outline that says "here" around the gear while its callout shows, drawn outside it so its size stays. */
export function HintOutline() {
  const { colors } = useTheme();
  return <View pointerEvents="none" style={{ position: "absolute", top: -3, left: -3, right: -3, bottom: -3, borderRadius: radius.lg + 3, borderWidth: 2, borderColor: tint(colors.accent, 0.5) }} />;
}

export type SettingsSection = "general" | "cards" | "models" | "workflow" | "ai" | "connections" | "storage";
/** Settings grouped by what they are for; each group is one page of the two-column layout. */
const settingsSections: { id: SettingsSection; icon: string; label: string }[] = [
  { id: "general", icon: "SlidersHorizontal", label: msg("General") },
  { id: "cards", icon: "LayoutList", label: msg("Cards") },
  { id: "models", icon: "Cpu", label: msg("Models") },
  { id: "workflow", icon: "Workflow", label: msg("Workflow") },
  { id: "ai", icon: "Sparkles", label: msg("AI features") },
  { id: "connections", icon: "Plug", label: msg("Connections") },
  { id: "storage", icon: "Database", label: msg("Storage") },
];

/** One entry of the section list: a row in the left column, a compact chip when the modal is narrow. */
function SettingsNavRow({ icon, label, selected, stacked, onPress }: { icon: string; label: string; selected: boolean; stacked: boolean; onPress(): void }) {
  const { colors } = useTheme();
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={{
        ...noFocusRing,
        flexDirection: "row",
        alignItems: "center",
        gap: space[2],
        minHeight: touch ? 44 : 34,
        paddingVertical: space[1.5],
        paddingHorizontal: space[3],
        borderRadius: radius.lg,
        backgroundColor: selected ? colors.surface2 : hovered ? colors.surface1 : "transparent",
        ...(stacked ? { borderWidth: 1, borderColor: selected ? colors.accent : colors.border } : {}),
      }}
    >
      <Icon name={icon} size={16} color={selected ? colors.foreground : colors.foregroundMuted} />
      <Label medium={selected} size={font.md} color={selected ? colors.foreground : colors.foregroundMuted} selectable={false}>
        {label}
      </Label>
    </Pressable>
  );
}

/** Left column of sections, right column with the selected section's settings; the sections become a strip on top in narrow windows. */
function SettingsPanes({ open, initial, projects, onTour, onWhatsNew, fill = false }: { open: boolean; initial?: SettingsSection; projects: readonly Project[]; onTour(): void; onWhatsNew(): void; fill?: boolean }) {
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const stacked = Math.min(modalMaxWidth, fill ? width : width - 32) < 560;
  const [section, setSection] = useState<SettingsSection>(initial || "general");
  // Opened for a section (Sort menu → Card display…): show it, also when the panes stayed mounted.
  useEffect(() => {
    if (open && initial) setSection(initial);
  }, [open, initial]);
  const bodyHeight = fill ? undefined : Math.min(560, Math.max(340, height - 200));
  const pane =
    section === "general" ? (
      <GeneralPage onTour={onTour} onWhatsNew={onWhatsNew} />
    ) : section === "cards" ? (
      <CardsPage />
    ) : section === "models" ? (
      <ModelsPage active={open} />
    ) : section === "workflow" ? (
      <WorkflowPage />
    ) : section === "connections" ? (
      <ConnectionsPage />
    ) : section === "storage" ? (
      <StoragePage />
    ) : (
      <AiPage />
    );
  const rows = settingsSections.map((entry) => (
    <SettingsNavRow key={entry.id} icon={entry.icon} label={t(entry.label)} selected={entry.id === section} stacked={stacked} onPress={() => setSection(entry.id)} />
  ));
  const content = (
    <ScrollView style={{ flex: 1, minWidth: 0 }} contentContainerStyle={{ padding: space[5], paddingBottom: space[6] }}>
      <Enter key={section} distance={4}>
        <View style={{ maxWidth: 680, width: "100%" }}>{pane}</View>
      </Enter>
    </ScrollView>
  );
  return stacked ? (
    <View style={fill ? { flex: 1 } : { height: bodyHeight }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: colors.border }}
        contentContainerStyle={{ padding: space[2], gap: space[2] }}
        accessibilityLabel={t("Settings sections")}
      >
        {rows}
      </ScrollView>
      {content}
    </View>
  ) : (
    <View style={fill ? { flex: 1, flexDirection: "row" } : { height: bodyHeight, flexDirection: "row" }}>
      <View accessibilityLabel={t("Settings sections")} style={{ width: 156, padding: space[2], gap: 2, borderRightWidth: 1, borderRightColor: colors.border }}>
        {rows}
      </View>
      {content}
    </View>
  );
}

/** Flowly settings, in two columns: sections on the left (language and guide, card workflow, AI summaries, ideas), their settings on the right. */
export function SettingsModal({ open, section, theme, projects, onClose, onTour, onWhatsNew }: { open: boolean; section?: SettingsSection; theme: PluginTheme; /** The live projects, for the Board groups editor. */ projects: readonly Project[]; onClose(): void; onTour(): void; onWhatsNew(): void }) {
  useShortcutBlock(open);
  // Phones: an overlay inside the board, so Paseo's own frame (status bar, tabs) stays; a host Modal would cover all of it.
  if (touch)
    return open ? (
      <Theme.Provider value={theme}>
        <SettingsWindow open section={section} projects={projects} onClose={onClose} onTour={onTour} onWhatsNew={onWhatsNew} />
      </Theme.Provider>
    ) : null;
  return (
    <RNModal visible={open} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Theme.Provider value={theme}>
        <SettingsWindow open={open} section={section} projects={projects} onClose={onClose} onTour={onTour} onWhatsNew={onWhatsNew} />
      </Theme.Provider>
    </RNModal>
  );
}

/** Own window instead of the host Modal, whose width is fixed: backdrop, title bar and the two-column body. */
function SettingsWindow({ open, section, projects, onClose, onTour, onWhatsNew }: { open: boolean; section?: SettingsSection; projects: readonly Project[]; onClose(): void; onTour(): void; onWhatsNew(): void }) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  // Phones: fills the plugin's area (above the drawer's layer), instead of a floating window.
  if (touch) {
    return (
      <View accessibilityViewIsModal style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: 40, backgroundColor: colors.surface0 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: space[5], paddingRight: space[3], minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Label bold size={font.lg} selectable={false}>
            {t("Flowly settings")}
          </Label>
          <IconButton icon="X" label={t("Close")} onPress={onClose} />
        </View>
        <SettingsPanes open={open} initial={section} projects={projects} onTour={onTour} onWhatsNew={onWhatsNew} fill />
      </View>
    );
  }
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space[4] }}>
      <Pressable accessible={false} importantForAccessibility="no" onPress={onClose} style={{ ...noFocusRing, ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.45)" }} />
      <View
        accessibilityViewIsModal
        style={{
          width: Math.min(modalMaxWidth, width - 32),
          maxWidth: "100%",
          borderRadius: radius.xl,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface0,
          overflow: "hidden",
          shadowColor: "#000",
          shadowOpacity: 0.25,
          shadowRadius: 24,
          shadowOffset: { width: 0, height: 8 },
          elevation: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: space[5], paddingRight: space[3], minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Label bold size={font.lg} selectable={false}>
            {t("Flowly settings")}
          </Label>
          <IconButton icon="X" label={t("Close")} onPress={onClose} />
        </View>
        <SettingsPanes open={open} initial={section} projects={projects} onTour={onTour} onWhatsNew={onWhatsNew} />
      </View>
    </View>
  );
}

