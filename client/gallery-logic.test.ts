import { describe, expect, test } from "vitest";
import type { Artifact } from "../shared/model";
import { galleryArtifactKey, galleryImageKey, galleryItemKey, galleryPageSize, galleryPath, gallerySelection, galleryTileSize, keepCardListing, showGallery, stepGallery } from "./gallery-logic";

const art = (id: string, extra: Partial<Artifact> = {}) =>
  ({ id, target: `./${id}`, role: "output", kind: "file", ...extra }) as Artifact;

describe("gallery section", () => {
  test("hidden when there are no images, or none read yet", () => {
    expect(showGallery(undefined)).toBe(false);
    expect(showGallery([])).toBe(false);
    expect(showGallery([{ artifactId: "a", name: "1.png", size: 1, mtime: 1 }])).toBe(true);
  });

  test("the listing key holds only output files, so a card without them reads nothing", () => {
    expect(galleryArtifactKey([art("in", { role: "input" }), art("link", { kind: "url" }), art("ledger", { origin: "review-ledger" })])).toBe("");
    expect(galleryArtifactKey([art("a"), art("in", { role: "input" }), art("b")])).toBe("a:./a|b:./b");
  });

  test("image cache keys change with size and modification time", () => {
    const image = { artifactId: "a", name: "1.png", size: 10, mtime: 5 };
    expect(galleryImageKey(image, "thumb")).not.toEqual(galleryImageKey(image, "full"));
    expect(galleryImageKey(image, "thumb")).not.toEqual(galleryImageKey({ ...image, mtime: 6 }, "thumb"));
  });

  test("the path shown is the file, or the file inside the folder", () => {
    expect(galleryPath("./shots/1.png", "1.png")).toBe("./shots/1.png");
    expect(galleryPath("/plans/run/screenshots/", "1-AFTER-a.png")).toBe("/plans/run/screenshots/1-AFTER-a.png");
    expect(galleryPath("./shots", "2.png")).toBe("./shots/2.png");
  });

  test("tiles fill the width", () => {
    expect(galleryTileSize(0, 3)).toBe(0);
    const size = galleryTileSize(360, 8);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(360);
  });

  test("a page is the section's page size in whole rows", () => {
    expect(galleryPageSize(5, 3)).toBe(6);
    expect(galleryPageSize(5, 1)).toBe(5);
    expect(galleryPageSize(5, 5)).toBe(5);
  });
});

describe("viewer stepping", () => {
  test("next and previous stop at the ends", () => {
    expect(stepGallery(0, -1, 3)).toBe(0);
    expect(stepGallery(0, 1, 3)).toBe(1);
    expect(stepGallery(2, 1, 3)).toBe(2);
    expect(stepGallery(2, -1, 3)).toBe(1);
    expect(stepGallery(0, 1, 1)).toBe(0);
  });
});

describe("listing across output changes", () => {
  const listing = { images: [{ artifactId: "a", name: "1.png", size: 1, mtime: 1 }] };
  test("a new output key keeps the same card's last listing while the new one loads, never another card's", () => {
    const keep = keepCardListing("t1");
    expect(keep(listing, { queryKey: ["flowly", "artifact-gallery", "t1", "a:./a"] })).toBe(listing);
    expect(keep(listing, { queryKey: ["flowly", "artifact-gallery", "t2", "a:./a"] })).toBeUndefined();
    expect(keep(undefined, undefined)).toBeUndefined();
  });

  test("the open image is found by artifact and name; gone means closed", () => {
    const images = [
      { artifactId: "a", name: "1.png", size: 1, mtime: 1 },
      { artifactId: "a", name: "2.png", size: 1, mtime: 1 },
    ];
    expect(gallerySelection(images, galleryItemKey(images[1]))).toBe(1);
    expect(gallerySelection(images, galleryItemKey({ ...images[1], name: "3.png" }))).toBe(-1);
    expect(gallerySelection(images, null)).toBe(-1);
    // The key tells a folder's file from another output with the same name.
    expect(galleryItemKey(images[0])).not.toBe(galleryItemKey({ ...images[0], artifactId: "b" }));
  });
});
