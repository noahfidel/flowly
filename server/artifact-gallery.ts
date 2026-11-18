/*
 * The card's Gallery (EVIDENCE-GALLERY-SPEC): images from the card's output file artifacts, and their thumbnails.
 *
 * The thumbnailer is ported from paseo-image-gallery (github.com/mordol/paseo-image-gallery), whose image
 * collection step (a scan of session timelines) is replaced here by the card's registered outputs.
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
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { absoluteTarget } from "../shared/artifacts";
import { extensionOf, galleryLimits, galleryMimeTypes, isGalleryArtifact, isGalleryImageName, plainFileName, type GalleryImage } from "../shared/gallery";
import type { Artifact } from "../shared/model";
import { realRoots, withinReal, type ArtifactRoots, type ArtifactService } from "./artifacts";
import { logFailure } from "./error-report";

/** One image file, checked: a regular file inside the card's roots, at most 8 MB. */
export type GalleryFile = { path: string; mimeType: string; size: number; mtime: number };

/** File names in numeric-aware order, so `10-…` follows `9-…`. */
const compareNames = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

/** How many folder entries are checked at once. */
const BATCH = 50;

async function imageInfo(path: string) {
  const info = await stat(path).catch(() => null);
  return info && info.isFile() && info.size <= galleryLimits.maxBytes ? info : null;
}

/** A folder's image names in listing order: plain names with an image extension, numeric-aware. */
async function folderImageNames(folder: string) {
  return (await readdir(folder)).filter((name) => plainFileName(name) && isGalleryImageName(name)).sort(compareNames);
}

/** One folder entry when it is a listable image: inside the roots after resolving symlinks, a regular file, at most 8 MB. */
async function folderEntry(folder: string, name: string, roots: readonly string[]) {
  const real = await withinReal(join(folder, name), roots);
  const file = real ? await imageInfo(real) : null;
  return real && file ? { name, real, file } : null;
}

/** How many of `names` are listable images, checked in batches; stops counting at `limit`. */
async function countImages(folder: string, names: readonly string[], roots: readonly string[], limit: number) {
  let count = 0;
  for (let start = 0; start < names.length && count < limit; start += BATCH) {
    const checked = await Promise.all(names.slice(start, start + BATCH).map((name) => folderEntry(folder, name, roots)));
    count += checked.filter(Boolean).length;
  }
  return count;
}

/**
 * The card's gallery images (EVIDENCE-GALLERY-SPEC §2.1): output image files, and the images directly inside
 * output folders (top level, numeric-aware name order, at most 200 per folder). Outputs newest first; the same
 * real path once; anything outside the card's roots (after resolving symlinks) is skipped.
 */
export async function galleryImages(list: readonly Artifact[], where: ArtifactRoots): Promise<GalleryImage[]> {
  const outputs = list.filter(isGalleryArtifact).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!outputs.length) return [];
  const roots = await realRoots(where);
  const seen = new Set<string>();
  const images: GalleryImage[] = [];
  for (const artifact of outputs) {
    const target = absoluteTarget(artifact.target, where.workspace);
    const path = await withinReal(target, roots);
    if (!path) continue;
    const info = await stat(path).catch(() => null);
    if (!info) continue;
    if (info.isFile()) {
      const name = basename(target);
      if (!isGalleryImageName(name) || info.size > galleryLimits.maxBytes || seen.has(path)) continue;
      seen.add(path);
      images.push({ artifactId: artifact.id, name, size: info.size, mtime: Math.round(info.mtimeMs) });
      continue;
    }
    if (!info.isDirectory()) continue;
    let names: string[];
    try {
      names = await folderImageNames(path);
    } catch (e) {
      logFailure("Gallery folder not read:", e, path);
      continue;
    }
    let count = 0;
    for (let start = 0; start < names.length && count < galleryLimits.perFolder; start += BATCH) {
      const checked = await Promise.all(names.slice(start, start + BATCH).map((name) => folderEntry(path, name, roots)));
      for (const entry of checked) {
        if (!entry || count >= galleryLimits.perFolder) continue;
        // The cap counts the folder's own images, so it is the same listing `galleryImageFile` checks against.
        count++;
        if (seen.has(entry.real)) continue;
        seen.add(entry.real);
        images.push({ artifactId: artifact.id, name: entry.name, size: entry.file.size, mtime: Math.round(entry.file.mtimeMs) });
      }
    }
  }
  return images;
}

/**
 * The image one gallery tile names (EVIDENCE-GALLERY-SPEC §2.3): an output image file, or for an output folder a
 * plain file `name` from its listing. Realpath'ed, checked against the card's roots, a regular file, at most 8 MB.
 */
export async function galleryImageFile(artifact: Artifact, name: string | undefined, where: ArtifactRoots): Promise<GalleryFile> {
  if (!isGalleryArtifact(artifact)) throw new Error("Only a card's output files have gallery images.");
  const roots = await realRoots(where);
  const target = absoluteTarget(artifact.target, where.workspace);
  const base = await withinReal(target, roots);
  if (!base) throw new Error("This file no longer exists.");
  const info = await stat(base);
  let path: string;
  let fileName: string;
  if (info.isDirectory()) {
    if (name === undefined || !plainFileName(name)) throw new Error("Name an image in this folder.");
    // Only a name in the folder's listing: an image, within its first 200 (EVIDENCE-GALLERY-SPEC §2.3).
    const names = await folderImageNames(base);
    const at = names.indexOf(name);
    if (at < 0) throw new Error("This image is not in the folder.");
    const entry = await folderEntry(base, name, roots);
    if (!entry) throw new Error("This image no longer exists.");
    if (at >= galleryLimits.perFolder && (await countImages(base, names.slice(0, at), roots, galleryLimits.perFolder)) >= galleryLimits.perFolder)
      throw new Error("This image is not in the folder.");
    path = entry.real;
    fileName = name;
  } else {
    fileName = basename(target);
    if (name !== undefined && name !== fileName) throw new Error("This image is not in the folder.");
    path = base;
  }
  const mimeType = galleryMimeTypes[extensionOf(fileName)];
  if (!mimeType) throw new Error("This file is not an image.");
  const file = await stat(path);
  if (!file.isFile()) throw new Error("This file is not an image.");
  if (file.size > galleryLimits.maxBytes) throw new Error("This image is larger than 8 MB.");
  return { path, mimeType, size: file.size, mtime: Math.round(file.mtimeMs) };
}

