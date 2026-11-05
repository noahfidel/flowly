import { usePerfRender } from "./perf";
import { memo, useState } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { taskTypeLabels, type Status } from "../shared/model";
import { searchLimits, searchSources, type SearchCard, type SearchHit, type SearchMemoryHit, type SearchSource } from "../shared/search";
import { FilterChip } from "./ideas-page";
import { kindLabels } from "./memory";
import { Enter, useMotionValue } from "./motion";
import { StatusIcon } from "./status";
import { useStableCallback } from "./stable";
import { Button, Choices, Label, Notice, TextBox, font, message, noFocusRing, pageBarHeight, radius, space, tint, touch, useTheme, verticalContent, verticalScroll } from "./ui";
import { t, msg } from "../shared/i18n";

/** The Search page (SEARCH-SPEC §5). Replaces the board area while open, like Ideas and Memory. */

const sourceChips: Record<SearchSource, { label: string; icon: string }> = {
  card: { label: msg("Cards"), icon: "SquareKanban" },
  summary: { label: msg("Summaries"), icon: "ScrollText" },
  note: { label: msg("Notes"), icon: "MessageSquareText" },
  workpad: { label: msg("Workpads"), icon: "ListChecks" },
  idea: { label: msg("Ideas"), icon: "Lightbulb" },
  artifact: { label: msg("Deliverables"), icon: "Package" },
  memory: { label: msg("Memory"), icon: "BookMarked" },
};
const hitLabels: Record<SearchSource, string> = {
  card: msg("Card"),
  summary: msg("Summary"),
  note: msg("Note"),
  workpad: msg("Workpad"),
  idea: msg("Idea"),
  artifact: msg("Deliverable"),
  memory: msg("Memory"),
};
const ideaStatusLabels = { open: msg("Open"), accepted: msg("Accepted"), dismissed: msg("Dismissed") } as const;

export function useSearchQuery(query: string, projectId: string | null, sources: readonly SearchSource[], enabled: boolean) {
  const run = useRpc(rpc.searchQuery);
  const text = query.trim();
  return useQuery({
    queryKey: ["flowly", "search", projectId, text, sources.join(",")],
    queryFn: () => run({ query: text, projectId, ...(sources.length ? { sources: [...sources] } : {}), limit: searchLimits.cardsDefault }),
    enabled: enabled && !!text,
    staleTime: 0,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    placeholderData: (previous) => previous,
  });
}

/** Snippet text with the matched words in bold accent. */
function Snippet({ snippet, ranges, lines = 2 }: { snippet: string; ranges: readonly (readonly [number, number])[]; lines?: number }) {
  const { colors } = useTheme();
  const parts: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], i) => {
    if (start > at) parts.push(snippet.slice(at, start));
    parts.push(
      <Text key={i} style={{ fontWeight: "600", color: colors.accent }}>
        {snippet.slice(start, end)}
      </Text>,
    );
    at = end;
  });
  if (at < snippet.length) parts.push(snippet.slice(at));
  return (
    <Label muted size={font.sm} lines={lines}>
      {parts}
    </Label>
  );
}

