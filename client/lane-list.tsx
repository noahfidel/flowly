import type { ReactElement } from "react";
import { View } from "react-native";
import { FlatList, ScrollView } from "@getpaseo/plugin/client/react-native";
import { space, verticalContent, verticalScroll } from "./ui";
import { newTaskFabSize } from "./new-task-fab";

const separator = () => <View style={{ height: space[2] }} />;

/**
 * The phone's lane list. Only the cards near the screen are mounted, so a long
 * lane costs one screen of views and card reads, not the whole lane's
 * (PERFORMANCE-SPEC §3). Remount it (a `key`) to start at the top. If a host
 * does not provide FlatList, falls back to a plain scroll of every row.
 */
export function LaneList<T>({
  data,
  keyOf,
  renderItem,
}: {
  data: readonly T[];
  keyOf(row: T): string;
  renderItem(row: T): ReactElement;
}) {
  const content = {
    ...verticalContent,
    padding: space[3],
    paddingTop: space[1],
    // Clears the floating New task and Settings buttons, so the last card stays reachable.
    paddingBottom: newTaskFabSize + space[3] * 2,
  };
  const common = { ...verticalScroll, style: { flex: 1, minHeight: 0 }, nestedScrollEnabled: true, keyboardShouldPersistTaps: "handled" as const };
  if (typeof FlatList !== "function")
    return (
      <ScrollView {...common} contentContainerStyle={{ ...content, gap: space[2] }}>
        {data.map((row) => (
          <View key={keyOf(row)}>{renderItem(row)}</View>
        ))}
      </ScrollView>
    );
  return (
    <FlatList
      {...common}
      data={data as T[]}
      keyExtractor={keyOf}
      renderItem={({ item }) => renderItem(item)}
      ItemSeparatorComponent={separator}
      contentContainerStyle={content}
      initialNumToRender={8}
      maxToRenderPerBatch={6}
      windowSize={7}
    />
  );
}
