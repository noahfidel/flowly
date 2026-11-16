import { afterEach, expect, test } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatcherMessagePrefix } from "../shared/dispatcher";
import { DispatcherQueueFile, queuedDelivery } from "./dispatcher-queue";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

test("one queued message is delivered with the marker, its time and the re-read line (DISPATCHER-SPEC §5.3)", () => {
  const text = queuedDelivery([{ text: "Only the API.", at: "2026-11-16T09:05:00.000Z" }]);
  expect(text.startsWith(dispatcherMessagePrefix)).toBe(true);
  expect(text).toContain("(2026-11-16 09:05 UTC) Only the API.");
  expect(text).toContain("flowly_get_task");
  expect(text).not.toContain("1. ");
});

test("a corrupt queue file is kept aside and the queue starts empty (DISPATCHER-SPEC §5.3)", async () => {
  const folder = await mkdtemp(join(tmpdir(), "flowly-queue-"));
  folders.push(folder);
  await writeFile(join(folder, "dispatcher-queue.json"), "{ not json");
  const file = new DispatcherQueueFile(folder);
  expect(await file.list()).toEqual([]);
  expect((await readdir(folder)).some((name) => name.startsWith("dispatcher-queue.json.invalid-"))).toBe(true);
  const message = { id: "m1", taskId: "t", projectId: "p", agentId: "s", from: "d", text: "hi", at: "2026-11-16T09:05:00.000Z" };
  await file.update((messages) => ({ messages: [...messages, message], value: undefined }));
  expect(await new DispatcherQueueFile(folder).list()).toEqual([message]);
  // An invalid write is refused and changes nothing.
  await expect(file.update((messages) => ({ messages: [...messages, { ...message, text: "" }], value: undefined }))).rejects.toThrow();
  expect(await new DispatcherQueueFile(folder).list()).toEqual([message]);
});
