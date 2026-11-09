import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text as NativeText, View } from "react-native";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { IconButton, font, message, noFocusRing, tint, touch, useTheme, space } from "./ui";
import { useShortcutBlock } from "./shortcuts";
import { sendBehaviorText, type SendBehavior } from "./send-queue";
import { imageInputSupported, listenForImages, pickImageFiles, readImages, type Attachment } from "./web-images";
import { AttachmentThumb } from "./image-attach";
import { maxImages } from "../shared/composer";
import { composerEnterAction, createDraftBuffer, createDraftReporter, type ComposerKey } from "./session-input";
import { t } from "../shared/i18n";

/**
 * The session message box, shared by a card's session view and the dispatcher chat (SESSION-PANE-SPEC,
 * DISPATCHER-SPEC §9.3). `useComposerDraft` holds the text and images in the parent, so they outlive the box
 * when it is hidden for a moment; `ComposerBox` draws it.
 */

/** Composer text area: vertical padding and the one-line height (20 px line). */
const inputPad = 4;
const inputMin = 20 + 2 * inputPad;

export function useComposerDraft({
  sessionId,
  draft,
  onDraftChange,
  isMounted,
}: {
  sessionId: string;
  /** The parent's copy of the text; outside changes (restore, clear after send) are shown in the box. */
  draft: string;
  onDraftChange(sessionId: string, text: string, expectedDraft?: string): void;
  isMounted(): boolean;
}) {
  const toast = useToast();
  const [draftBuffer] = useState(() => createDraftBuffer(draft));
  // Native (phone) typing: the input owns its text. Pushing every keystroke
  // through the parent's state and back as a controlled value re-renders the
  // whole session view and can reset the IME's composition, so the screen
  // jumps and the next group of characters is disturbed (worse over a remote
  // connection). The parent hears about changes after a short pause (at once
  // when the box turns empty/non-empty); only outside changes (restore, clear
  // after send, edit a queued message) reset the input.
  const ownInput = Platform.OS !== "web";
  // Web: the controlled value is authoritative. Native: the buffer follows the
  // input and only outside changes (below) replace it, since the parent's copy
  // may lag behind what was typed.
  if (!ownInput) draftBuffer.sync(draft);
  const [inputKey, setInputKey] = useState(0);
  // Native: the text a mount starts from. Never follow `draft` here — RN sends a
  // changed defaultValue to the native input as new text, so a debounced (stale)
  // report would overwrite what was typed meanwhile and drop characters.
  const [inputSeed, setInputSeed] = useState(draft);
  const latestChange = useRef(onDraftChange);
  latestChange.current = onDraftChange;
  const [reporter] = useState(() => createDraftReporter(draft, (text) => latestChange.current(sessionId, text)));
  const flush = () => reporter.flush();
  const reportDraft = (text: string) => (ownInput ? reporter.change(text) : onDraftChange(sessionId, text));
  useEffect(() => () => reporter.flush(), []);
  const inputRef = useRef<{ clear?(): void; focus?(): void } | null>(null);
  const refocus = useRef(false);
  // A picked next move remounts the native input with its text: focus that mount.
  const focusNext = useRef(false);
  const [focused, setFocused] = useState(false);
  useShortcutBlock(focused);
  const focusedRef = useRef(false);
  focusedRef.current = focused;
  useEffect(() => {
    // An outside change (restore, clear after send, edit a queued message): show it in the input.
    if (!ownInput || !reporter.external(draft)) return;
    draftBuffer.set(draft);
    // Clearing after a send keeps the keyboard up; other text remounts the input with it.
    if (!draft && inputRef.current?.clear) {
      inputRef.current.clear();
      setInputSeed("");
      return;
    }
    refocus.current = focusedRef.current || focusNext.current;
    focusNext.current = false;
    setInputSeed(draft);
    setInputKey((k) => k + 1);
  }, [draft]);
  const [inputHeight, setInputHeight] = useState(inputMin);
  // Images attached to the next message (web: paste, drop or the attach button).
  const [attachments, setAttachmentsState] = useState<Attachment[]>([]);
  const attachmentsRef = useRef<Attachment[]>([]);
  const setAttachments = (next: Attachment[]) => {
    attachmentsRef.current = next;
    setAttachmentsState(next);
  };
  const addImageFiles = async (files: Parameters<typeof readImages>[0]) => {
    if (!files.length) return;
    try {
      const { images, problems } = await readImages(files, maxImages - attachmentsRef.current.length);
      if (!isMounted()) return;
      if (images.length) setAttachments([...attachmentsRef.current, ...images].slice(0, maxImages));
      if (problems.length) toast.error(problems.join(" "));
    } catch (e) {
      toast.error(message(e));
    }
  };
  const addImages = useRef(addImageFiles);
  addImages.current = addImageFiles;
  const [composerNode, setComposerNode] = useState<View | null>(null);
  useEffect(() => listenForImages(composerNode, (files) => void addImages.current(files)), [composerNode]);
  return {
    sessionId,
    draft,
    ownInput,
    draftBuffer,
    inputKey,
    inputSeed,
    inputRef,
    refocus,
    focused,
    setFocused,
    inputHeight,
    setInputHeight,
    attachments,
    attachmentsRef,
    setAttachments,
    addImages,
    setComposerNode,
    reportDraft,
    /** Hands the latest typed text to the parent now (before a send clears it). */
    flush,
    /** What the box holds now (it may be ahead of the parent's copy on phones). */
    read: () => draftBuffer.read(),
    /** The sent text left the box; text typed while the send is in flight stays. */
    clear: (sent: string) => draftBuffer.clear(sent),
    /** Focus the box once the parent's next outside change lands (a picked next move). */
    focusAfterChange() {
      if (ownInput) focusNext.current = true;
      else setTimeout(() => inputRef.current?.focus?.(), 0);
    },
  };
}

