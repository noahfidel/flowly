import { useRef, useState } from "react";
import type { NativeScrollEvent } from "react-native";

/** How close to the newest output still counts as following it. */
export const FOLLOW_SLACK = 64;

type ScrollMetrics = Pick<NativeScrollEvent, "contentOffset" | "contentSize" | "layoutMeasurement">;

/**
 * Preserve reading position when content grows, but yield to upward user scrolling.
 *
 * `inverted`: the phone transcript is an inverted list (SESSION-PANE-SPEC §3),
 * whose offset counts from the newest output, so the list itself stays at the
 * end as output arrives and when its viewport shrinks (keyboard, composer).
 * Following is then only "the offset is near 0".
 */
export function createTailFollower(inverted = false) {
  let following = true;
  let dragging = false;
  let previous = { y: 0, height: 0, viewport: 0 };
  return {
    get following() {
      return following;
    },
    resume() {
      following = true;
    },
    /** A jump away from the end (the bell's jump to a row): stop following until the reader is back at the end. */
    pause() {
      following = false;
    },
    beginDrag() {
      dragging = true;
    },
    endDrag() {
      dragging = false;
    },
    get dragging() {
      return dragging;
    },
    scroll(event: ScrollMetrics) {
      const next = {
        y: event.contentOffset.y,
        height: event.contentSize.height,
        viewport: event.layoutMeasurement.height,
      };
      if (inverted) {
        following = next.y <= FOLLOW_SLACK;
        previous = next;
        return following;
      }
      const nearEnd = next.height - next.viewport - next.y <= FOLLOW_SLACK;
      const movedUp =
        next.y < previous.y - 1 &&
        next.height >= previous.height &&
        next.viewport === previous.viewport;
      if (nearEnd) following = true;
      else if (dragging || movedUp) following = false;
      previous = next;
      return following;
    },
  };
}

/** A FlatList (scrollToOffset) or a ScrollView (scrollTo). */
type Scrollable = {
  scrollToEnd(options?: { animated?: boolean }): void;
  scrollToOffset?(options: { offset: number; animated?: boolean }): void;
  scrollTo?(options: { y: number; animated?: boolean }): void;
};

export function useSessionFollowTail(inverted = false) {
  const scrollRef = useRef<Scrollable | null>(null);
  const follower = useRef<ReturnType<typeof createTailFollower> | null>(null);
  if (!follower.current) follower.current = createTailFollower(inverted);
  const [following, setFollowing] = useState(true);
  const offset = useRef(0);
  const scrollToY = (y: number, animated: boolean) => {
    const target = scrollRef.current;
    if (target?.scrollToOffset) target.scrollToOffset({ offset: y, animated });
    else target?.scrollTo?.({ y, animated });
  };
  const toTail = (animated: boolean) => {
    if (inverted) scrollToY(0, animated);
    else scrollRef.current?.scrollToEnd({ animated });
  };
  const track = (event?: { nativeEvent?: NativeScrollEvent }) => {
    if (!event?.nativeEvent?.contentSize) return;
    offset.current = event.nativeEvent.contentOffset.y;
    setFollowing(follower.current!.scroll(event.nativeEvent));
  };
  return {
    scrollRef,
    following,
    /** The last known scroll offset (for keeping the reading position when older output is added above). */
    offset,
    /** Scroll to an offset without animation (keeping the reading position). */
    scrollToY(y: number) {
      scrollToY(y, false);
    },
    /** Normal list: content grew or the viewport changed. An inverted list stays at its end by itself. */
    scrollToTail() {
      if (!inverted && follower.current!.following && !follower.current!.dragging) toTail(false);
    },
    /** Stop following the newest output (a jump to an earlier row); the Latest button shows. */
    stopFollowing() {
      follower.current!.pause();
      setFollowing(false);
    },
    jumpToLatest() {
      follower.current!.resume();
      setFollowing(true);
      toTail(false);
    },
    onScroll: track,
    onScrollBeginDrag() {
      follower.current!.beginDrag();
    },
    // The last throttled onScroll can come before the list stops, so re-check where it came to rest:
    // otherwise a fling to the end could leave "Jump to latest" showing (phones).
    onScrollEndDrag(event?: { nativeEvent?: NativeScrollEvent }) {
      follower.current!.endDrag();
      track(event);
    },
    onMomentumScrollEnd: track,
  };
}

/**
 * The bell's jump to a row (DISPATCHER-SPEC §9.3): owed once per request (`seq`) until the row could be reached,
 * so streamed output and new rows afterwards never scroll back to it.
 */
export function createFocusJump() {
  let handled: number | undefined;
  return {
    pending(seq: number | undefined) {
      return seq !== undefined && seq !== handled;
    },
    done(seq: number) {
      handled = seq;
    },
  };
}

/** Throttle bursts with a guaranteed trailing refresh, cancelled with the subscription. */
export function coalescedRefresh(refresh: () => void, delay = 250) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  return {
    trigger() {
      if (disposed || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed) refresh();
      }, delay);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
