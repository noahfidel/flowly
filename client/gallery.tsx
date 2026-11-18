/*
 * The card's Gallery section (EVIDENCE-GALLERY-SPEC §2.2): the images from the card's output artifacts as a
 * grid of thumbnails captioned with their file names; a tile opens the viewer. The grid is ported from
 * paseo-image-gallery (github.com/mordol/paseo-image-gallery, client/gallery.tsx); its collection is replaced
 * by the card's registered outputs.
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
import { memo, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { Task } from "../shared/model";
import type { GalleryImage } from "../shared/gallery";
import { artifactsOf } from "../shared/artifacts";
import { t } from "../shared/i18n";
import { useTaskDetail } from "./card-detail-query";
import { Section, ShowMore, pageSize, type SectionState } from "./disclosure";
import { useReducedMotion } from "./motion";
import { useStableCallback } from "./stable";
import { font, noFocusRing, radius, space, useTheme } from "./ui";
import { galleryArtifactKey, galleryColumns, galleryPageSize, galleryPath, galleryTileSize, showGallery } from "./gallery-logic";
import { useGalleryImage } from "./gallery-image";
import { GalleryViewer, type ViewerItem } from "./gallery-viewer";

/** Shared empty listing, so a card without images never hands a fresh array to memoized children. */
const NO_IMAGES: readonly GalleryImage[] = [];
const GAP = space[2];
const itemKey = (image: GalleryImage) => `${image.artifactId}\u0000${image.name}`;

/**
 * The card's gallery listing (no bytes). Read when the drawer shows the card or its output files change, like the
 * missing-file check (CARD-ARTIFACTS-SPEC §9): keyed on the output file artifacts, never polled.
 */
function useCardGallery(taskId: string, fileKey: string, active: boolean) {
  const read = useRpc(rpc.artifactGallery);
  return useQuery({
    queryKey: ["flowly", "artifact-gallery", taskId, fileKey],
    queryFn: () => read({ taskId }),
    enabled: active && !!fileKey,
    staleTime: 30_000,
    retry: false,
  });
}

const Thumbnail = memo(function Thumbnail({
  item,
  size,
  enabled,
  theme,
  onOpen,
}: {
  item: ViewerItem;
  size: number;
  /** Read the thumbnail: the tile is on screen. */
  enabled: boolean;
  theme: PluginTheme;
  onOpen(key: string): void;
}) {
  const { uri, error, loading } = useGalleryImage(item.image, "thumb", enabled);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Open {name}", { name: item.image.name })}
      onPress={() => onOpen(itemKey(item.image))}
      style={({ pressed }) => ({ ...noFocusRing, width: size, gap: space[1], opacity: pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          width: size,
          height: size,
          borderRadius: radius.lg,
          overflow: "hidden",
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {uri ? (
          <Image source={{ uri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
        ) : loading ? (
          <ActivityIndicator color={theme.colors.foregroundMuted} />
        ) : (
          <Icon name="ImageOff" size={20} color={error ? theme.colors.statusDanger : theme.colors.foregroundMuted} />
        )}
      </View>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: font.xs }}>
        {item.image.name}
      </Text>
    </Pressable>
  );
});

/** Drawer "Gallery": shown only when the card has at least one gallery image; no "+" (images come from outputs). */
export function TaskGallery({ task, active, section }: { task: Task; active: boolean; section: SectionState }) {
  const { detail } = useTaskDetail();
  const theme = useTheme();
  const reduced = useReducedMotion();
  const all = useMemo(() => (detail ? artifactsOf(detail.artifacts, task.id) : []), [detail, task.id]);
  const fileKey = galleryArtifactKey(all);
  const gallery = useCardGallery(task.id, fileKey, active);
  // A card whose outputs went away keeps no stale listing.
  const images = (fileKey && gallery.data?.images) || NO_IMAGES;
  const targets = useMemo(() => new Map(all.map((a) => [a.id, a.target])), [all]);
  const items = useMemo<ViewerItem[]>(
    () => images.map((image) => ({ image, path: galleryPath(targets.get(image.artifactId) ?? "", image.name) })),
    [images, targets],
  );
  const [width, setWidth] = useState(0);
  const [pages, setPages] = useState(1);
  // Per opening of the sidebar, like the other sections: Show more only adds tiles, reopening starts over.
  useEffect(() => {
    if (active) setPages(1);
  }, [active]);
  const [selected, setSelected] = useState<string | null>(null);
  const onOpen = useStableCallback((key: string) => setSelected(key));
  const onClose = useStableCallback(() => setSelected(null));
  const onIndexChange = useStableCallback((index: number) => {
    const item = items[index];
    if (item) setSelected(itemKey(item.image));
  });
  if (!showGallery(images)) return null;
  const size = galleryTileSize(width, GAP);
  const step = galleryPageSize(pageSize, galleryColumns(width, GAP));
  const limit = pages * step;
  const rest = items.length - limit;
  // Track the open image by key so a new listing that adds images does not change what is shown.
  const selectedIndex = selected === null ? -1 : items.findIndex((item) => itemKey(item.image) === selected);
  return (
    <>
      <Section id={task.id} focusId="gallery" title={t("Gallery")} count={items.length} open={section.open} onToggle={section.onToggle}>
        <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ flexDirection: "row", flexWrap: "wrap", gap: GAP }}>
          {size > 0 &&
            items.slice(0, limit).map((item) => (
              <Thumbnail key={itemKey(item.image)} item={item} size={size} enabled={active} theme={theme} onOpen={onOpen} />
            ))}
        </View>
        {size > 0 && rest > 0 && <ShowMore count={Math.min(step, rest)} onPress={() => setPages((current) => current + 1)} />}
      </Section>
      {selectedIndex >= 0 && (
        <GalleryViewer items={items} index={selectedIndex} theme={theme} reduced={reduced} onIndexChange={onIndexChange} onClose={onClose} />
      )}
    </>
  );
}
