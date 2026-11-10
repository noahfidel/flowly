import { describe, expect, test, vi } from "vitest";
import { statuses, type Status, type Task } from "../shared/model";
import { boardCardMenu, type CardMenuInput } from "./card-menu";
import type { MenuEntry } from "./context-menu";

const card = (over: Partial<Task> = {}): Task =>
  ({ id: "c1", projectId: "p", workspaceId: "ws", title: "c1", status: "development", revision: 3, archivedAt: null, ...over }) as Task;

const menu = (over: Partial<CardMenuInput> = {}, actions: Partial<CardMenuInput["actions"]> = {}) =>
  boardCardMenu({
    card: card(),
    statuses: [...statuses],
    laneName: (s: Status) => s,
    ownArchived: false,
    pending: false,
    compact: false,
    allView: false,
    ...over,
    actions: { open: vi.fn(), start: vi.fn(), move: vi.fn(), reorder: vi.fn(), archive: vi.fn(), remove: vi.fn(), ...actions },
  });

const ids = (entries: MenuEntry[]) => entries.map((e) => e.id);
const find = (entries: MenuEntry[], id: string) => entries.find((e) => e.id === id)!;
const asItem = (e: MenuEntry) => e as Extract<MenuEntry, { onPress(): void }>;
const asSub = (e: MenuEntry) => e as Extract<MenuEntry, { kind: "submenu" }>;

describe("board card menu", () => {
  test("desktop rows are exactly open, start, move, archive, delete, in that order", () => {
    const entries = menu();
    expect(ids(entries)).toEqual(["open", "start", "move", "s1", "archive", "delete"]);
    expect(entries.filter((e) => e.kind !== "separator").map((e) => e.id)).toEqual(["open", "start", "move", "archive", "delete"]);
  });

  test("Delete is last and danger", () => {
    const last = asItem(menu().at(-1)!);
    expect(last.id).toBe("delete");
    expect(last.danger).toBe(true);
  });

  test("a phone sheet adds Move up and Move down right after Move to", () => {
    expect(ids(menu({ compact: true }))).toEqual(["open", "start", "move", "up", "down", "s1", "archive", "delete"]);
  });

  test("the All board never has Move up or Move down", () => {
    expect(ids(menu({ compact: true, allView: true }))).not.toContain("up");
    expect(ids(menu({ compact: false, allView: true }))).not.toContain("down");
  });

  test("Move up and Move down are disabled while pending or on an archived-owned card, and absent on the All board", () => {
    for (const over of [{ pending: true }, { ownArchived: true }]) {
      const entries = menu({ compact: true, ...over });
      expect(asItem(find(entries, "up")).disabled).toBe(true);
      expect(asItem(find(entries, "down")).disabled).toBe(true);
    }
    expect(asItem(find(menu({ compact: true }), "up")).disabled).toBeFalsy();
    expect(ids(menu({ compact: true, allView: true, pending: true }))).not.toContain("up");
  });

  test("Move to holds one entry per lane with the current one checked", () => {
    const lanes: Status[] = ["todo", "development", "done"];
    const sub = asSub(find(menu({ statuses: lanes }), "move"));
    expect(sub.entries.map((e) => e.id)).toEqual(["status-todo", "status-development", "status-done"]);
    expect(sub.entries.map((e) => (e as { checked?: boolean }).checked)).toEqual([false, true, false]);
  });

  test("choosing a lane moves the card; choosing the current lane does nothing", () => {
    const move = vi.fn();
    const sub = asSub(find(menu({}, { move }), "move"));
    asItem(find(sub.entries, "status-development")).onPress();
    expect(move).not.toHaveBeenCalled();
    asItem(find(sub.entries, "status-done")).onPress();
    expect(move).toHaveBeenCalledWith("done");
  });

  test("the compact reorder rows call reorder with their direction", () => {
    const reorder = vi.fn();
    const entries = menu({ compact: true }, { reorder });
    asItem(find(entries, "up")).onPress();
    asItem(find(entries, "down")).onPress();
    expect(reorder.mock.calls).toEqual([["up"], ["down"]]);
  });

  const disabledOf = (entries: MenuEntry[]) =>
    Object.fromEntries(
      entries.flatMap((e) =>
        e.kind === "separator" || e.kind === "label" ? [] : [[e.id, !!e.disabled] as const],
      ),
    );
  const laneDisabled = (entries: MenuEntry[]) => asSub(find(entries, "move")).entries.map((e) => !!(e as { disabled?: boolean }).disabled);

  test("nothing is disabled on a live card", () => {
    const entries = menu({ compact: true });
    expect(Object.values(disabledOf(entries)).some(Boolean)).toBe(false);
    expect(laneDisabled(entries).some(Boolean)).toBe(false);
  });

  test("a pending write disables everything but Open details", () => {
    const entries = menu({ pending: true, compact: true });
    expect(disabledOf(entries)).toEqual({ open: false, start: true, move: false, up: true, down: true, archive: true, delete: true });
    expect(laneDisabled(entries).every(Boolean)).toBe(true);
  });

  test("an archived project disables everything but Open details", () => {
    const entries = menu({ ownArchived: true, compact: true });
    expect(disabledOf(entries)).toMatchObject({ open: false, start: true, up: true, down: true, archive: true, delete: true });
    expect(laneDisabled(entries).every(Boolean)).toBe(true);
  });

  test("an archived card locks Start and the lanes but can be restored or deleted", () => {
    const entries = menu({ card: card({ archivedAt: "2026-11-01T00:00:00.000Z" }), compact: true });
    expect(disabledOf(entries)).toMatchObject({ start: true, up: true, down: true, archive: false, delete: false });
    expect(laneDisabled(entries).every(Boolean)).toBe(true);
  });

  test("Archive becomes Restore, and is danger only when archiving", () => {
    const live = asItem(find(menu(), "archive"));
    const archived = asItem(find(menu({ card: card({ archivedAt: "2026-11-01T00:00:00.000Z" }) }), "archive"));
    expect(live.label).toBe("Archive card");
    expect(live.danger).toBe(true);
    expect(archived.label).toBe("Restore card");
    expect(archived.danger).toBe(false);
  });
});
