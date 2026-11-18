# Evidence gallery on cards (EVIDENCE-GALLERY-SPEC)

Status: scoped 2026-11-18, simplified the same day at the user's request ("don't be prescriptive about before/after; the existing gallery plugin's viewing is good, don't over-engineer it"). Decisions ruled 2026-11-18 (§4). Not built. Contract only; progress goes to `docs/PROGRESS.md`.

A card that changes UI ends with screenshots. Today the user sees them in the third-party image gallery panel, which mixes the real files (`1-BEFORE-groups-table.png`) with hash-named copies (`9e342c7f…b3de.png`) that cannot be removed. On the card itself, the shots folder attached as an output opens as a list of file names, with no images.

This spec puts a **Gallery** on the card: the images from the card's own output artifacts, under their real file names, shown with the gallery plugin's grid and viewer, which are ported into Flowly. Flowly does not interpret file names (no BEFORE/AFTER pairing, no notes format). How shots are named and ordered stays the user's harness's business.

## 1. Findings

### 1.1 The gallery code (question 1)

The gallery is not part of Paseo. It is the separately installed plugin *paseo-image-gallery* 0.2.0 (`github.com/mordol/paseo-image-gallery`, MIT, © Taegyu Ryu), checked out under `~/.paseo/plugins/paseo-image-gallery/`. It uses Flowly's own stack: TypeScript, React Native primitives and the `@getpaseo/plugin` SDK, about 950 lines:

- `server/gallery.ts`: collects images by scanning every session timeline in the workspace, dedupes by content hash, and makes thumbnails with macOS `sips` (short side 640 px, cached by content hash; it falls back to the original file elsewhere or on failure).
- `client/gallery.tsx`: the grid of thumbnails, each captioned with its file name.
- `client/viewer.tsx` and `client/web.ts`: the full-screen viewer, with next/previous and arrow keys.

