/**
 * Board card double click (UI-UX-SPEC "card double click"): true only for the second click of a mouse double
 * click. `detail` is the browser's click count (0 for the keyboard and on native, where it is absent); the
 * pointer is the event's own `pointerType` when it has one, else the last pointer seen on the card.
 */
export function isMouseDoubleClick(event: { detail?: unknown; pointerType?: unknown } | null | undefined, lastPointer: string | null): boolean {
  if (!event || event.detail !== 2) return false;
  const pointer = typeof event.pointerType === "string" && event.pointerType ? event.pointerType : lastPointer;
  return pointer === "mouse";
}
