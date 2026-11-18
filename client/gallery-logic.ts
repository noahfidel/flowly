/** Pure rules of the card's Gallery section and viewer (EVIDENCE-GALLERY-SPEC §2.2). */
import type { Artifact } from "../shared/model";
import { isGalleryArtifact, type GalleryImage } from "../shared/gallery";

/** The section shows only when the card has at least one gallery image. */
export const showGallery = (images: readonly GalleryImage[] | undefined) => !!images && images.length > 0;

/** The listing query's key part: the card's output file artifacts. Empty when there are none, so nothing is read. */
export function galleryArtifactKey(list: readonly Artifact[]) {
  return list.filter(isGalleryArtifact).map((a) => `${a.id}:${a.target}`).join("|");
}

/** The cache key of one image at one size; shots are rewritten in place, so it holds size and mtime. */
export const galleryImageKey = (image: GalleryImage, size: "thumb" | "full") =>
  ["flowly", "gallery-image", image.artifactId, image.name, size, image.size, image.mtime] as const;

/** The path shown in the viewer: the output file itself, or the image inside the output folder. */
export function galleryPath(target: string, name: string) {
  const trimmed = target.replace(/\/+$/, "");
  return trimmed.split("/").pop() === name ? trimmed : `${trimmed}/${name}`;
}

/** Next or previous image; stays put at either end. */
export function stepGallery(index: number, delta: number, length: number) {
  const next = index + delta;
  return next >= 0 && next < length ? next : index;
}

/** How many ~`target` px columns fit in `width` (the gallery plugin's compact grid). */
export function galleryColumns(width: number, gap: number, target = 110) {
  return Math.max(1, Math.floor((width + gap) / (target + gap)));
}

/** Tile edge for a grid `width` wide, so the columns fill it. */
export function galleryTileSize(width: number, gap: number, target = 110) {
  if (width <= 0) return 0;
  const columns = galleryColumns(width, gap, target);
  return Math.floor((width - gap * (columns - 1)) / columns);
}

/** Tiles per page: the section's page size, rounded up to whole rows. */
export const galleryPageSize = (pageSize: number, columns: number) => Math.max(1, columns) * Math.ceil(pageSize / Math.max(1, columns));

/** One image's identity in the gallery: its output and its file name. */
export const galleryItemKey = (image: Pick<GalleryImage, "artifactId" | "name">) => `${image.artifactId}\u0000${image.name}`;

/** Where the open image is in the listing; -1 when none is open or it is gone (then the viewer closes). */
export function gallerySelection(images: readonly GalleryImage[], selected: string | null) {
  return selected === null ? -1 : images.findIndex((image) => galleryItemKey(image) === selected);
}

/**
 * Placeholder for the listing query: while a changed output key loads, keep this card's last listing (so the
 * section and an open viewer stay); never carry over another card's (the key's third part is the card id).
 */
export function keepCardListing(taskId: string) {
  return <T>(previous: T | undefined, previousQuery: { queryKey: readonly unknown[] } | undefined): T | undefined =>
    previousQuery?.queryKey[2] === taskId ? previous : undefined;
}