async function original(file: GalleryFile) {
  const bytes = await readFile(file.path);
  if (bytes.length > galleryLimits.maxBytes) throw new Error("This image is larger than 8 MB.");
  return `data:${file.mimeType};base64,${bytes.toString("base64")}`;
}

/** Grid tiles crop images to squares, so the short side decides how sharp a thumbnail looks. */
const THUMBNAIL_SHORT_SIDE = 640;
/** Keeps very wide or tall images from producing large thumbnails. */
const THUMBNAIL_MAX_LONG_SIDE = 1600;
const run = promisify(execFile);

/** Runs jobs with at most `size` at once; the rest wait their turn in order. */
export function slots(size: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (active >= size) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await job();
    } finally {
      // Hand the slot straight to the next job, or free it.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
/** At most 4 `sips` thumbnails are made at once, however many tiles ask. */
const sipsSlot = slots(4);

async function imageSize(path: string) {
  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path]);
  const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Removes the cached thumbnails of earlier versions of the same file (same path prefix, another name). */
async function pruneOlder(cacheDir: string, prefix: string, keep: string) {
  try {
    const stale = (await readdir(cacheDir)).filter((entry) => entry.startsWith(prefix) && entry !== keep && entry.endsWith(".png"));
    await Promise.all(stale.map((entry) => rm(join(cacheDir, entry), { force: true })));
  } catch (e) {
    logFailure("Gallery thumbnail cache not pruned:", e, cacheDir);
  }
}

/**
 * The image as a `data:` URI. `thumb`: a copy whose short side is 640 px (long side at most 1600), made with the
 * `sips` tool built into macOS and cached in `cacheDir` (mode 0700) by path, size and modification time; writing a
 * new version's thumbnail removes that path's older ones. Other
 * platforms, images that would not shrink and any failure get the original file.
 */
export async function readGalleryImage(file: GalleryFile, size: "thumb" | "full", cacheDir: string): Promise<string> {
  if (size === "full" || process.platform !== "darwin") return original(file);
  // `<path hash>-<version hash>-…`: a shot rewritten in place gets a new name, and its older entries are found by the prefix.
  const hash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 20);
  const prefix = `${hash(file.path)}-`;
  const name = `${prefix}${hash(`${file.size}\0${file.mtime}`)}-s${THUMBNAIL_SHORT_SIDE}-l${THUMBNAIL_MAX_LONG_SIDE}.png`;
  const out = join(cacheDir, name);
  try {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await chmod(cacheDir, 0o700);
  } catch (e) {
    logFailure("Gallery thumbnail folder not made:", e, cacheDir);
    return original(file);
  }
  try {
    const cached = await readFile(out);
    if (cached.length >= file.size) return original(file);
    return `data:image/png;base64,${cached.toString("base64")}`;
  } catch {
    // Not cached yet.
  }
  return sipsSlot(() => makeThumbnail(file, cacheDir, out, prefix, name));
}

async function makeThumbnail(file: GalleryFile, cacheDir: string, out: string, prefix: string, name: string) {
  const partial = `${out}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const dimensions = await imageSize(file.path);
    if (!dimensions) return original(file);
    const long = Math.max(dimensions.width, dimensions.height);
    const short = Math.min(dimensions.width, dimensions.height);
    const target = Math.min(Math.round((long * THUMBNAIL_SHORT_SIDE) / short), THUMBNAIL_MAX_LONG_SIDE);
    if (target >= long) return original(file);
    await run("sips", ["-Z", String(target), "-s", "format", "png", file.path, "--out", partial]);
    await rename(partial, out);
    await pruneOlder(cacheDir, prefix, name);
    const bytes = await readFile(out);
    // Re-encoding can grow already compact images; then the original is the better thumbnail.
    if (bytes.length >= file.size) return original(file);
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch (e) {
    logFailure("Gallery thumbnail failed:", e, file.path);
    await rm(partial, { force: true }).catch(() => {});
    return original(file);
  }
}

type Paseo = Parameters<ArtifactService["where"]>[1];

/** `artifacts.gallery`: the card's gallery images, without bytes. */
export async function cardGallery(service: ArtifactService, input: { taskId: string }, paseo: Paseo) {
  const board = await service.store.read();
  const list = board.artifacts.filter((a) => a.taskId === input.taskId);
  if (!list.some(isGalleryArtifact)) return { images: [] };
  return { images: await galleryImages(list, await service.where(input.taskId, paseo, board)) };
}

/** `artifacts.gallery-image`: one gallery image as a `data:` URI, thumbnail or full size. */
export async function cardGalleryImage(service: ArtifactService, input: { artifactId: string; name?: string; size: "thumb" | "full" }, paseo: Paseo) {
  const board = await service.store.read();
  const artifact = board.artifacts.find((a) => a.id === input.artifactId);
  if (!artifact) throw new Error("This artifact no longer exists.");
  const file = await galleryImageFile(artifact, input.name, await service.where(artifact.taskId, paseo, board));
  return { dataUri: await readGalleryImage(file, input.size, join(service.store.directory, "gallery-thumbnails")) };
}
