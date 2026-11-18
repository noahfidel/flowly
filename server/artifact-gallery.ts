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
      names = (await readdir(path)).filter((name) => plainFileName(name) && isGalleryImageName(name)).sort(compareNames);
    } catch (e) {
      logFailure("Gallery folder not read:", e, path);
      continue;
    }
    let count = 0;
    for (let start = 0; start < names.length && count < galleryLimits.perFolder; start += BATCH) {
      const checked = await Promise.all(
        names.slice(start, start + BATCH).map(async (name) => {
          const real = await withinReal(join(path, name), roots);
          const file = real ? await imageInfo(real) : null;
          return real && file ? { name, real, file } : null;
        }),
      );
      for (const entry of checked) {
        if (!entry || seen.has(entry.real) || count >= galleryLimits.perFolder) continue;
        seen.add(entry.real);
        count++;
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
    if (!(await readdir(base)).includes(name)) throw new Error("This image is not in the folder.");
    const real = await withinReal(join(base, name), roots);
    if (!real) throw new Error("This image no longer exists.");
    path = real;
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

async function imageSize(path: string) {
  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path]);
  const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * The image as a `data:` URI. `thumb`: a copy whose short side is 640 px (long side at most 1600), made with the
 * `sips` tool built into macOS and cached in `cacheDir` (mode 0700) by path, size and modification time. Other
 * platforms, images that would not shrink and any failure get the original file.
 */
export async function readGalleryImage(file: GalleryFile, size: "thumb" | "full", cacheDir: string): Promise<string> {
  if (size === "full" || process.platform !== "darwin") return original(file);
  const key = createHash("sha1").update(`${file.path}\0${file.size}\0${file.mtime}`).digest("hex");
  const out = join(cacheDir, `${key}-s${THUMBNAIL_SHORT_SIDE}-l${THUMBNAIL_MAX_LONG_SIDE}.png`);
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
  const partial = `${out}.${process.pid}.${Date.now()}.tmp`;
  try {
    const dimensions = await imageSize(file.path);
    if (!dimensions) return original(file);
    const long = Math.max(dimensions.width, dimensions.height);
    const short = Math.min(dimensions.width, dimensions.height);
    const target = Math.min(Math.round((long * THUMBNAIL_SHORT_SIDE) / short), THUMBNAIL_MAX_LONG_SIDE);
    if (target >= long) return original(file);
    await run("sips", ["-Z", String(target), "-s", "format", "png", file.path, "--out", partial]);
    await rename(partial, out);
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
