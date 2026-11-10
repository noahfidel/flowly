import { useTaskDetail, invalidateCardViews } from "./card-detail-query";
import { perfStart, perfEnd, usePerfRender } from "./perf";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { AcceptanceItem, PlanSnapshot, Project, Task } from "../shared/model";
import { plansOf, workpadEnabled } from "../shared/workpad";
import { useGuardrailsQuery, useLiveAgents } from "./queries";
import { PagedRows, Section, ShowMore, pageSize, type SectionState } from "./disclosure";
import { FocusTarget, Marked, limitFor, useFocusTarget, useMark } from "./drawer-focus";
import { ReviewBlock, RerunButton, canRerun, reviewLabel } from "./task-review";
import { AiMark, Label, font, message, radius, relativeTime, space, touch, useTheme, noFocusRing } from "./ui";
import { t, tn } from "../shared/i18n";

/**
 * Drawer "Workpad" (GUARDRAILS-SPEC §7.1), the card's own account: the agent's acceptance list, what this card was
 * sent back for, the latest review and the plan from the agent's todo list. Groups without content are not shown.
 * People can tick acceptance items; edits are optimistic and never change the task revision.
 */
export const TaskWorkpad = memo(function TaskWorkpad({
  task,
  project,
  guardrails,
  disabled,
  active,
  section,
}: {
  task: Task;
  project: Project;
  /** Guardrails on for this project (host and project switch): show this card's items and notes. */
  guardrails: boolean;
  disabled: boolean;
  active: boolean;
  section: SectionState;
}) {
  usePerfRender("switch.workpad.commit");
  const switchStart = perfStart();
  const { detail } = useTaskDetail();
  const toast = useToast();
  const queryClient = useQueryClient();
  const checkRpc = useRpc(rpc.checkWorkpad);
  const enabled = workpadEnabled(project);
  const workpad = enabled ? (detail?.workpad ?? undefined) : undefined;
  const plans = useMemo(() => (enabled ? plansOf(detail?.plans || [], task.id) : []), [enabled, detail?.plans, task.id]);
  // This card's items and notes come from the project's guardrails, read while the sidebar shows (§7.4).
  const store = useGuardrailsQuery(project.id, active && guardrails).data;
  const own = useMemo(() => {
    if (!guardrails || !store?.enabled) return { items: [], notes: [] };
    return {
      items: store.items.filter((i) => i.taskId === task.id && i.state !== "closed"),
      notes: store.entries.filter((e) => e.kind === "note" && e.state === "active" && (e.source?.taskId ?? e.sources[0]?.taskId) === task.id),
    };
  }, [guardrails, store, task.id]);
  const review = task.review;
  // Optimistic ticks by item id until the board shows them.
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const agentIds = plans.map((p) => p.agentId).concat(workpad?.agentId ? [workpad.agentId] : []);
  const titleKey = useLiveAgents({
    poll: false,
    select: (agents) => JSON.stringify(agents.filter((a) => agentIds.includes(a.id)).map((a) => [a.id, a.title || a.id])),
  }).data;
  const titles = useMemo(() => new Map<string, string>(titleKey ? JSON.parse(titleKey) : []), [titleKey]);
  // Long lists show 5 items, then Show more adds 5; per opening of the sidebar (DRAWER-SPEC, Section order).
  const [limit, setLimit] = useState(pageSize);
  useEffect(() => {
    if (active) setLimit(pageSize);
  }, [active]);
  // A search hit on an item past the first page shows the pages up to it (DRAWER-SPEC "Focus from search").
  const focusTarget = useFocusTarget();
  useEffect(() => {
    if (!focusTarget.startsWith("workpad:") || !workpad) return;
    const at = workpad.acceptance.findIndex((item) => item.id === focusTarget.slice("workpad:".length));
    if (at >= 0) setLimit((current) => limitFor(at, current, pageSize));
  }, [focusTarget, workpad]);
  const hasThisCard = own.items.length > 0 || own.notes.length > 0;
  if (!workpad && !plans.length && !review && !hasThisCard) return null;
  const tick = async (item: AcceptanceItem) => {
    const done = !item.done;
    setPending((current) => new Map(current).set(item.id, done));
    try {
      await checkRpc({ taskId: task.id, section: "acceptance", itemId: item.id, done });
      await invalidateCardViews(queryClient);
    } catch (e) {
      toast.show(message(e), { variant: "error" });
    } finally {
      setPending((current) => {
        const next = new Map(current);
        next.delete(item.id);
        return next;
      });
    }
  };
  const acceptance = (workpad?.acceptance || []).map((a) => {
    const done = pending.get(a.id);
    return done !== undefined ? { ...a, done, by: "human" as const } : a;
  });
  const updatedBy = !workpad
    ? ""
    : workpad.updatedBy === "human"
      ? t("Updated {time} by you", { time: relativeTime(workpad.updatedAt) })
      : t("Updated {time} by {session}", { time: relativeTime(workpad.updatedAt), session: titles.get(workpad.agentId || "") || t("an agent") });
  perfEnd("switch.workpad.own", switchStart);
  return (
    <Section
      id={task.id}
      focusId="workpad"
      title={t("Workpad")}
      open={section.open}
      onToggle={section.onToggle}
      summary={[
        acceptance.length ? t("Acceptance {done}/{total}", { done: acceptance.filter((a) => a.done).length, total: acceptance.length }) : "",
        review ? reviewLabel(review) : "",
      ].filter(Boolean).join(" · ")}
    >
        {!!acceptance.length && (
          <Group title={t("Acceptance")} note={updatedBy}>
            <PagedRows items={acceptance} limit={limit} render={(item) => (
              <FocusTarget key={item.id} id={`workpad:${item.id}`}>
                <AcceptanceRow item={item} disabled={disabled || pending.has(item.id)} onToggle={() => void tick(item)} />
              </FocusTarget>
            )} />
            {acceptance.length > limit && <ShowMore count={Math.min(pageSize, acceptance.length - limit)} onPress={() => setLimit(limit + pageSize)} />}
          </Group>
        )}
        {hasThisCard && (
          <Group title={t("This card")}>
            {own.items.map((item) => (
              <ThisCardRow key={item.id} icon={item.state === "promoted" ? "ShieldCheck" : "RotateCcw"} quote={item.quote || item.text} note={item.state === "promoted" ? t("Now a project guideline") : tn(item.count, "Sent back {n} time", "Sent back {n} times")} />
            ))}
            {own.notes.map((note) => (
              <ThisCardRow key={note.id} icon="BookMarked" text={note.text} note={t("Remembered for the project")} />
            ))}
          </Group>
        )}
        {!!review && (
          <Group title={t("Review")} action={canRerun(task, project, disabled) ? <RerunButton taskId={task.id} /> : undefined}>
            <ReviewBlock review={review} />
          </Group>
        )}
        {!!plans.length && (
          <Group title={t("Plan")} note={t("From the agent's todo list · updated at turn end")}>
            {plans.map((plan) => (
              <PlanList key={plan.agentId} plan={plan} title={plans.length > 1 ? titles.get(plan.agentId) || t("Session") : ""} />
            ))}
          </Group>
        )}
    </Section>
  );
});

