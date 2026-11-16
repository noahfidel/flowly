/** Stub: the card description clamp is not implemented yet. */
export const DESCRIPTION_CLAMP_HEIGHT = 0;

export function clampOverflows(_natural: number, _clampHeight: number): boolean {
  return false;
}

export function descriptionOpen(_taskId: string): boolean {
  return false;
}

export function setDescriptionOpen(_taskId: string, _open: boolean): void {}

export function resetDescriptionOpen(): void {}
