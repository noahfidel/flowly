import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { randomFillSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifact } from "../shared/model";
import { galleryImageFile, galleryImages, readGalleryImage, slots } from "./artifact-gallery";
import type { ArtifactRoots } from "./artifacts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flowly-gallery-")));
  dirs.push(root);
  const ws = join(root, "ws");
  await mkdir(join(ws, "shots"), { recursive: true });
  await mkdir(join(root, "outside"));
  const where: ArtifactRoots = { workspace: ws, roots: [ws] };
  return { root, ws, where };
}

let n = 0;
function artifact(target: string, extra: Partial<Artifact> = {}): Artifact {
  n++;
  return {
    id: `a${n}`,
    taskId: "t",
    projectId: "p",
    role: "output",
    kind: "file",
    target,
    title: target,
    note: "",
    createdBy: "agent",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - n)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    ...extra,
  };
}

test("only output file artifacts count: inputs, links, the plan, ledgers and external items never do", async () => {
  const x = await setup();
  for (const name of ["a.png", "b.png", "c.png", "d.png", "e.png", "f.png"]) await writeFile(join(x.ws, name), PNG);
  const list = [
    artifact("./a.png"),
    artifact("./b.png", { role: "input" }),
    artifact("https://example.com/c.png", { kind: "url" }),
    artifact("./d.png", { plan: { approvedAt: null, source: "tool", setAt: new Date().toISOString() } }),
    artifact("./e.png", { origin: "review-ledger" }),
    artifact("./f.png", { external: { connectionId: "c", provider: "linear", key: "X-1" } as Artifact["external"] }),
  ];
  const images = await galleryImages(list, x.where);
  expect(images.map((i) => [i.artifactId, i.name])).toEqual([[list[0].id, "a.png"]]);
  expect(images[0].size).toBe(PNG.length);
  expect(typeof images[0].mtime).toBe("number");
  // Non-image outputs are not images.
  await writeFile(join(x.ws, "notes.md"), "x");
  expect(await galleryImages([artifact("./notes.md")], x.where)).toEqual([]);
});

test("folders: top level only, images only, numeric-aware order, capped at 200", async () => {
  const x = await setup();
  for (const name of ["10-after.png", "9-before.png", "1-x.JPG", "notes.txt"]) await writeFile(join(x.ws, "shots", name), PNG);
  await mkdir(join(x.ws, "shots", "annotated"));
  await writeFile(join(x.ws, "shots", "annotated", "deep.png"), PNG);
  // A folder named like an image is not an image.
  await mkdir(join(x.ws, "shots", "x.png"));
  const folder = artifact("./shots");
  const images = await galleryImages([folder], x.where);
  expect(images.map((i) => i.name)).toEqual(["1-x.JPG", "9-before.png", "10-after.png"]);

  const many = join(x.ws, "many");
  await mkdir(many);
  for (let i = 0; i < 205; i++) await writeFile(join(many, `${i}.png`), PNG);
  const capped = await galleryImages([artifact("./many")], x.where);
  expect(capped).toHaveLength(200);
  expect(capped[0].name).toBe("0.png");
  expect(capped.at(-1)!.name).toBe("199.png");
});

test("outputs keep Artifacts-list order (newest first) and the same real path shows once", async () => {
  const x = await setup();
  await writeFile(join(x.ws, "shots", "1-a.png"), PNG);
  await writeFile(join(x.ws, "shots", "2-b.png"), PNG);
  await writeFile(join(x.ws, "solo.png"), PNG);
  await symlink(join(x.ws, "shots", "2-b.png"), join(x.ws, "alias.png"));
  const older = artifact("./shots", { createdAt: "2026-01-01T00:00:00.000Z" });
  const newer = artifact("./solo.png", { createdAt: "2026-01-02T00:00:00.000Z" });
  const alias = artifact("./alias.png", { createdAt: "2026-01-03T00:00:00.000Z" });
  const images = await galleryImages([older, newer, alias], x.where);
  expect(images.map((i) => `${i.artifactId}:${i.name}`)).toEqual([`${alias.id}:alias.png`, `${newer.id}:solo.png`, `${older.id}:1-a.png`]);
});