function Group({ title, note, action, children }: { title: string; note?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
        <Label muted size={font.xs} bold selectable={false}>
          {title}
        </Label>
        {!!note && (
          <View style={{ flex: 1, minWidth: 0 }}>
            <Label muted size={font.xs} lines={1} selectable={false}>
              {note}
            </Label>
          </View>
        )}
        {!!action && (
          <>
            {!note && <View style={{ flex: 1 }} />}
            {action}
          </>
        )}
      </View>
      {children}
    </View>
  );
}

const rowStyle = () => ({ flexDirection: "row", alignItems: "flex-start", gap: space[2], paddingVertical: 3 }) as const;

/** A thing this card was sent back for (the user's words, never translated) or a note it left for the project. */
function ThisCardRow({ icon, quote, text, note }: { icon: string; quote?: string; text?: string; note: string }) {
  const { colors } = useTheme();
  return (
    <View style={rowStyle()}>
      <View style={{ marginTop: 2 }}>
        <Icon name={icon} size={14} color={colors.foregroundMuted} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Label size={font.md} italic={!!quote} selectable>
          {quote ? `“${quote}”` : text}
        </Label>
        <Label size={font.sm} muted selectable={false}>
          {note}
        </Label>
      </View>
    </View>
  );
}

function Box({ checked }: { checked: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: 16,
        height: 16,
        marginTop: 1,
        borderRadius: radius.sm,
        borderWidth: 1.5,
        borderColor: checked ? colors.accent : colors.foregroundMuted,
        backgroundColor: checked ? colors.accent : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {checked && <Icon name="Check" size={12} color={colors.accentForeground} />}
    </View>
  );
}

function AcceptanceRow({ item, disabled, onToggle }: { item: AcceptanceItem; disabled: boolean; onToggle(): void }) {
  const mark = useMark(`workpad:${item.id}`);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={item.text}
      accessibilityState={{ checked: item.done, disabled }}
      aria-checked={item.done}
      disabled={disabled}
      onPress={onToggle}
      style={({ pressed }) => ({ ...noFocusRing, ...rowStyle(), minHeight: touch ? 36 : undefined, opacity: pressed ? 0.7 : 1 })}
    >
      <Box checked={item.done} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.md}><Marked text={item.text} terms={mark?.terms} /></Label>
      </View>
      {item.by === "human" && (
        <Label size={font.sm} muted selectable={false}>
          {t("by you")}
        </Label>
      )}
    </Pressable>
  );
}

function PlanList({ plan, title }: { plan: PlanSnapshot; title: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 1 }}>
      {!!title && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
          <AiMark size={11} />
          <Label size={font.xs} muted lines={1} selectable={false}>
            {title}
          </Label>
        </View>
      )}
      {plan.items.map((item, index) => (
        <View key={index} style={{ ...rowStyle(), paddingVertical: 1 }}>
          <View style={{ marginTop: 1 }}>
            <Icon
              name={item.status === "completed" ? "CircleCheck" : item.status === "in_progress" ? "CircleDot" : "Circle"}
              size={14}
              color={item.status === "completed" ? colors.statusSuccess : item.status === "in_progress" ? colors.accent : colors.foregroundMuted}
            />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Label size={font.md} muted={item.status === "completed"}>
              {item.text}
            </Label>
          </View>
        </View>
      ))}
    </View>
  );
}
