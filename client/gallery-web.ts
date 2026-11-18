/*
 * Web keys for the Gallery viewer (EVIDENCE-GALLERY-SPEC §2.2), ported from paseo-image-gallery
 * (github.com/mordol/paseo-image-gallery, client/web.ts). Feature-detected; a no-op on phones.
 *
 * Portions copyright (c) 2026 Taegyu Ryu. MIT License:
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
 * to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions
 * of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
 * TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */
import { Platform } from "react-native";

// Flowly typechecks without the DOM library. Only what this module uses, found on globalThis.
type KeyEvent = { key: string; preventDefault(): void };
type KeyTarget = {
  addEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
  removeEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
};

/**
 * Calls `handler` for each key press on web and desktop. Return true to consume the key.
 * Native platforms have no hardware keyboard events here, so this is a no-op there.
 */
export function onKeyDown(handler: (key: string) => boolean): () => void {
  const target = globalThis as Partial<KeyTarget>;
  if (Platform.OS !== "web" || typeof target.addEventListener !== "function" || typeof target.removeEventListener !== "function") return () => {};
  const listener = (event: KeyEvent) => {
    if (handler(event.key)) event.preventDefault();
  };
  target.addEventListener("keydown", listener);
  return () => target.removeEventListener?.("keydown", listener);
}

/**
 * True in the macOS desktop app, where the window buttons overlay the top-left corner of a
 * full-window modal. Browsers and native platforms keep their own window chrome.
 */
export function hasWindowButtons(): boolean {
  if (Platform.OS !== "web") return false;
  const agent = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent || "";
  return agent.includes("Electron") && agent.includes("Macintosh");
}
