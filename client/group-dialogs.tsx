import { useState } from "react";
import { View } from "react-native";
import { useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { groupLimits } from "../shared/model";
import { Modal } from "./modal";
import { Actions, Button, Field, Label, Theme, message } from "./ui";
import { t } from "../shared/i18n";

/** A group write's refusal in the server's words: the daemon sends `CODE: message` (BOARD-GROUPS-SPEC §2). */
export const groupRefusal = (error: unknown) => message(error).replace(/^[A-Z][A-Z_]+: /, "");

/** Name a group: Add group (switcher) and Rename group (the group settings hook until its page ships). */
export function GroupNameDialog({
  title,
  initial = "",
  saveLabel,
  theme,
  onClose,
  onSave,
}: {
  title: string;
  initial?: string;
  saveLabel: string;
  theme: PluginTheme;
  onClose(): void;
  /** Rejects with the server's refusal; the dialog stays open and shows it as a toast. */
  onSave(name: string): Promise<unknown>;
}) {
  const toast = useToast();
  const [name, setName] = useState(initial),
    [pending, setPending] = useState(false);
  const trimmed = name.trim();
  const ready = !!trimmed && !pending && trimmed !== initial.trim();
  async function save() {
    if (!ready) return;
    setPending(true);
    try {
      await onSave(trimmed);
    } catch (e) {
      toast.error(groupRefusal(e));
      setPending(false);
    }
  }
  return (
    <Modal
      open
      title={title}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: 12 }}>
            <Field
              title={t("Name")}
              value={name}
              onChange={setName}
              autoFocus
              maxLength={groupLimits.name}
              onSubmit={ready ? () => void save() : undefined}
            />
            <Actions>
              <Button quiet disabled={pending} onPress={onClose}>
                {t("Cancel")}</Button>
              <Button primary disabled={!ready} onPress={() => void save()}>
                {saveLabel}</Button>
            </Actions>
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

/** Delete group… (BOARD-GROUPS-SPEC §2): its projects move to the default group; its dispatcher is archived. */
export function DeleteGroupDialog({
  name,
  defaultName,
  theme,
  onClose,
  onDelete,
}: {
  name: string;
  defaultName: string;
  theme: PluginTheme;
  onClose(): void;
  /** Rejects with the server's refusal; the dialog stays open and shows it as a toast. */
  onDelete(): Promise<unknown>;
}) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  async function confirm() {
    setPending(true);
    try {
      await onDelete();
    } catch (e) {
      toast.error(groupRefusal(e));
      setPending(false);
    }
  }
  return (
    <Modal
      open
      title={t("Delete group {name}?", { name })}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: 12 }}>
            <Label>{t("Its projects move to {default}. Its dispatcher session, if any, is archived.", { default: defaultName })}</Label>
            <Actions>
              <Button quiet disabled={pending} onPress={onClose}>
                {t("Cancel")}</Button>
              <Button danger disabled={pending} onPress={() => void confirm()}>
                {t("Delete group")}</Button>
            </Actions>
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}
