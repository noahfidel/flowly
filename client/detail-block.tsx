import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { Label, font, radius, space, useTheme } from "./ui";

/**
 * The bordered block that shows a tool's input as plain text: an approval's
 * command or edit (SESSION-QUESTION-SPEC) and an expanded tool step's
 * arguments and result (SESSION-PANE-SPEC §1.3).
 *
 * `scroll` (the default): long details scroll inside the block, so an
 * approval's actions below stay in reach. Without it the block grows with its
 * content (the caller clips it with Show more), so a tool step in the
 * transcript adds no nested scroller.
 */
export function DetailBox({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const { colors } = useTheme();
  const frame = { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface0 };
  if (!scroll) return <View style={{ ...frame, padding: space[2], gap: space[1.5], minWidth: 0 }}>{children}</View>;
  return (
    <ScrollView nestedScrollEnabled style={{ maxHeight: 240, ...frame }} contentContainerStyle={{ padding: space[2], gap: space[1.5] }}>
      {children}
    </ScrollView>
  );
}

/** Monospace plain text (never markdown). */
export const Code = ({ children, color }: { children: string; color?: string }) => (
  <Label mono size={font.sm} color={color}>{children}</Label>
);

/** A file path line above a tool's input. */
export const PathLine = ({ children }: { children: string }) => (
  <Label muted size={font.xs} mono>{children}</Label>
);

/** Edits as − replaced and + new text. */
export function EditLines({ edits }: { edits: readonly { old?: string; new?: string }[] }) {
  const { colors } = useTheme();
  return (
    <>
      {edits.map((edit, i) => (
        <View key={`${i}`} style={{ gap: space[1] }}>
          {!!edit.old && <Code color={colors.statusDanger}>{`− ${edit.old}`}</Code>}
          {!!edit.new && <Code color={colors.statusSuccess}>{`+ ${edit.new}`}</Code>}
        </View>
      ))}
    </>
  );
}
