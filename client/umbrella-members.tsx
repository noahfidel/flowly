import { memo, useMemo, useState } from "react";
import { View } from "react-native";
import type { Project, Task } from "../shared/model";
import { t } from "../shared/i18n";
import { umbrellaLimits, type UmbrellaMember, type UmbrellaSummary } from "../shared/umbrella";
import { PickerGroup, PickerRow } from "./picker";
import { PartTitle } from "./umbrella-feed";
import { useStableCallback } from "./stable";
import { pickableCards, pipelineRows, type PickableCard } from "./umbrella-panel-logic";
import { Actions, Button, Field, IconButton, Label, Notice, Row, font, radius, space, useTheme } from "./ui";

/** Members (UMBRELLA-SPEC §7, D11): the pipeline with the user's own add, remove, role and order controls, and the integration card. */

/** The most rows the picker draws at once; search narrows the rest. */
const shownPicks = 30;

export function Pipeline({ umbrellaId, groupId, members, umbrellas, tasks, projects, writable, busy, onOpen, onAdd, onMove, onRole, onRemove }: {
  umbrellaId: string;
  groupId: string;
  members: readonly UmbrellaMember[];
  umbrellas: readonly UmbrellaSummary[];
  tasks: readonly Task[];
  projects: readonly Project[];
  writable: boolean;
  busy: boolean;
  onOpen(taskId: string): void;
  onAdd(taskId: string, role: string): Promise<boolean>;
  onMove(taskId: string, delta: -1 | 1): void;
  onRole(taskId: string, role: string): Promise<boolean>;
  onRemove(taskId: string): Promise<boolean>;
}) {
  const rows = useMemo(() => pipelineRows(members), [members]);
  const [adding, setAdding] = useState(false);
  return (
    <View style={{ gap: space[1] }}>
      <PartTitle
        title={t("Pipeline")}
        count={rows.length}
        trailing={
          writable && !adding ? (
            <Button small quiet icon="Plus" onPress={() => setAdding(true)}>
              {t("Add cards")}
            </Button>
          ) : undefined
        }
      />
      {adding && writable && (
        <AddCards
          umbrellaId={umbrellaId}
          groupId={groupId}
          full={rows.length >= umbrellaLimits.members}
          umbrellas={umbrellas}
          tasks={tasks}
          projects={projects}
          busy={busy}
          onAdd={onAdd}
          onDone={() => setAdding(false)}
        />
      )}
      {rows.length === 0 && !adding ? (
        <Label muted size={font.sm}>
          {writable ? t("No cards yet. Add cards, or ask the dispatcher or a card's agent to add them.") : t("No cards.")}
        </Label>
      ) : (
        rows.map((m, index) => (
          <PipelineRow key={m.taskId} member={m} first={index === 0} last={index === rows.length - 1} writable={writable} busy={busy} onOpen={onOpen} onMove={onMove} onRole={onRole} onRemove={onRemove} />
        ))
      )}
    </View>
  );
}

const PipelineRow = memo(function PipelineRow({ member, first, last, writable, busy, onOpen, onMove, onRole, onRemove }: {
  member: UmbrellaMember;
  first: boolean;
  last: boolean;
  writable: boolean;
  busy: boolean;
  onOpen(taskId: string): void;
  onMove(taskId: string, delta: -1 | 1): void;
  onRole(taskId: string, role: string): Promise<boolean>;
  onRemove(taskId: string): Promise<boolean>;
}) {
  const [mode, setMode] = useState<"role" | "remove" | null>(null);
  const [role, setRole] = useState("");
  const detail = [member.role, member.laneName, member.projectTitle, member.archived ? t("Archived") : ""].filter(Boolean).join(" · ");
  const saveRole = async () => {
    if (await onRole(member.taskId, role)) setMode(null);
  };
  const remove = async () => {
    if (await onRemove(member.taskId)) setMode(null);
  };
  return (
    <View style={{ gap: space[1.5] }}>
      <Row
        title={member.title}
        detail={detail}
        label={t("Open card {card}", { card: member.title })}
        onPress={() => onOpen(member.taskId)}
        trailing={
          writable && !mode ? (
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <IconButton icon="ChevronUp" size={28} label={t("Move {card} up", { card: member.title })} disabled={busy || first} onPress={() => onMove(member.taskId, -1)} />
              <IconButton icon="ChevronDown" size={28} label={t("Move {card} down", { card: member.title })} disabled={busy || last} onPress={() => onMove(member.taskId, 1)} />
              <IconButton
                icon="Pencil"
                size={28}
                label={t("Change the role of {card}", { card: member.title })}
                disabled={busy}
                onPress={() => {
                  setRole(member.role ?? "");
                  setMode("role");
                }}
              />
              <IconButton icon="X" size={28} label={t("Remove {card} from the umbrella", { card: member.title })} disabled={busy} onPress={() => setMode("remove")} />
            </View>
          ) : undefined
        }
      />
      {mode === "role" && (
        <View style={{ gap: space[2], paddingHorizontal: space[3] }}>
          <Field title={t("Role")} value={role} onChange={setRole} maxLength={umbrellaLimits.role} autoFocus onSubmit={() => void saveRole()} />
          <Actions>
            <Button quiet disabled={busy} onPress={() => setMode(null)}>
              {t("Cancel")}
            </Button>
            <Button primary disabled={busy} onPress={() => void saveRole()}>
              {t("Save")}
            </Button>
          </Actions>
        </View>
      )}
      {mode === "remove" && (
        <View style={{ gap: space[2], paddingHorizontal: space[3] }}>
          <Notice tone="warning">{t("Remove {card} from this umbrella? The card stays as it is.", { card: member.title })}</Notice>
          <Actions>
            <Button quiet disabled={busy} onPress={() => setMode(null)}>
              {t("Cancel")}
            </Button>
            <Button danger disabled={busy} onPress={() => void remove()}>
              {t("Remove")}
            </Button>
          </Actions>
        </View>
      )}
    </View>
  );
});

