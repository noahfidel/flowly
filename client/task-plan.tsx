import { memo, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { Task } from "../shared/model";
import { artifactsOf } from "../shared/artifacts";
import { planApproved, planOf } from "../shared/plans";
import { useTaskDetail, invalidateCardViews } from "./card-detail-query";
import { ArtifactForm, ArtifactPreview, useArtifactMissing } from "./task-artifacts";
import { FocusTarget } from "./drawer-focus";
import { eventPoint, useMenuOpener, type MenuEntry } from "./context-menu";
import { IconButton, Label, font, message, relativeTime, space, touch, useTheme, noFocusRing } from "./ui";
import { t } from "../shared/i18n";

/**
 * The card's plan (CARD-PLAN-SPEC §2.1): one row under the description, above the sections. It opens like an
 * artifact; its menu approves a draft, replaces, edits or removes it. A card without a plan shows Set plan instead.
 */
export const TaskPlan = memo(function TaskPlan({ task, active, archived }: { task: Task; active: boolean; /** The card or its project is archived. */ archived: boolean }) {
  const { detail } = useTaskDetail();
  const { colors } = useTheme();
  const toast = useToast();
  const queryClient = useQueryClient();
  const approve = useRpc(rpc.approvePlan);
  const clear = useRpc(rpc.clearPlan);
  const openMenu = useMenuOpener();
  const [form, setForm] = useState<"set" | "edit" | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [pending, setPending] = useState(false);
  const all = useMemo(() => (detail ? artifactsOf(detail.artifacts, task.id) : []), [detail, task.id]);
  const plan = useMemo(() => planOf(all, task.id), [all, task.id]);
  // Same list as the Artifacts section, so both read one status query.
  const missing = useArtifactMissing(task.id, all);
  if (!detail) return null;
  const formView = form && (
    <ArtifactForm task={task} artifact={form === "edit" ? plan : null} preset={form === "set" ? "plan" : undefined} onClose={() => setForm(null)} />
  );
  if (!plan) {
    if (archived) return null;
    return (
      <>
        <Pressable
          accessibilityRole="button"
          disabled={!active}
          onPress={() => setForm("set")}
          style={({ pressed }) => ({ ...noFocusRing, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: space[1], minHeight: touch ? 36 : 24, opacity: pressed ? 0.7 : 1 })}
        >
          <Icon name="Plus" size={13} color={colors.foregroundMuted} />
          <Label muted size={font.sm} selectable={false}>{t("Set plan")}</Label>
        </Pressable>
        {formView}
      </>
    );
  }
  const approved = planApproved(plan);
  const isMissing = missing.has(plan.id);
  const state = approved ? t("Approved {time}", { time: relativeTime(plan.plan.approvedAt) }) : t("Draft");
  const run = async (action: () => Promise<unknown>, done: string) => {
    if (pending) return;
    setPending(true);
    try {
      await action();
      await invalidateCardViews(queryClient);
      toast.show(done, { variant: "success" });
    } catch (e) {
      toast.show(message(e), { variant: "error" });
    } finally {
      setPending(false);
    }
  };
  const entries = (): MenuEntry[] => [
    ...(approved ? [] : [{ id: "approve", label: t("Mark approved"), icon: "Check", onPress: () => void run(() => approve({ taskId: task.id }), t("Plan approved")) }]),
    { id: "replace", label: t("Replace…"), icon: "Replace", onPress: () => setForm("set") },
    { id: "edit", label: t("Edit…"), icon: "Pencil", onPress: () => setForm("edit") },
    {
      id: "remove",
      label: t("Remove"),
      icon: "X",
      onPress: () => void run(() => clear({ taskId: task.id }), plan.role === "output" ? t("Plan removed. It stays in Outputs.") : t("Plan removed. It stays in Inputs.")),
    },
  ];
  const open = () => {
    if (plan.kind === "url") return void openExternalUrl(plan.target).catch(() => toast.show(t("Could not open the link."), { variant: "error" }));
    setPreviewing(true);
  };
  return (
    <>
      <FocusTarget id={`artifact:${plan.id}`}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[1], minHeight: touch ? 44 : 34 }}>
          <Pressable
            accessibilityRole={plan.kind === "url" ? "link" : "button"}
            accessibilityLabel={`${t("Plan")}: ${plan.title}, ${isMissing ? `${t("Missing")}, ` : ""}${state}`}
            onPress={open}
            style={({ pressed }) => ({ ...noFocusRing, flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space[1.5], opacity: pressed ? 0.7 : 1 })}
          >
            <Icon name={plan.kind === "url" ? "Link" : "FileText"} size={14} color={isMissing ? colors.foregroundMuted : colors.foreground} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Label size={font.md} muted={isMissing} lines={1} selectable={false}>{plan.title}</Label>
              <Label size={font.sm} muted lines={1} selectable={false}>
                {isMissing && `${t("Missing")} · `}
                {state}
              </Label>
            </View>
          </Pressable>
          <IconButton
            icon="Ellipsis"
            size={touch ? 36 : 24}
            label={t("Actions for {title}", { title: plan.title })}
            disabled={!active || archived || pending || !openMenu}
            onPress={(event) => openMenu?.(eventPoint(event), plan.title, entries())}
          />
        </View>
      </FocusTarget>
      {formView}
      {previewing && <ArtifactPreview artifact={plan} onClose={() => setPreviewing(false)} />}
    </>
  );
});
