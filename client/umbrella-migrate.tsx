import { memo, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import * as rpc from "../shared/rpc";
import type { Group, Link, Project, Task } from "../shared/model";
import { msg, t } from "../shared/i18n";
import { noteEntryInput, notesToOffer, relatedComponent, umbrellaLimits } from "../shared/umbrella";
import { useGuardrailsQueries } from "./queries";
import { useStableCallback } from "./stable";
import { PartTitle } from "./umbrella-feed";
import { errorCode, proposedMembers, runMigration, startCards, type MigrationResult } from "./umbrella-panel-logic";
import { Actions, Button, Field, Label, Notice, Row, font, message, noFocusRing, radius, space, touch, useTheme } from "./ui";

/**
 * Create from related cards (UMBRELLA-SPEC §12), the one-time move from the light version: the user picks a start card,
 * Flowly proposes its connected `related` component (same tag, same group) as members, the user types or pastes the brief
 * (Flowly reads no files), and each tagged project note is offered for copying into the feed, one tick each. Links and
 * tags stay as they are. The run is client-side and stops at the first failure without undoing what it made.
 */

const kindText = {
  decision: msg("Decision"),
  convention: msg("Convention"),
  pitfall: msg("Pitfall"),
  finding: msg("Finding"),
} as const;

/** The most start-card rows drawn at once; search narrows the rest. */
const shownStarts = 20;

export function MigrateUmbrella({ groupId, tasks, projects, links, groups, onCancel, onOpen }: {
  groupId: string;
  tasks: readonly Task[];
  projects: readonly Project[];
  links: Link[];
  groups: Group[];
  onCancel(): void;
  /** Opens the new umbrella in the panel. */
  onOpen(id: string): void;
}) {
  const createUmbrella = useRpc(rpc.createUmbrella);
  const setMember = useRpc(rpc.setUmbrellaMember);
  const addEntry = useRpc(rpc.createUmbrellaEntry);
  const [query, setQuery] = useState("");
  const [startId, setStartId] = useState("");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  // Unticked ids: the proposal is all ticked, so only the user's unticks are state (and a changed start card resets them).
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [notePicks, setNotePicks] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<MigrationResult | null>(null);

  const picks = useMemo(() => startCards(tasks, projects, groupId, query), [tasks, projects, groupId, query]);
  const start = tasks.find((x) => x.id === startId);
  const component = useMemo(() => (start ? relatedComponent({ tasks: [...tasks], links, projects: [...projects], groups }, start.id) : []), [start, tasks, links, projects, groups]);
  const proposed = useMemo(() => (start ? proposedMembers(start.id, component, umbrellaLimits.members) : []), [start, component]);
  const byId = useMemo(() => new Map(tasks.map((x) => [x.id, x])), [tasks]);
  const projectTitle = useMemo(() => new Map(projects.map((p) => [p.id, p.title])), [projects]);
  const ticked = proposed.filter((id) => id === startId || !unticked.has(id));
  const tooMany = ticked.length > umbrellaLimits.members;

  // Project notes that share a tag with a ticked member, read per project through the shared guardrail queries.
  const noteProjects = useMemo(() => [...new Set(ticked.flatMap((id) => byId.get(id)?.projectId ?? []))], [ticked.join(","), byId]);
  const queries = useGuardrailsQueries(noteProjects, !!start);
  const stamp = queries.map((q) => q.dataUpdatedAt).join(",");
  const offered = useMemo(
    () =>
      notesToOffer(
        queries.flatMap((q) => q.data?.entries ?? []),
        ticked.flatMap((id) => {
          const card = byId.get(id);
          return card ? [{ projectId: card.projectId, tags: (card.tags ?? []).map((x) => x.tag) }] : [];
        }),
      ),
    [stamp, ticked.join(","), byId],
  );
  const chosenNotes = offered.filter((n) => notePicks.has(n.id));

  const pickStart = useStableCallback((id: string) => {
    setStartId(id);
    setUnticked(new Set());
    setNotePicks(new Set());
    const card = byId.get(id);
    setTitle((old) => old || (card?.title ?? "").slice(0, umbrellaLimits.title));
  });
  const toggleMember = useStableCallback((id: string) =>
    setUnticked((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    }),
  );
  const toggleNote = useStableCallback((id: string) =>
    setNotePicks((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    }),
  );

  const submit = async () => {
    if (!start || !title.trim() || busy || tooMany) return;
    setBusy(true);
    setError("");
    try {
      const run = await runMigration(
        { groupId, title, brief, memberIds: ticked, notes: chosenNotes.map(noteEntryInput) },
        {
          create: (input) => createUmbrella(input),
          setMember: (input) => setMember(input),
          addEntry: (input) => addEntry(input),
        },
      );
      if (!run.error) onOpen(run.umbrellaId);
      else setResult(run);
    } catch (e) {
      setError(errorCode(e) === "UMBRELLA_LIMIT" ? t("This group already has 50 open umbrellas. Close one first.") : message(e));
    } finally {
      setBusy(false);
    }
  };

  if (result)
    return (
      <View style={{ gap: space[3] }}>
        <Notice>{t("Created, but not everything was added: {error}", { error: message(result.error) })}</Notice>
        {result.missedMembers.length > 0 && (
          <Label size={font.sm}>{t("Cards not added: {titles}", { titles: result.missedMembers.map((id) => byId.get(id)?.title ?? id).join(", ") })}</Label>
        )}
        {result.missedNotes.length > 0 && <Label size={font.sm}>{t("Notes not copied: {titles}", { titles: result.missedNotes.join(", ") })}</Label>}
        <Actions>
          <Button primary onPress={() => onOpen(result.umbrellaId)}>
            {t("Open umbrella")}
          </Button>
        </Actions>
      </View>
    );

  return (
    <View style={{ gap: space[3] }}>
      <PartTitle title={t("Create from related cards")} />
      {start ? (
        <Row
          icon="Check"
          title={start.title}
          detail={[t("Start card"), projectTitle.get(start.projectId)].filter(Boolean).join(" · ")}
          label={t("Change start card")}
          disabled={busy}
          onPress={() => setStartId("")}
        />
      ) : (
        <View style={{ gap: space[2] }}>
          <Field title={t("Search cards")} value={query} onChange={setQuery} commitDelay={150} autoFocus />
          {picks.length === 0 ? (
            <Label muted size={font.sm}>
              {t("No other live cards in this group match.")}
            </Label>
          ) : (
            <View style={{ gap: 1 }}>
              {picks.slice(0, shownStarts).map((card) => (
                <StartRow key={card.taskId} id={card.taskId} title={card.title} detail={card.projectTitle} onPick={pickStart} />
              ))}
              {picks.length > shownStarts && (
                <Label muted size={font.sm}>
                  {t("Showing {shown} of {total}. Search to narrow.", { shown: shownStarts, total: picks.length })}
                </Label>
              )}
            </View>
          )}
        </View>
      )}
      {start && (
        <>
          <Field title={t("Title")} value={title} onChange={setTitle} maxLength={umbrellaLimits.title} />
          <Field title={t("Brief (optional)")} value={brief} onChange={setBrief} multiline maxLength={umbrellaLimits.brief} />
          <View style={{ gap: space[1] }}>
            <PartTitle title={t("Cards")} count={ticked.length} />
            {component.length === 0 && (
              <Label muted size={font.sm}>
                {t("No related cards share a tag with this card. The umbrella starts with this card alone.")}
              </Label>
            )}
            {proposed.map((id) => (
              <TickRow
                key={id}
                id={id}
                text={byId.get(id)?.title ?? id}
                detail={projectTitle.get(byId.get(id)?.projectId ?? "")}
                checked={id === startId || !unticked.has(id)}
                disabled={busy || id === startId}
                onToggle={toggleMember}
              />
            ))}
            {tooMany && <Notice>{t("This umbrella has {n} cards, the most it can hold. Remove one first.", { n: umbrellaLimits.members })}</Notice>}
          </View>
          {offered.length > 0 && (
            <View style={{ gap: space[1] }}>
              <PartTitle title={t("Notes to copy")} count={chosenNotes.length} />
              {offered.map((n) => (
                <TickRow
                  key={n.id}
                  id={n.id}
                  text={n.text}
                  detail={t(kindText[noteEntryInput(n).kind])}
                  checked={notePicks.has(n.id)}
                  disabled={busy}
                  onToggle={toggleNote}
                />
              ))}
            </View>
          )}
        </>
      )}
      {!!error && <Notice>{error}</Notice>}
      <Actions>
        <Button quiet disabled={busy} onPress={onCancel}>
          {t("Cancel")}
        </Button>
        <Button primary disabled={busy || !start || !title.trim() || tooMany} onPress={() => void submit()}>
          {t("Create")}
        </Button>
      </Actions>
    </View>
  );
}

const StartRow = memo(function StartRow({ id, title, detail, onPick }: { id: string; title: string; detail: string; onPick(id: string): void }) {
  return <Row icon="Plus" title={title} detail={detail} label={title} onPress={() => onPick(id)} />;
});

const TickRow = memo(function TickRow({ id, text, detail, checked, disabled, onToggle }: {
  id: string;
  text: string;
  detail?: string | undefined;
  checked: boolean;
  disabled: boolean;
  onToggle(id: string): void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={text}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={() => onToggle(id)}
      style={({ pressed }) => ({ ...noFocusRing, flexDirection: "row", alignItems: "flex-start", gap: space[2], minHeight: touch ? 36 : undefined, paddingVertical: 2, opacity: pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          width: 16, height: 16, marginTop: 1, borderRadius: radius.sm, borderWidth: 1.5,
          borderColor: checked ? colors.accent : colors.foregroundMuted, backgroundColor: checked ? colors.accent : "transparent",
          alignItems: "center", justifyContent: "center",
        }}
      >
        {checked && <Icon name="Check" size={12} color={colors.accentForeground} />}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.md}>{text}</Label>
        {!!detail && (
          <Label muted size={font.xs}>
            {detail}
          </Label>
        )}
      </View>
    </Pressable>
  );
});
