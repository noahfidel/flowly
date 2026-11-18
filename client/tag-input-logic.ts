/**
 * The tag input closes itself a short while after it loses focus with nothing typed (a suggestion tap lands first).
 * Once the editor is closed or gone, a late blur must not arm that timer: the blur `TextBox` sends when Esc or Enter
 * removed the focused input (SHORTCUTS-SPEC §2.2) would otherwise close the next "Add tag" within the delay, or outlive
 * the editor.
 */
export function createBlurCloser(close: () => void, delayMs = 200, open = false) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let live = open;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    /** "Add tag" opened the input. */
    opened() {
      cancel();
      live = true;
    },
    /** Focus came back, or a suggestion was tapped: keep the input. */
    cancel,
    blurred(draftEmpty: () => boolean) {
      cancel();
      if (!live) return;
      timer = setTimeout(() => {
        timer = null;
        if (draftEmpty()) close();
      }, delayMs);
    },
    /** The input closed, or the editor unmounted. */
    closed() {
      cancel();
      live = false;
    },
  };
}
