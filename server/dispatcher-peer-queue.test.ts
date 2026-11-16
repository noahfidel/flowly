import { afterEach, expect, test } from "vitest";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePeerMessage, peerMessagePrefix, queuedPeerMessageLimits } from "../shared/dispatcher";
import { DispatcherPeerQueueFile, queuedPeerDelivery } from "./dispatcher-peer-queue";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

test("the peer prefix names the sender group, cleaned, and the client reads it back (DISPATCHER-SPEC §5.5)", () => {
  expect(peerMessagePrefix({ id: "g1", name: "Clients" })).toBe(
    'From the Flowly dispatcher of group "Clients" [g1] (an automated assistant, not the user; answer with flowly_message_dispatcher only if it needs an answer, your final text does not reach it): ',
  );
  // Whitespace collapsed, double quotes removed, cut to 80 characters.
  expect(peerMessagePrefix({ id: "g1", name: '  Client\n "big"   work ' })).toContain('group "Client big work" [g1]');
  const long = peerMessagePrefix({ id: "g1", name: "x".repeat(200) });
  expect(long).toContain(`group "${"x".repeat(80)}" [g1]`);
  expect(parsePeerMessage(`${peerMessagePrefix({ id: "g-7", name: 'A "b" c' })}Hello\nthere`)).toEqual({ groupId: "g-7", name: "A b c", text: "Hello\nthere" });
  expect(parsePeerMessage("Hello")).toBeNull();
  expect(parsePeerMessage('From the Flowly dispatcher of group "Clients" [g1]: hi')).toBeNull();
  expect(queuedPeerMessageLimits).toEqual({ perGroup: 10, total: 200 });
});

test("one sender group's queued messages go out as one, under its prefix, each with its time (DISPATCHER-SPEC §5.5)", () => {
  const group = { id: "g1", name: "Clients" };
  const one = queuedPeerDelivery(group, [{ text: "Start the API card.", at: "2026-11-16T09:05:00.000Z" }]);
  expect(one.startsWith(peerMessagePrefix(group))).toBe(true);
  expect(one).toMatch(/held/);
  expect(one).toContain("(2026-11-16 09:05 UTC) Start the API card.");
  expect(one).not.toContain("1. ");
  const two = queuedPeerDelivery(group, [
    { text: "first", at: "2026-11-16T09:05:00.000Z" },
    { text: "second", at: "2026-11-16T09:06:00.000Z" },
  ]);
  expect(two.split("From the Flowly dispatcher")).toHaveLength(2);
  expect(two).toContain("1. (2026-11-16 09:05 UTC) first");
  expect(two).toContain("2. (2026-11-16 09:06 UTC) second");
  expect(parsePeerMessage(two)?.groupId).toBe("g1");
});

const message = { id: "m1", groupId: "g2", fromGroupId: "g1", fromGroupName: "Clients", from: "d1", text: "hi", at: "2026-11-16T09:05:00.000Z" };

test("a corrupt peer queue file is kept aside and the queue starts empty (DISPATCHER-SPEC §5.5)", async () => {
  const folder = await mkdtemp(join(tmpdir(), "flowly-peer-queue-"));
  folders.push(folder);
  await writeFile(join(folder, "dispatcher-peer-queue.json"), "{ not json");
  const file = new DispatcherPeerQueueFile(folder);
  expect(await file.list()).toEqual([]);
  expect((await readdir(folder)).some((name) => name.startsWith("dispatcher-peer-queue.json.invalid-"))).toBe(true);
  await file.update((messages) => ({ messages: [...messages, message], value: undefined }));
  expect(await new DispatcherPeerQueueFile(folder).list()).toEqual([message]);
  expect(JSON.parse(await readFile(join(folder, "dispatcher-peer-queue.json"), "utf8"))).toEqual({ version: 1, messages: [message] });
  // The card queue's file is a different one, untouched.
  expect((await readdir(folder)).some((name) => name.startsWith("dispatcher-queue.json"))).toBe(false);
  await expect(file.update((messages) => ({ messages: [...messages, { ...message, text: "" }], value: undefined }))).rejects.toThrow();
  expect(await new DispatcherPeerQueueFile(folder).list()).toEqual([message]);
});

test("a corrupt peer queue file that can't be kept aside refuses reads and writes, never overwritten (DISPATCHER-SPEC §5.5)", async () => {
  const folder = await mkdtemp(join(tmpdir(), "flowly-peer-queue-"));
  folders.push(folder);
  const path = join(folder, "dispatcher-peer-queue.json");
  await writeFile(path, "{ not json");
  await chmod(folder, 0o500);
  try {
    const file = new DispatcherPeerQueueFile(folder);
    await expect(file.list()).rejects.toThrow();
    await expect(file.update((messages) => ({ messages, value: undefined }))).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{ not json");
  } finally {
    await chmod(folder, 0o700);
  }
});
