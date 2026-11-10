/**
 * Finds a value one of Paseo's React context providers holds, by walking up the React fiber of a native view the
 * plugin renders (a `View` ref). The SDK does not expose these contexts; this relies on Paseo internals (AGENTS.md
 * exceptions): `match` feature-detects the value, nothing throws, and another tree shape returns null.
 */
type Fiber = { return?: Fiber | null; memoizedProps?: { value?: unknown } | null };

const maxDepth = 4000;

/** The nearest provider value above `node` that `match` accepts, or null. */
export function findHostValue<T>(node: unknown, match: (value: unknown) => T | null): T | null {
  try {
    let fiber = (node as { __internalInstanceHandle?: Fiber } | null)?.__internalInstanceHandle ?? null;
    for (let depth = 0; fiber && depth < maxDepth; depth++) {
      const found = match(fiber.memoizedProps?.value);
      if (found) return found;
      fiber = fiber.return ?? null;
    }
  } catch {
    // Another tree shape: the host keeps its behaviour as it is.
  }
  return null;
}