test("symlinks pointing outside the roots are skipped and refused", async () => {
  const x = await setup();
  await writeFile(join(x.root, "outside", "secret.png"), PNG);
  await symlink(join(x.root, "outside", "secret.png"), join(x.ws, "shots", "leak.png"));
  await symlink(join(x.root, "outside", "secret.png"), join(x.ws, "leak.png"));
  await writeFile(join(x.ws, "shots", "ok.png"), PNG);
  const folder = artifact("./shots");
  const file = artifact("./leak.png");
  expect((await galleryImages([folder, file], x.where)).map((i) => i.name)).toEqual(["ok.png"]);
  await expect(galleryImageFile(folder, "leak.png", x.where)).rejects.toThrow();
  await expect(galleryImageFile(file, undefined, x.where)).rejects.toThrow();
});

test("image names must be plain, listed file names; folders named x.png and images over 8 MB are refused", async () => {
  const x = await setup();
  await writeFile(join(x.ws, "shots", "ok.png"), PNG);
  await writeFile(join(x.ws, "top.png"), PNG);
  await mkdir(join(x.ws, "shots", "x.png"));
  const folder = artifact("./shots");
  expect((await galleryImageFile(folder, "ok.png", x.where)).path).toBe(join(x.ws, "shots", "ok.png"));
  await expect(galleryImageFile(folder, undefined, x.where)).rejects.toThrow();
  await expect(galleryImageFile(folder, "../top.png", x.where)).rejects.toThrow();
  await expect(galleryImageFile(folder, "a/ok.png", x.where)).rejects.toThrow();
  await expect(galleryImageFile(folder, "a\\ok.png", x.where)).rejects.toThrow();
  await expect(galleryImageFile(folder, "..", x.where)).rejects.toThrow();
  await expect(galleryImageFile(folder, "missing.png", x.where)).rejects.toThrow();
  await expect(galleryImageFile(folder, "x.png", x.where)).rejects.toThrow();
  // A folder artifact itself named x.png is a folder, not an image.
  await expect(galleryImageFile(artifact("./shots/x.png"), undefined, x.where)).rejects.toThrow();
  // Inputs never serve.
  await expect(galleryImageFile(artifact("./top.png", { role: "input" }), undefined, x.where)).rejects.toThrow();

  await writeFile(join(x.ws, "big.png"), PNG);
  await truncate(join(x.ws, "big.png"), 8 * 1024 * 1024 + 1);
  const big = artifact("./big.png");
  await expect(galleryImageFile(big, undefined, x.where)).rejects.toThrow("8 MB");
  expect(await galleryImages([big], x.where)).toEqual([]);
});

test("extra artifact folders are honoured", async () => {
  const x = await setup();
  const extra = join(x.root, "plans");
  await mkdir(join(extra, "screenshots"), { recursive: true });
  await writeFile(join(extra, "screenshots", "1-AFTER-a.png"), PNG);
  const folder = artifact(join(extra, "screenshots"));
  expect(await galleryImages([folder], x.where)).toEqual([]);
  const where = { ...x.where, resolved: [extra] };
  expect((await galleryImages([folder], where)).map((i) => i.name)).toEqual(["1-AFTER-a.png"]);
  const file = await galleryImageFile(folder, "1-AFTER-a.png", where);
  const full = await readGalleryImage(file, "full", join(x.root, "cache"));
  expect(full).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
});

test("thumbnails fall back to the original for images that would not shrink; the cache folder is private", async () => {
  const x = await setup();
  await writeFile(join(x.ws, "tiny.png"), PNG);
  const file = await galleryImageFile(artifact("./tiny.png"), undefined, x.where);
  const cache = join(x.root, "cache");
  expect(await readGalleryImage(file, "thumb", cache)).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  if (process.platform === "darwin") expect((await stat(cache)).mode & 0o777).toBe(0o700);
});