/** The picker: the group's live cards not in this umbrella, searched by title; a card in another umbrella moves (D11). */
function AddCards({ umbrellaId, groupId, full, umbrellas, tasks, projects, busy, onAdd, onDone }: {
  umbrellaId: string;
  groupId: string;
  full: boolean;
  umbrellas: readonly UmbrellaSummary[];
  tasks: readonly Task[];
  projects: readonly Project[];
  busy: boolean;
  onAdd(taskId: string, role: string): Promise<boolean>;
  onDone(): void;
}) {
  const { colors } = useTheme();
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("");
  const cards = useMemo(() => pickableCards(tasks, projects, umbrellas, groupId, umbrellaId, query), [tasks, projects, umbrellas, groupId, umbrellaId, query]);
  const add = useStableCallback((taskId: string) => void onAdd(taskId, role));
  return (
    <View style={{ gap: space[2], padding: space[2], borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg }}>
      {full ? (
        <Notice>{t("This umbrella has {n} cards, the most it can hold. Remove one first.", { n: umbrellaLimits.members })}</Notice>
      ) : (
        <>
          <Field title={t("Search cards")} value={query} onChange={setQuery} commitDelay={150} autoFocus />
          <Field title={t("Role (optional)")} value={role} onChange={setRole} maxLength={umbrellaLimits.role} />
          {cards.length === 0 ? (
            <Label muted size={font.sm}>
              {t("No other live cards in this group match.")}
            </Label>
          ) : (
            <View style={{ gap: 1 }}>
              {cards.slice(0, shownPicks).map((card) => (
                <PickRow key={card.taskId} card={card} disabled={busy} onAdd={add} />
              ))}
              {cards.length > shownPicks && (
                <Label muted size={font.sm}>
                  {t("Showing {shown} of {total}. Search to narrow.", { shown: shownPicks, total: cards.length })}
                </Label>
              )}
            </View>
          )}
        </>
      )}
      <Actions>
        <Button quiet onPress={onDone}>
          {t("Done")}
        </Button>
      </Actions>
    </View>
  );
}

const PickRow = memo(function PickRow({ card, disabled, onAdd }: { card: PickableCard; disabled: boolean; onAdd(taskId: string): void }) {
  const move = card.moveFrom === undefined ? "" : card.moveFrom ? t("Moves from {umbrella}", { umbrella: card.moveFrom }) : t("Moves from another umbrella");
  return (
    <Row
      icon={card.moveFrom === undefined ? "Plus" : "ArrowRight"}
      title={card.title}
      detail={[card.projectTitle, move].filter(Boolean).join(" · ")}
      label={t("Add {card} to the umbrella", { card: card.title })}
      disabled={disabled}
      onPress={() => onAdd(card.taskId)}
    />
  );
});

/** The integration card (§11): one member, or none. */
export function IntegrationCard({ members, value, writable, busy, onChange }: {
  members: readonly UmbrellaMember[];
  value: string;
  writable: boolean;
  busy: boolean;
  onChange(taskId: string | null): void;
}) {
  const [open, setOpen] = useState(false);
  const options = useMemo(() => [{ value: "", label: t("None") }, ...pipelineRows(members).map((m) => ({ value: m.taskId, label: m.title, ...(m.role ? { detail: m.role } : {}) }))], [members]);
  if (!members.length && !value) return null;
  return (
    <PickerGroup>
      <PickerRow
        first
        title={t("Integration")}
        icon="GitMerge"
        options={options}
        value={value}
        placeholder={t("None")}
        open={open && writable}
        disabled={!writable || busy}
        onToggle={() => setOpen(!open)}
        onChange={(next) => {
          setOpen(false);
          if (next !== value) onChange(next || null);
        }}
      />
    </PickerGroup>
  );
}
