/**
 * Android Back steps back through Flowly (session → card → board, page → board) before the host closes the screen
 * (UI-UX-SPEC §5, Android Back). Paseo keeps the Flowly screen mounted under the agent and workspace screens it
 * pushes, so Back is only taken while Flowly's own screen is focused: react-navigation's screen navigation object
 * is found through the React fiber of a view the plugin renders.
 *
 * This relies on Paseo internals, not a plugin API (AGENTS.md exception, user-requested 2026-11-01): everything is
 * feature-detected, nothing throws, and when the navigation object is not found Back keeps the host's behaviour.
 */
import { useEffect, useRef, type RefObject } from "react";
import { BackHandler, Platform, type View } from "react-native";
import { findHostValue } from "./host-fiber";

export interface HostScreen {
  isFocused(): boolean;
}

function asScreenNavigation(value: unknown): HostScreen | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  // A screen's navigation object; the nearest one above the board belongs to the screen Flowly renders in.
  for (const key of ["isFocused", "addListener", "dispatch", "getState"]) if (typeof candidate[key] !== "function") return null;
  return candidate as unknown as HostScreen;
}

/** The navigation object of the nearest screen above a mounted native view (a `View` ref), or null. */
export function findHostScreen(node: unknown): HostScreen | null {
  return findHostValue(node, asScreenNavigation);
}

/** Back press handler: runs `onBack` only while the screen holding the view is focused, else leaves Back to the host. */
export function screenBackHandler(view: () => unknown, onBack: () => boolean) {
  let screen: HostScreen | null = null;
  return () => {
    screen ??= findHostScreen(view());
    try {
      if (!screen?.isFocused()) return false;
    } catch {
      return false;
    }
    return onBack();
  };
}

/** Calls `onBack` on Android Back while the screen holding `frame` is focused; `onBack` returns whether it handled it. */
export function useAndroidBack(frame: RefObject<View | null>, onBack: () => boolean) {
  const latest = useRef(onBack);
  latest.current = onBack;
  useEffect(() => {
    // react-native-web's BackHandler logs an error, and iOS has no Back button.
    if (Platform.OS !== "android") return;
    const handler = screenBackHandler(() => frame.current, () => latest.current());
    const subscription = BackHandler.addEventListener("hardwareBackPress", handler);
    return () => subscription.remove();
  }, [frame]);
}