const HitRow = memo(function HitRow({ hit, onOpen }: { hit: SearchHit; onOpen(hit: SearchHit): void }) {
  const { colors } = useTheme();
  const label = hit.status && hit.status !== "open" ? `${t(hitLabels[hit.source])} · ${t(ideaStatusLabels[hit.status])}` : t(hitLabels[hit.source]);
  // Opens the card at this hit (DRAWER-SPEC "Focus from search").
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${hit.snippet}`}
      onPress={() => onOpen(hit)}
      style={(state) => {
        const { pressed, hovered } = state as typeof state & { hovered?: boolean };
        return { ...noFocusRing, flexDirection: "row", gap: space[2], alignItems: "flex-start", marginHorizontal: -space[1.5], paddingHorizontal: space[1.5], paddingVertical: 2, borderRadius: radius.sm, backgroundColor: pressed || hovered ? tint(colors.accent, 0.08) : "transparent" };
      }}
    >
      <View style={{ width: 84, flexShrink: 0, paddingTop: 1 }}>
        <Label size={font.xs} muted medium selectable={false} lines={1}>
          {label}
        </Label>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Snippet snippet={hit.snippet} ranges={hit.ranges} />
      </View>
    </Pressable>
  );
});

const CardResult = memo(function CardResult({
  card,
  showProject,
  nameOf,
  onOpen,
}: {
  card: SearchCard;
  showProject: boolean;
  nameOf(status: Status): string;
  onOpen(card: SearchCard, hit?: SearchHit): void;
}) {
  const { colors } = useTheme();
  const openHit = useStableCallback((hit: SearchHit) => onOpen(card, hit));
  const hits = card.hits.filter((h) => !(h.source === "card" && h.field === "title"));
  const meta = [nameOf(card.status), card.type ? taskTypeLabels[card.type] : "", showProject ? card.projectTitle : "", card.archived ? t("Archived") : ""].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={card.title}
      onPress={() => onOpen(card)}
      style={(state) => {
        const { pressed, hovered } = state as typeof state & { hovered?: boolean };
        return {
          ...noFocusRing,
          gap: space[1.5],
          padding: space[3],
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: pressed || hovered ? colors.surface2 : colors.surface1,
        };
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
        <StatusIcon status={card.status} size={14} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label medium size={font.base} lines={1} selectable={false}>
            {card.title}
          </Label>
        </View>
      </View>
      <Label muted size={font.xs} lines={1} selectable={false}>
        {meta}
      </Label>
      {hits.map((hit, i) => (
        <HitRow key={`${hit.source}:${hit.refId || ""}:${hit.field}:${i}`} hit={hit} onOpen={openHit} />
      ))}
    </Pressable>
  );
});

const MemoryResult = memo(function MemoryResult({ hit, onOpen }: { hit: SearchMemoryHit; onOpen(hit: SearchMemoryHit): void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hit.title}
      onPress={() => onOpen(hit)}
      style={(state) => {
        const { pressed, hovered } = state as typeof state & { hovered?: boolean };
        return {
          ...noFocusRing,
          gap: space[1],
          padding: space[3],
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: pressed || hovered ? colors.surface2 : colors.surface1,
        };
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
        <Label size={font.xs} muted medium selectable={false}>
          {t(kindLabels[hit.kind])}
        </Label>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label medium size={font.base} lines={1} selectable={false}>
            {hit.title}
          </Label>
        </View>
      </View>
      <Snippet snippet={hit.snippet} ranges={hit.ranges} />
    </Pressable>
  );
});

export const SearchPage = memo(function SearchPage({
  projectId,
  seed,
  compact,
  sources: allowed,
  nameOf,
  onOpenCard,
  onOpenMemory,
  onBack,
}: {
  /** null on the All projects board: always all projects, no scope choice (ALL-PROJECTS-SPEC §6). */
  projectId: string | null;
  /** Text to start with (Search everywhere from the board filter). */
  seed: string;
  compact: boolean;
  /** Sources that are turned on (Ideas, deliverables and memory follow their switches). */
  sources: readonly SearchSource[];
  nameOf(status: Status): string;
  onOpenCard(card: SearchCard, hit?: SearchHit): void;
  onOpenMemory(hit: SearchMemoryHit): void;
  onBack(): void;
}) {
  usePerfRender("project.search.render");
  const { colors } = useTheme();
  const [query, setQuery] = useState(seed);
  const [scope, setScope] = useState<"project" | "all">("project");
  const [chosen, setChosen] = useState<ReadonlySet<SearchSource>>(() => new Set());
  const picked = searchSources.filter((s) => chosen.has(s) && allowed.includes(s));
  const result = useSearchQuery(query, scope === "all" || !projectId ? null : projectId, picked.length ? picked : allowed, true);
  const data = query.trim() ? result.data : undefined;
  // While a new query runs the previous results stay, dimmed; each new response rises in (SEARCH-SPEC §5.2).
  const dim = useMotionValue(!!query.trim() && result.isFetching ? 0.5 : 1);
  const toggle = (source: SearchSource) =>
    setChosen((previous) => {
      const next = new Set(previous);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], paddingHorizontal: space[3], height: pageBarHeight, borderBottomWidth: 1, borderColor: colors.border }}>
        <Button quiet icon="ChevronLeft" label={t("Back to board (Esc)")} onPress={onBack}>
          {t("Board")}</Button>
        <View style={{ flex: 1 }} />
        <Icon name="Search" size={15} color={colors.foregroundMuted} />
        <Label bold size={font.md} selectable={false}>
          {t("Search")}</Label>
        <View style={{ flex: 1 }} />
        <View style={{ width: compact ? 56 : 72 }} />
      </View>
      <ScrollView {...verticalScroll} keyboardShouldPersistTaps="handled" style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ ...verticalContent, padding: space[3], paddingBottom: space[6] * 2, alignItems: "center" }}>
        <View style={{ width: "100%", maxWidth: 760, gap: space[3] }}>
          <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: space[2] }}>
            <View style={{ flex: compact ? undefined : 1, minWidth: 0 }}>
              <TextBox
                value={query}
                onChangeText={setQuery}
                commitDelay={250}
                autoFocus
                // Shortcuts are blocked while typing, so Esc is handled here to leave the page (SEARCH-SPEC §5.1).
                onKeyPress={(event) => {
                  if (event.nativeEvent.key === "Escape") onBack();
                }}
                placeholder={t("Search cards, notes and deliverables")}
                accessibilityLabel={t("Search")}
                style={{ height: touch ? 40 : 32, paddingHorizontal: space[3], borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, color: colors.foreground, fontSize: font.base }}
              />
            </View>
            {!!projectId && <Choices
              title={t("Search in")}
              hideTitle
              value={scope}
              options={[
                { value: "project", label: t("This project") },
                { value: "all", label: t("All projects") },
              ]}
              onChange={setScope}
            />}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1.5] }}>
            {allowed.map((source) => (
              <FilterChip key={source} on={chosen.has(source)} icon={sourceChips[source].icon} label={t(sourceChips[source].label)} onPress={() => toggle(source)} />
            ))}
          </View>
          {result.error && !!query.trim() && <Notice>{message(result.error)}</Notice>}
          {data?.partial.includes("summaries") && <Notice tone="warning">{t("Summaries could not be read")}</Notice>}
          {data?.partial.includes("memory") && <Notice tone="warning">{t("Memory could not be read")}</Notice>}
          <Animated.View style={{ opacity: dim }}>
          <Enter key={result.dataUpdatedAt} style={{ gap: space[3] }}>
          {data && !data.cards.length && !data.memory.length && (
            <View style={{ paddingVertical: space[4], alignItems: "center" }}>
              <Label muted selectable={false}>{t("No results")}</Label>
            </View>
          )}
          {data?.cards.map((card) => (
            <CardResult key={card.taskId} card={card} showProject={scope === "all"} nameOf={nameOf} onOpen={onOpenCard} />
          ))}
          {!!data?.memory.length && (
            <View style={{ gap: space[2], paddingTop: space[2] }}>
              <Label medium size={font.sm} muted selectable={false}>
                {t("Memory")}</Label>
              {data.memory.map((hit) => (
                <MemoryResult key={hit.id} hit={hit} onOpen={onOpenMemory} />
              ))}
            </View>
          )}
          {data?.truncated && data.cards.length >= searchLimits.cardsDefault && (
            <Label muted size={font.sm} selectable={false}>
              {t("Showing the first {n} cards", { n: searchLimits.cardsDefault })}</Label>
          )}
          </Enter>
          </Animated.View>
        </View>
      </ScrollView>
    </View>
  );
});