Porting is allowed (MIT into MIT; keep the copyright and licence notice in each ported file's header) and cheap, since the stack is the same. Only the **collection** step is replaced: the scan of chat timelines is the source of the hash copies. Flowly owns its copy afterwards, so upstream drift does not matter.

### 1.2 The hash-named entries (question 3)

The Paseo daemon makes them (`@getpaseo/server`, `materializeProviderImage`). When a provider returns an image (Read of a PNG, a browser screenshot tool), the daemon writes the bytes to `<sha256>.<ext>` in a `paseo-attachments-XXXXXX` temp folder shared by every session, and adds `![Image](file:///…)` to the timeline. The gallery plugin picks that up like any other image and keeps the earliest copy of identical content, often the hash copy. When the real file is changed afterwards (a banner added in place), both versions stay.

**Flowly cannot hide them.** A plugin has no hook into another plugin's panel, and Flowly must not rewrite session transcripts or Paseo's temp folder. The fix is upstream (§5). Flowly's own Gallery never shows them, because it reads only registered artifacts.

### 1.3 What Flowly has, and what is missing (questions 2 and 4)

Flowly already has what the data side needs. Output artifacts can point at files or folders, including folders outside the repo through *Extra artifact folders* (CARD-ARTIFACTS-SPEC). `artifacts.preview` already serves an image as a `data:` URI (up to 8 MB) with root checks.

What is missing is only a view: listing the images inside a registered folder, thumbnails, and a grid and viewer. **No new artifact kind, role, field, storage or agent tool.**

### 1.4 The harness reading it back (question 5)

Nothing new is needed. The harness attaches the folder and already knows its files. `flowly_get_task.artifacts[].absolutePath` gives the folder, and the harness lists it itself for its Linear step. Flowly never writes to Linear.

## 2. Behaviour

### 2.1 Which images

- A card's gallery images are every image reachable from its **output** file artifacts:
  - an output whose target is an image file;
  - the images directly inside an output whose target is a folder (one level, not recursive).
- Images are png, jpg, jpeg, gif and webp.
- Inputs, the plan, review ledgers and external items are never included. Nothing outside registered artifacts is shown.
- The same real path is shown once.
- Each folder is capped at 200 images, matching the folder preview.
- The same root and realpath checks apply as for `previewFile`. A symlink pointing outside the roots is skipped.
- Caption: the file name, as the gallery plugin does.
- Order: outputs in Artifacts-list order (newest first). Inside a folder, by file name, with numeric-aware sorting so that `10-…` comes after `9-…`.

### 2.2 UI (ported, not redesigned)

- A movable card sidebar section, **Gallery** (DRAWER-SPEC "Section order"). It is shown only when the card has at least one gallery image, and has no `+` (images come from outputs).
- The body is the gallery plugin's grid, ported as it is: thumbnails with file-name captions. On a busy card, the section's own paging rule applies.
- Pressing a tile opens the ported viewer at that image: full size, next/previous across the card's gallery, arrow keys on web, and the file name and path.
- No delete, edit, reorder, zoom or notes. The files belong to whoever wrote them.
- Plugin rules apply to the ported code:
  - client: React Native primitives only, with web-only key handling feature-detected as in the original;
  - `t()` for every string, in all catalogs;
  - theme colours;
  - Reduce Motion;
  - fetch only the tiles that are on screen.

### 2.3 Server

- The listing RPC is `artifacts.gallery({ taskId })`. It returns `{ artifactId, name, size, mtime }` per image, and no bytes.
- The image RPC is `artifacts.gallery-image({ artifactId, name?, size: "thumb" | "full" })`, which returns a `data:` URI.
  - `name` is required for a folder artifact. It must be a plain file name (no `/`, `\`, `..` or NUL) that appears in that folder's listing.
  - The resolved path is realpath'ed, checked against the card's roots, and must be a regular file.
  - The 8 MB limit applies.
  - Thumbnails come from the ported `sips` path, with the original's fallback. Use an argument array, and make the cache folder `0700`.
- The client's cache key includes `size` and `mtime`, because shots are rewritten in place.
- Failures are logged with `logFailure`.
- There is no change to `board.json`, `flowly_get_task` or any write path.

## 3. Rejected options

| Option | Why not |
| --- | --- |
| Use the gallery plugin as it is, or link to it | Third-party and optional; its source is the chat scan that produces the hash copies. |
| Hide the hash entries from Flowly | Not possible (§1.2). |
| Port the whole plugin, including its timeline scan | Brings the hash copies along. Only the collection step is swapped. |
| BEFORE/AFTER pairing, captions parsed from names, a notes sidecar, `get_task.evidence` | Too prescriptive (user, 2026-11-18): it ties Flowly to one harness's naming. File names are already the captions. |
| A new artifact role or an "evidence" flag plus tool | Shots are already outputs; a derived view needs no new data. |
| Write a new viewer from scratch | The plugin's viewer is good, MIT and on the same stack. |

## 4. Decisions

Ruled by the user on 2026-11-18. None remain open.

1. **Folder depth: top level only.** The Gallery shows only images directly inside an output folder; subfolders are not read. Recursion was rejected because older plans keep near-copies of the same shots in `before/`, `after/` and `annotated/` subfolders, and because it would need caps to avoid walking large trees.
2. **Placement: its own section.** Gallery is a separate movable sidebar section after Artifacts (§2.2). It is not a strip inside Artifacts, which already lists specs, PR links, ledgers, handoffs, external items and other files.
3. **Onboarding: none.** No welcome-tour line and no tip for the Gallery. This is the explicit "neither is warranted" choice that the AGENTS.md onboarding-upkeep rule allows; G1's delivery note says so. Whether to remove the welcome tour altogether is a separate follow-up idea, not part of this spec.

## 5. Upstream report (separate, not Flowly work)

The report goes to **paseo-image-gallery**, on its tracker, and only with the user's go-ahead. Title: *Hash-named copies from paseo-attachments duplicate or replace the real image*.

- **Cause:** the scanner treats the daemon's `paseo-attachments-*/<sha256>` markdown as a normal image, and its content dedupe keeps the earliest copy.
- **Asks:**
  1. When the content is the same, prefer the path outside `paseo-attachments-*`.
  2. Add an option to hide `paseo-attachments-*` images.
  3. Optionally, add a per-tile Hide.

An optional, lower-priority report to Paseo: put the source file name in the materialized image's alt text (today it is `Image`), and clean up old `paseo-attachments-*` temp folders.

## 6. Cards

| # | Card | Delivers | Relations |
| --- | --- | --- | --- |
| G1 | Card gallery: port paseo-image-gallery's grid and viewer over output artifacts | §2 (RPCs, ported thumbnailer, grid, viewer, section order), i18n, no onboarding (§4.3), tests, desktop and compact screenshots (shot-lib, Tinylink fixture) | none |
| G2 | Upstream report to paseo-image-gallery | §5. Not a Flowly repo change; outward-facing, so only with the user's go-ahead | independent |

## 7. Tests and docs (for G1)

- **Server tests:**
  - only output artifacts count;
  - folders are read one level deep and capped at 200;
  - a symlink pointing outside the roots is refused;
  - a `name` containing `/` or `..`, or not in the listing, is refused;
  - a folder named `x.png` is refused;
  - images over 8 MB are refused;
  - extra artifact folders are honoured;
  - images are deduplicated by real path;
  - names sort numeric-aware.
- **Client tests:** the section is hidden when there are no images; the viewer's next/previous stop at the ends. `npm test` checks that the i18n catalogs are complete.
- **Docs:**
  - a dated addition to CARD-ARTIFACTS-SPEC pointing here;
  - the DRAWER-SPEC section list and `shared/drawer-sections.ts`;
  - a What's new entry if the release is minor;
  - `docs/PROGRESS.md`.
- **Telemetry:** no heartbeat field, since this is a read-only view.
