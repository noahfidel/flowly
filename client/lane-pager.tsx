import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useWindowDimensions, View, type LayoutChangeEvent, type ScrollView as NativeScrollView } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { findHostHorizontalScroll, type HostHorizontalScroll } from "./host-horizontal-scroll";
import { settledPage } from "./lane-rows";

type Scrolled = { nativeEvent: { contentOffset: { x: number } } };

// Neighbouring lanes mount once the board has been idle this long, so opening it costs one lane.
const warmMs = 400;

/**
 * The phone's lanes as pages of a native horizontal pager (iOS/Android; UI-UX-SPEC §5, lane swipe). The native
 * pan takes a horizontal drag and follows the finger; the release settles on a lane, which is reported through
 * `onSettle`. An `index` changed from outside (the status chooser, hidden lanes) jumps there without scrolling.
 *
 * Past the first lane the pager tells Paseo it is scrolled sideways, so a rightward swipe goes back a lane instead
 * of opening the agent list; on the first lane that swipe stays Paseo's. Not while `active` is false (a card covers
 * the board), nor when Paseo's registry cannot be found.
 */
export function LanePager<K extends string>({
  lanes,
  index,
  active,
  onSettle,
  renderLane,
}: {
  lanes: readonly K[];
  index: number;
  active: boolean;
  onSettle(lane: K): void;
  renderLane(lane: K): ReactNode;
}) {
  const window = useWindowDimensions();
  const [measured, setMeasured] = useState(0);
  const width = measured || window.width;
  const pager = useRef<NativeScrollView | null>(null);
  const frame = useRef<View | null>(null);
  // The page the pager rests on and the width it was placed at.
  const resting = useRef({ index, width });
  useLayoutEffect(() => {
    const was = resting.current;
    if (was.index === index && was.width === width) return;
    resting.current = { index, width };
    pager.current?.scrollTo({ x: index * width, y: 0, animated: false });
  }, [index, width]);

  const [warm, setWarm] = useState(false);
  useEffect(() => {
    if (warm) return;
    const timer = setTimeout(() => setWarm(true), warmMs);
    return () => clearTimeout(timer);
  }, [warm]);

  const latest = useRef({ lanes, onSettle, width });
  latest.current = { lanes, onSettle, width };
  const settle = (x: number) => {
    const { lanes: order, onSettle: report, width: at } = latest.current;
    if (!(at > 0)) return;
    const page = settledPage(x, at, order.length);
    resting.current = { index: page, width: at };
    report(order[page]);
  };

  const scrollId = useId();
  const pagedAway = active && index > 0;
  const host = useRef<HostHorizontalScroll | null | undefined>(undefined);
  useEffect(() => {
    if (!pagedAway) return;
    if (host.current === undefined) host.current = findHostHorizontalScroll(frame.current);
    const registry = host.current;
    if (!registry) return;
    const id = `flowly:lanes:${scrollId}`;
    try {
      registry.registerScrollOffset(id, 100);
    } catch {
      return;
    }
    return () => {
      try {
        registry.unregisterScrollOffset(id);
      } catch {
        // The host tree is gone with its registry.
      }
    };
  }, [pagedAway, scrollId]);

  return (
    <View ref={frame} collapsable={false} style={{ flex: 1, minHeight: 0 }}>
      <ScrollView
        ref={pager}
        horizontal
        pagingEnabled
        directionalLockEnabled
        nestedScrollEnabled
        bounces={false}
        overScrollMode="never"
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentOffset={{ x: index * width, y: 0 }}
        onLayout={(event: LayoutChangeEvent) => {
          const next = event.nativeEvent.layout.width;
          setMeasured((was) => (was === next ? was : next));
        }}
        onScrollEndDrag={(event: Scrolled) => {
          // A release exactly on a page has no momentum to end.
          const x = event.nativeEvent.contentOffset.x;
          if (width > 0 && Math.abs(x - Math.round(x / width) * width) < 1) settle(x);
        }}
        onMomentumScrollEnd={(event: Scrolled) => settle(event.nativeEvent.contentOffset.x)}
        style={{ flex: 1 }}
        contentContainerStyle={{ height: "100%" }}
      >
        {lanes.map((lane, at) => (
          <View key={lane} testID={`lane-page-${lane}`} style={{ width, height: "100%" }}>
            {at === index || (warm && Math.abs(at - index) === 1) ? renderLane(lane) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