/** A noisy RGB PNG (noise keeps it from compressing below its thumbnail). */
function noisyPng(width: number, height: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  randomFillSync(raw);
  for (let row = 0; row < height; row++) raw[row * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test.runIf(process.platform === "darwin")("macOS: a large image gets a smaller sips thumbnail, cached in the private folder", async () => {
  const x = await setup();
  const big = noisyPng(1600, 1200);
  await writeFile(join(x.ws, "wide.png"), big);
  const file = await galleryImageFile(artifact("./wide.png"), undefined, x.where);
  const cache = join(x.root, "cache");
  const thumb = await readGalleryImage(file, "thumb", cache);
  expect(thumb.startsWith("data:image/png;base64,")).toBe(true);
  expect(Buffer.from(thumb.slice("data:image/png;base64,".length), "base64").length).toBeLessThan(big.length);
  expect((await stat(cache)).mode & 0o777).toBe(0o700);
  const cached = await readdir(cache);
  expect(cached).toHaveLength(1);
  expect(cached[0]).toMatch(/-s640-l1600\.png$/);
  // The second read is served from the cache, unchanged.
  expect(await readGalleryImage(file, "thumb", cache)).toBe(thumb);
}, 20_000);

test("a name with a double dot inside is an ordinary file name: listed and served", async () => {
  const x = await setup();
  await writeFile(join(x.ws, "shots", "v1..2.png"), PNG);
  const folder = artifact("./shots");
  expect((await galleryImages([folder], x.where)).map((i) => i.name)).toEqual(["v1..2.png"]);
  expect((await galleryImageFile(folder, "v1..2.png", x.where)).path).toBe(join(x.ws, "shots", "v1..2.png"));
});

test("only names in the capped listing are served: the 201st image of a folder is refused", async () => {
  const x = await setup();
  const many = join(x.ws, "many");
  await mkdir(many);
  for (let i = 0; i < 205; i++) await writeFile(join(many, `${i}.png`), PNG);
  // An entry that is not an image does not use up a place in the listing.
  await mkdir(join(many, "0a.png"));
  const folder = artifact("./many");
  expect((await galleryImageFile(folder, "199.png", x.where)).path).toBe(join(many, "199.png"));
  await expect(galleryImageFile(folder, "200.png", x.where)).rejects.toThrow("not in the folder");
  await expect(galleryImageFile(folder, "204.png", x.where)).rejects.toThrow("not in the folder");
});

test.runIf(process.platform === "darwin")("macOS: a shot rewritten in place replaces its old thumbnail in the cache", async () => {
  const x = await setup();
  const path = join(x.ws, "shot.png");
  await writeFile(path, noisyPng(1600, 1200));
  await writeFile(join(x.ws, "other.png"), noisyPng(1600, 1200));
  const cache = join(x.root, "cache");
  await readGalleryImage(await galleryImageFile(artifact("./shot.png"), undefined, x.where), "thumb", cache);
  await readGalleryImage(await galleryImageFile(artifact("./other.png"), undefined, x.where), "thumb", cache);
  const first = await readdir(cache);
  expect(first).toHaveLength(2);
  // Rewritten in place: new bytes and a later modification time.
  await writeFile(path, noisyPng(1600, 1000));
  await utimes(path, new Date(), new Date(Date.now() + 5000));
  await readGalleryImage(await galleryImageFile(artifact("./shot.png"), undefined, x.where), "thumb", cache);
  const after = await readdir(cache);
  expect(after).toHaveLength(2);
  expect(after.filter((name) => !first.includes(name))).toHaveLength(1);
}, 30_000);

test("thumbnail work runs at most N at a time, and a failure frees its slot", async () => {
  const run = slots(4);
  let running = 0;
  let most = 0;
  const job = (fail: boolean) =>
    run(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      if (fail) throw new Error("boom");
      return 1;
    });
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => job(i % 3 === 0)));
  expect(most).toBe(4);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(8);
  expect(await job(false)).toBe(1);
});
