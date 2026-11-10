/**
 * Paseo's horizontal-scroll registry (`HorizontalScrollContext`), found through the React fiber of a view the
 * plugin renders. The host's phone gesture that opens the agent list on a rightward swipe fails while any
 * registered offset is above 1, as it does over its own sideways scrollers (UI-UX-SPEC §5, lane swipe).
 *
 * This relies on Paseo internals, not a plugin API (AGENTS.md exception, user-approved 2026-10-31): everything is
 * feature-detected, nothing throws, and a host with another tree shape returns null and keeps its gestures.
 */
import { findHostValue } from "./host-fiber";

export interface HostHorizontalScroll {
  registerScrollOffset(id: string, offset: number): void;
  unregisterScrollOffset(id: string): void;
}

function asHorizontalScroll(value: unknown): HostHorizontalScroll | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<HostHorizontalScroll> & { isAnyScrolledRight?: unknown };
  if (typeof candidate.registerScrollOffset !== "function" || typeof candidate.unregisterScrollOffset !== "function") return null;
  // A Reanimated shared value: tells the registry apart from other providers with similar method names.
  if (!candidate.isAnyScrolledRight || typeof candidate.isAnyScrolledRight !== "object") return null;
  return candidate as HostHorizontalScroll;
}

/** The nearest registry above a mounted native view (a `View` ref), or null. */
export function findHostHorizontalScroll(node: unknown): HostHorizontalScroll | null {
  return findHostValue(node, asHorizontalScroll);
}