export type ComposerDraft = ReturnType<typeof useComposerDraft>;

export function ComposerBox({
  composer: c,
  canWrite,
  busy,
  running,
  preferred,
  compact,
  editable,
  placeholder,
  keyboard,
  onFocus,
  onSubmit,
  onStop,
}: {
  composer: ComposerDraft;
  canWrite: boolean;
  busy: boolean;
  running: boolean;
  /** What a send does while a turn runs (the send button's icon and hint). */
  preferred: SendBehavior;
  compact: boolean;
  editable: boolean;
  placeholder: string;
  keyboard: { onInputFocus(): void; onInputBlur(): void };
  onFocus?(): void;
  /** Enter, the send key or the send button; `alternate` is the modified Enter (SESSION-PANE-SPEC). */
  onSubmit(alternate: boolean): void;
  /** Shown as Stop in place of Send while a turn runs and the box is empty; absent: no Stop. */
  onStop?(): void;
}) {
  const { colors } = useTheme();
  const { draft, focused, attachments } = c;
  const canSend = canWrite && (!!draft.trim() || attachments.length > 0);
  // Paseo parity: a running session with an empty composer shows Stop.
  const stopMode = !!onStop && running && !draft.trim() && !attachments.length && canWrite && !busy;
  const sendSize = touch ? 34 : 28;
  const inputMax = compact ? 108 : 160;
  const fitInput = (contentHeight: number) => {
    const next = Math.max(inputMin, Math.min(inputMax, Math.ceil(contentHeight)));
    c.setInputHeight((current) => (current === next ? current : next));
  };
  return (
    <View
      ref={c.setComposerNode}
      // Text spans the full width; actions sit on their own row below (attach left, send right).
      style={{
        gap: space[1],
        paddingHorizontal: space[1.5],
        paddingTop: space[2],
        paddingBottom: space[1.5],
        borderWidth: 1,
        borderColor: focused ? colors.foregroundMuted : colors.border,
        borderRadius: 18,
        backgroundColor: canWrite ? colors.surface0 : colors.surface1,
      }}
    >
      {attachments.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1.5], paddingHorizontal: space[1.5], paddingTop: 2 }}>
          {attachments.map((a) => (
            <AttachmentThumb key={a.id} attachment={a} onRemove={() => c.setAttachments(c.attachmentsRef.current.filter((x) => x.id !== a.id))} />
          ))}
        </View>
      )}
      <View style={{ minWidth: 0, paddingHorizontal: space[1.5] }}>
        {Platform.OS === "web" && (
          // Invisible copy of the draft at the input's width and font: its height is the input's height.
          // Absolute children are placed against the padding box, so it needs the same horizontal inset as the input; without it the copy was 12 px wider, fitted a last character the textarea wraps, and the input came out one line short.
          <View pointerEvents="none" style={{ position: "absolute", left: space[1.5], right: space[1.5], top: 0, opacity: 0 }}>
            <NativeText
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              onLayout={(e) => fitInput(e.nativeEvent.layout.height)}
              style={{ paddingVertical: inputPad, fontSize: font.base, lineHeight: 20 }}
            >
              {draft ? (draft.endsWith("\n") ? `${draft} ` : draft) : " "}
            </NativeText>
          </View>
        )}
        <TextInput
          key={c.ownInput ? `input-${c.inputKey}` : "input"}
          ref={c.inputRef as never}
          accessibilityLabel={t("Follow-up instruction")}
          accessibilityHint={
            Platform.OS === "web"
              ? t("Enter sends; Shift and Enter inserts a new line.")
              : t("Use the keyboard Send action or the send button.")
          }
          {...(c.ownInput ? { defaultValue: c.inputSeed } : { value: draft })}
          onChangeText={(text) => {
            c.draftBuffer.edit(text);
            c.reportDraft(text);
          }}
          onFocus={() => {
            onFocus?.();
            c.setFocused(true);
            keyboard.onInputFocus();
          }}
          onBlur={() => {
            c.setFocused(false);
            keyboard.onInputBlur();
          }}
          multiline
          autoFocus={c.refocus.current}
          blurOnSubmit={false}
          submitBehavior={Platform.OS === "web" ? "newline" : "submit"}
          returnKeyType="send"
          onKeyPress={(event) => {
            if (Platform.OS !== "web") return;
            const action = composerEnterAction(event.nativeEvent as ComposerKey);
            if (action === "native") return;
            event.preventDefault();
            if (action === "submit" || action === "alternate") onSubmit(action === "alternate");
          }}
          onSubmitEditing={(event) => {
            if (Platform.OS === "web") return;
            const action = composerEnterAction({ ...event.nativeEvent, key: "Enter" });
            if (action === "submit") onSubmit(false);
          }}
          scrollEnabled
          editable={editable}
          placeholder={placeholder}
          placeholderTextColor={colors.foregroundMuted}
          style={{
            // Native multiline inputs size themselves within min/max on the
            // UI thread; a JS height round trip re-rendered the session on
            // every wrapped line and lagged a frame (PERFORMANCE-SPEC §3).
            // Web: the mirror above measures (a textarea never shrinks).
            ...(Platform.OS === "web" ? { height: c.inputHeight } : {}),
            minHeight: inputMin,
            maxHeight: inputMax,
            minWidth: 0,
            paddingVertical: inputPad,
            fontSize: font.base,
            lineHeight: 20,
            color: colors.foreground,
            textAlignVertical: "top",
            outlineStyle: "none",
          } as never}
        />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        {imageInputSupported ? (
          <IconButton
            icon="ImagePlus"
            size={sendSize}
            label={t("Attach images")}
            disabled={!canWrite || attachments.length >= maxImages}
            onPress={() => void pickImageFiles().then((files) => c.addImages.current(files))}
          />
        ) : (
          <View />
        )}
        {stopMode ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Stop session")}
            onPress={onStop}
            hitSlop={6}
            style={(state) => {
              const { pressed } = state;
              return {
                ...noFocusRing,
                width: sendSize,
                height: sendSize,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: sendSize / 2,
                backgroundColor: colors.foreground,
                transform: [{ scale: pressed ? 0.92 : 1 }],
              };
            }}
          >
            <Icon name="Square" size={touch ? 14 : 12} color={colors.surface0} />
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={busy ? t("Sending instruction") : t("Send instruction")}
            accessibilityHint={running ? t(sendBehaviorText[preferred].detail) : undefined}
            accessibilityState={{ disabled: !canSend, busy }}
            disabled={!canSend}
            onPress={() => onSubmit(false)}
            hitSlop={6}
            style={(state) => {
              const { pressed, hovered } = state as typeof state & { hovered?: boolean; focused?: boolean };
              return {
                ...noFocusRing,
                width: sendSize,
                height: sendSize,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: sendSize / 2,
                backgroundColor: canSend || busy ? colors.accent : tint(colors.foregroundMuted, 0.14),
                opacity: canSend && hovered && !pressed ? 0.9 : 1,
                transform: [{ scale: canSend && pressed ? 0.92 : 1 }],
              };
            }}
          >
            {busy ? (
              <ActivityIndicator size="small" color={colors.accentForeground} />
            ) : (
              <Icon
                name={running ? (preferred === "queue" ? "ListPlus" : preferred === "interrupt" ? "CornerDownLeft" : "ArrowUp") : "ArrowUp"}
                size={touch ? 18 : 16}
                color={canSend ? colors.accentForeground : colors.foregroundMuted}
              />
            )}
          </Pressable>
        )}
      </View>
    </View>
  );
}
