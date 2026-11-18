/**
 * The card's Gallery (EVIDENCE-GALLERY-SPEC): images reachable from the card's output file artifacts.
 * Shared rules for which artifacts count and which names are images; runtime-neutral.
 */
import type { Artifact } from "./model";

/** One gallery image as listed: no bytes; `name` is the file name (inside the folder, for a folder artifact). */
export type GalleryImage = { artifactId: string; name: string; size: number; mtime: number };

/** At most this many images per output folder (the folder preview's cap), and the largest image served. */
export const galleryLimits = { perFolder: 200, maxBytes: 8 * 1024 * 1024 } as const;

export const galleryMimeTypes: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** The lower-cased extension of a file name, with its dot; "" when it has none. */
export function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

export const isGalleryImageName = (name: string) => !!galleryMimeTypes[extensionOf(name)];

/** Only the card's own output files count: never inputs, links, the plan, review ledgers or external items (§2.1). */
export function isGalleryArtifact(a: Pick<Artifact, "role" | "kind" | "plan" | "origin" | "external">) {
  return a.role === "output" && a.kind === "file" && !a.plan && !a.origin && !a.external;
}

/** A plain file name: not empty, `.` or `..`, and no `/`, `\\` or NUL (`v1..2.png` is fine). Listed and served names both pass it. */
export function plainFileName(name: string) {
  return !!name && name !== "." && name !== ".." && !/[/\\\0]/.test(name);
}
