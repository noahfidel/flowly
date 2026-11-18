/*
 * Gallery image reads (EVIDENCE-GALLERY-SPEC §2.3), ported from paseo-image-gallery
 * (github.com/mordol/paseo-image-gallery, client/image.ts).
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
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { GalleryImage } from "../shared/gallery";
import { galleryImageKey } from "./gallery-logic";

/**
 * One gallery image as a URI the Image component can show, read from the daemon once per size and
 * modification time (the key holds both, so a shot rewritten in place is read again). `enabled`: only
 * tiles on screen and the image open in the viewer read anything.
 */
export function useGalleryImage(image: GalleryImage, size: "thumb" | "full", enabled: boolean) {
  const read = useRpc(rpc.artifactGalleryImage);
  const query = useQuery({
    queryKey: galleryImageKey(image, size),
    queryFn: () => read({ artifactId: image.artifactId, name: image.name, size }),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    // Full-size images are large; drop them soon after the viewer moves on.
    gcTime: size === "full" ? 30_000 : 5 * 60_000,
    retry: false,
  });
  return { uri: query.data?.dataUri ?? null, error: query.error, loading: enabled && query.isPending };
}
