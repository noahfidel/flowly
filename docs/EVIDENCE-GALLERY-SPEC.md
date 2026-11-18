# Evidence gallery on cards (EVIDENCE-GALLERY-SPEC)

Status: scoped 2026-11-18 (scoping card "Scope: first-class evidence gallery on Flowly cards"). Not built. The open decisions in §9 need the user's rulings before the first build card starts. Contract only; progress goes to `docs/PROGRESS.md`.

A card that changes UI ends with before/after screenshots. Today they reach the user in two ways, and neither works well:

- **The image gallery panel** in the card's workspace (a third-party plugin, not Paseo itself, §1.1). It shows every image that entered any of the workspace's chats. Next to the real shots (`1-BEFORE-groups-table.png`, `1-AFTER-groups-table.png`) it shows hash-named copies (`9e342c7f…b3de.png`) of the same images, with no BEFORE/AFTER caption, which cannot be removed.
- **The card's Artifacts list.** The harness attaches the shots folder as an output. Pressing it opens a list of file names (CARD-ARTIFACTS-SPEC §6.1, directory preview); no image is shown, nothing is paired.

This spec makes the card's registered output images the first-class evidence: an **Evidence** view on the card that shows them by their real file names, paired BEFORE/AFTER, with captions, a larger view and per-shot notes, and that `flowly_get_task` returns so a card session (the harness's Linear evidence step) can read the pairs back. It lives entirely in Flowly. It does not change, fork or hide anything in the gallery plugin or in Paseo; those are separate upstream reports (§8).

## 1. Findings

### 1.1 Paseo's gallery code (question 1)

**The gallery is not part of Paseo.** It is a separately installed third-party plugin, *paseo-image-gallery* 0.2.0 (upstream `github.com/mordol/paseo-image-gallery`, MIT, © Taegyu Ryu), installed as a plugin checkout under `~/.paseo/plugins/paseo-image-gallery/`. The Paseo desktop app (Electron around an Expo / React Native web export) has no image gallery of its own; its only related UI is the composer's attachment lightbox. No Paseo source checkout is on this machine; the daemon ships as the npm package `@getpaseo/cli` / `@getpaseo/server` (Apache-2.0).

The gallery plugin uses Flowly's own stack: TypeScript, React Native primitives and the `@getpaseo/plugin` SDK, about 950 lines (`server/gallery.ts` 266, `client/viewer.tsx` 421, `client/gallery.tsx` 162). How it works:

- **Collection** (daemon): lists the workspace's non-archived, non-background agents, pages each one's timeline and pulls image paths and URLs out of user messages, assistant messages and tool calls (including a tool call's `filePath`) with regexes. It drops missing files, then dedupes by a sha1 of the file content, **keeping the earliest appearance**.
- **Captions**: the file name of the kept path. Path, session and time show in the viewer.
- **Serving**: an RPC returns base64 for paths the last scan returned (an allow-list). Thumbnails are made with macOS `sips` (short side 640 px, cached in a temp folder by content hash), falling back to the original file on other platforms or on failure.
- **Viewer**: a full-screen modal with next/previous and arrow keys (`client/viewer.tsx`, `client/web.ts`).

Copying: allowed (MIT into MIT, keeping the copyright and licence notice in the copied file's header). Copying the whole plugin is the wrong model: its source is "every image any session's chat mentioned", exactly what this spec avoids. Two pieces are worth adapting rather than rewriting: the **viewer's navigation and keyboard handling**, and the **`sips` thumbnail with fallback**. Upstream drift does not matter for a one-time adaptation of a small, self-contained piece; Flowly owns its copy afterwards. Flowly's own image path is already in place (`artifacts.preview` → `data:` URI → `<Image>`), so the rest is simpler to write in Flowly's client code.

### 1.2 Where the hash-named entries come from, and whether Flowly can hide them (question 3)

The copies are made by the Paseo daemon, confirmed in `@getpaseo/server` (`agent/providers/provider-image-output.js`, `materializeProviderImage`): when a provider returns an image (the Read tool on a PNG, a browser screenshot tool), the daemon writes the bytes to `<sha256 of content>.<ext>` in one `paseo-attachments-XXXXXX` folder made with `mkdtemp` in the OS temp folder (folder 0700, files 0600). That folder is cached per daemon process, so it is **shared by every session**, not per session. The daemon then adds an assistant message `![Image](file:///…/paseo-attachments-XXXXXX/<hash>.png)` to the timeline. Several such folders exist on this machine (one per daemon run).

The gallery plugin picks that markdown up like any other image. Its dedupe is by content, but it keeps the **earliest** appearance, and the copy often comes first (a screenshot tool returns the image before the file is saved under its real name, or the banner script rewrites the file afterwards so the contents differ and both stay). So the user sees the hash name, no BEFORE/AFTER, and a near-duplicate. There is no remove action because the gallery has no state of its own: it rescans timelines.

**Flowly cannot affect this.** The SDK gives a plugin no hook into another plugin's panel; timeline transformers (`addTimelineTransformer`) change how a timeline item renders, not what the gallery plugin's daemon reads from the timeline, and rewriting other sessions' transcripts would break the AGENTS.md rule that a card's follow-up sends exactly the user's text. Flowly must not touch Paseo's temp folder either. The fix belongs to the gallery plugin (and, optionally, Paseo); see §8. Until then the user's own levers are: keep images out of the card session's chat (their harness rule already says so), or turn the gallery plugin off.

### 1.3 What Flowly has today (question 2)

| Piece | Today | Source |
| --- | --- | --- |
| Artifact record | `{ role: input|output, kind: file|url, target, title, note, createdBy, origin?, plan?, external? }`, at most 100 per card, references only (no copies) | CARD-ARTIFACTS-SPEC §2.1, `shared/model.ts` |
| Files outside the repo | *Extra artifact folders* (host setting); the harness has `~/.claude/plans` there, so `~/.claude/plans/<plan>/run/screenshots/` can be attached | CARD-ARTIFACTS-SPEC 2026-11-08 addition |
| A folder as an artifact | Allowed (`kind: "file"`, target a directory). Its preview lists the first 200 entry names, not recursive, no images | `previewFile` in `server/artifacts.ts` |
| An image as an artifact | Preview returns a `data:` URI (png/jpg/gif/webp, ≤ 8 MB) and shows it 480 px high in a modal; no zoom, no next/previous | `ArtifactPreview` in `client/task-artifacts.tsx` |
| Card sidebar | Artifacts section: Outputs then Inputs, 5 rows per page, icon + title + note; no thumbnails | CARD-ARTIFACTS-SPEC §5.2, DRAWER-SPEC |
| First-class precedents | The plan (an artifact with a `plan` field, its own row, `get_task.cardPlan`) and review ledgers (an artifact with `origin: "review-ledger"`, Flowly-managed) | CARD-PLAN-SPEC §1.1, REVIEW-LEDGERS-SPEC §3 |
| Agent read | `flowly_get_task.artifacts[]` with `absolutePath`, `missing`, `unread`; folders are not expanded | CARD-ARTIFACTS-SPEC §4.2 |
| Image-serving precedent | `sessions.image` serves a local image only when the session's own transcript references it | `server/session-images.ts` |

Missing for evidence: expanding a registered folder into its images; pairing BEFORE/AFTER by name; captions; an order; a viewer with next/previous and side-by-side; per-shot notes; returning all of that to agents. Flowly already shows only what the user or an agent registered, so "hiding nothing the user did not register" holds by construction: the gallery never scans a session or the temp attachment cache.

### 1.4 The harness's shots (fit)

The user's harness (`~/.claude/rules/stack.md`, "Show finished UI work") writes one file per shot to `~/.claude/plans/<plan>/run/screenshots/<n>-<SIDE>-<screen>.png`, `SIDE` in `BEFORE|AFTER`, adds a grey or green banner in place (`annotate-shots.py`, which also records the banner height in a PNG text chunk `shot-banner-height`), draws numbered red boxes for marked spots, and attaches the folder to the card as an output. Older plans used other layouts (`before/`, `after/`, `annotated/` subfolders, free names, an HTML mockup, a `screens.md`). The gallery must cope with both: what matches the naming pattern is paired, everything else is still shown, unpaired.

## 2. Recommended approach

**A viewer over existing output artifacts, plus a read-only sidecar for notes.** No new artifact kind, no new role, no new storage, no new write tool.

1. **Evidence source.** A card's evidence is every image reachable from its **output** file artifacts: an output whose target is an image file, plus the images directly inside an output whose target is a folder (one level, not recursive; §9 Q2). Input artifacts, the plan, review ledgers and external items are never evidence. Nothing outside registered artifacts is ever shown.
2. **Pairing and captions from the file name** (§3). `<n>-BEFORE-<screen>.<ext>` and `<n>-AFTER-<screen>.<ext>` with the same `<n>` and `<screen>` form a pair captioned `<n> · <screen>`; the side is the column. Anything else is a single shot captioned with its file name.
3. **Notes from a sidecar file** the harness writes next to the shots (§4): per-pair "what changed" and per-mark notes. Flowly only reads it, as it only reads review ledgers.
4. **UI**: an Evidence section in the card sidebar with pair thumbnails, and a viewer with BEFORE/AFTER side by side (stacked on phones), next/previous, and the notes (§5).
5. **Agent read**: `flowly_get_task` gains `evidence` with the pairs, absolute paths, captions and notes (§6). The harness reads it in the card session for its Linear step and uploads with its own tools. Flowly never writes to Linear.

### 2.1 Rejected options

| Option | Why not |
| --- | --- |
| Copy the whole paseo-image-gallery plugin into Flowly | Its model (scan every session's timeline, show what the chat mentioned) is the problem being solved. Only the viewer navigation and the thumbnailer are adapted (§1.1, §7). |
| Depend on the gallery plugin (call it, or link to its panel) | A third-party plugin the user may not have installed; no cross-plugin API; it would still show the hash copies. |
| Hide or filter Paseo's hash-named entries from Flowly | Not possible (§1.2); a plugin has no hook into the host gallery. Belongs upstream (§8). |
| A new artifact role `evidence` (beside input/output) | Shots are outputs. A third role changes the add form, the role groups, `flowly_add_artifact`, delivery `outputs`, session context and every role check, for what a derived view gives for free. The plan's precedent was a field, not a role. |
| A new artifact field `evidence: true` set by a tool (`flowly_set_evidence`) | Smallest data change of the "registered" options, but needs a tool, an RPC, a form option and rules for every writer, while the user's folder is already registered as an output. Kept as a fallback if Q1 rules that only marked artifacts count. |
| Flowly stores captions and notes (`board.evidence`, a `flowly_annotate_shot` tool) | A second home for text the harness already writes; ties the board schema to a per-file note model; needs conflict and size rules. The sidecar keeps the harness the single writer. |
| Notes inside each PNG (text chunks next to `shot-banner-height`) | Self-contained, but every note edit rewrites the image, other tools strip chunks, and Flowly would need a PNG chunk reader. Not worth it when a sidecar file sits in the same folder. |
| Register each shot as its own artifact with its note | Two artifacts per pair against the 100-per-card limit; ordering, pairing and captions still need this spec; the sidebar's Outputs list fills with images. |
| Thumbnails through an image library (sharp and the like) | A native dependency for a plugin that ships none (package size, install on every host). The `sips` route with full-image fallback (§7) gives the same win on macOS at no cost. |

## 3. Pairing, captions and order

Shared, pure code in `shared/evidence.ts` (runtime-neutral, unit-tested):

- Pattern, on the file name only, case-insensitive: `^(\d+)-(BEFORE|AFTER)-(.+)\.(png|jpe?g|gif|webp)$`. `<screen>` is the rest; its `-` show as spaces in captions (the banner script does the same).
- The pattern is anchored at the start, so the side is always the token right after the number; a later `-AFTER-` inside the screen name is part of the screen.
- A **source** is a real folder: the folder of a folder output, or the parent folder of an image-file output. Images from a folder output and image outputs that sit in that same real folder form one source (so shots attached one by one still pair; §9 Q9). Sources are never merged with each other.
- A **pair** is the BEFORE and AFTER with the same number and the same screen (compared case-insensitively) in the same source. Caption `<n> · <screen>`. A pair may have only one side (a new screen has no BEFORE; a removed one no AFTER); the missing side shows an empty slot labelled *No before shot* / *No after shot*.
- Two files for the same side, number and screen (different extensions, or on a case-sensitive disk different case) keep the first by plain byte order of the name (so `1-BEFORE-x.png` wins over `1-before-x.png`); the rest are single shots.
- The same number with different screens gives separate pairs (`2-BEFORE-a`, `2-AFTER-b` are two one-sided pairs), never a guessed match.
- Any other image is a **single shot** captioned with its file name (extension kept).
- **Order**: by source (the newest output that feeds it first, as the Artifacts list orders outputs), then pairs by number ascending (numeric, so 10 after 9) and screen, then single shots by name. A folder output and an image output inside that folder show the image once (deduplicated by real path).
- Only images Flowly can show count: png, jpg, jpeg, gif, webp. Other files in a folder are ignored by the gallery (still visible through the folder's own preview).

## 4. Notes sidecar (harness-written, Flowly-read)

A file named `evidence.json` (§9 Q4) in the source folder (§3), so an image-file output reads the one in its parent folder. Flowly reads it when it reads the folder, and never writes it. Its realpath must be a regular file inside the card's roots, like the images (a symlink pointing outside is treated as unreadable).

```
{
  "version": 1,
  "pairs": {
    "1": { "screen": "groups-table", "note": "Group names now link to the group page.",
           "marks": { "1": "The new link style", "2": "Count moved to the right" } },
    "3": { "note": "Unchanged apart from the banner." }
  },
  "shots": { "mockup.png": { "note": "Earlier mockup, for reference." } }
}
```

- `pairs` keys are the pair number as a string; `screen` is optional and, when given, must match the pair's screen (case-insensitively), so a note never lands on a different screen with the same number. A key that matches no pair is ignored.
- `note` is the one-line "what changed" (≤ 500 characters; longer is cut with `…`). `marks` maps the red box numbers to what to look at (each ≤ 300).
- `shots` keys are file names of single shots.
- Missing file: no notes, no error. Unreadable, outside the roots, invalid JSON, or over 64 KB: no notes for that source, and its group shows one muted line *Notes file can't be read* (agents get the fixed string `notes file can't be read` on that source, §6). The parser's own message is never returned, since a JSON error quotes the input; it goes only to `logFailure`. Unknown keys are ignored.
- The artifact's own note (the folder output's note) shows as the group's description; it is not a per-shot note.

## 5. UI

### 5.1 Evidence section (card sidebar)

- A new movable sidebar section **Evidence**, placed after Artifacts by default and *Starts open*; it joins the Card sidebar layout settings (DRAWER-SPEC "Section order"). Shown only when the card has at least one evidence image; otherwise absent (no empty state, no `+`: evidence is added by registering outputs).
- Header: *Evidence* and the count of pairs plus single shots. Collapsed summary line: *n pairs* (and *m shots* when any).
- Body: one group per source (§3) when there is more than one, titled with the title of the newest output that feeds it; with a single source no group title.
- Each pair is a row: caption (`1 · groups table`), then two thumbnails side by side, BEFORE left and AFTER right, each with a small side label under it; the pair's note (from the sidecar) as one muted line under the row, truncated. A single shot is a row with one thumbnail and its file name.
- Thumbnails are a fixed height (about 72 px), `resizeMode="contain"`, theme surface behind them; they load only when the section is open and the row is on screen (§7). A missing or unreadable file shows the slot with *Missing*.
- Paging as other long lists: 5 rows, then *Show N more* (DRAWER-SPEC rule 4).
- Press a row: opens the viewer at that pair.
- Archived card or project: shown as usual, as the Artifacts list is (CARD-ARTIFACTS-SPEC §5.2); the section has no write actions.
- The source folder still appears under Artifacts → Outputs; the gallery does not remove it (§9 Q3).

### 5.2 Viewer

- A plugin Modal (full-screen sheet on phones), title the caption.
- Desktop and wide layouts: BEFORE and AFTER side by side at equal width, each image `contain`ed, labelled *Before* / *After*. Compact layouts: stacked, BEFORE first, scroll in the modal body (no nested ScrollView; CARD-ARTIFACTS-SPEC §6.1).
- Under the images: the pair's note, then the marks list (`1  The new link style`, …) when the sidecar has them, then the file names (selectable, muted) so the user can find the files.
- Next / Previous buttons (and Left / Right arrow keys on web) step through the card's evidence in §3 order; the position shows as *3 of 7*. Only the visible pair's images are loaded, plus the next one prefetched.
- No zoom in v1 (§9 Q6). No delete, edit or reorder: the files belong to the harness.
- Motion follows the plugin's modal transitions and Reduce Motion (AGENTS.md).

### 5.3 Board card face

Nothing on the card face (CARD-ARTIFACTS-SPEC §11 decision 3 keeps artifacts off the face).

## 6. Agent read: `flowly_get_task.evidence`

```
evidence: {
  sources: [
    { folder: string,                 // absolute real path of the source folder
      artifactIds: string[],          // the outputs that feed it
      notesError?: string,            // fixed text when its sidecar could not be read (§4)
      items: [
        { kind: "pair", number: 1, screen: "groups-table", caption: "1 · groups table",
          before: { absolutePath, name, missing } | null,
          after:  { absolutePath, name, missing } | null,
          note: string, marks: { [n: string]: string } },
        { kind: "shot", name, absolutePath, missing, note }
      ] }
  ],
  more: boolean             // true when a cap below cut the list
}
```

- Computed on each `flowly_get_task` read (not on the `current` attached to write results), from the same roots and realpath checks as artifacts. A folder is listed in full, filtered to image names, then capped at 200 images; the whole result is capped at 100 items; `more` is true when either cap cut something. Absent when the card has no evidence.
- Not part of `sessionContext` (session start text): a session reads it when it needs it.
- No change to `flowly_get_card` / `flowly_list_cards` for the dispatcher in v1 (§9 Q7).
- The skill gains one line under artifacts: *A card's evidence (before/after pairs from its output images) is in `evidence`; use those paths and notes for evidence elsewhere instead of opening the images in chat.* The last clause also keeps images out of the chat, which is what creates Paseo's hash copies.

### 6.1 How the harness uses it (question 5)

The harness's Linear step today lists the folder itself and writes the "what changed" lines in chat. With this spec:

1. The card session writes `evidence.json` next to the shots as it marks them (one line per pair, one per mark), in addition to what it says in chat.
2. For the Linear comment it calls `flowly_get_task`, walks `evidence.sources[].items` in order and uploads each `before`/`after` `absolutePath` with its own Linear tools (`prepare_file_upload` and `linear-put.sh`), using `caption`, `note` and `marks` for the comment lines.
3. Flowly reads files and returns paths and text. It makes no network call and never writes to Linear (EXTERNAL-TRACKER-SPEC decision; LINEAR-LINK-SPEC §6).

The harness rule change (stack.md "Show finished UI work" and "Evidence on a Linear ticket") is the user's own file, outside this repository: listed as a follow-up for the user, not a Flowly card.

## 7. Performance and safety

- **Reading folders**: one `readdir` plus a `stat` per image when the Evidence section opens or `get_task` runs, in an evidence cache of its own (15 s), keyed by the card's output targets, the extra folders, and each folder's mtime. No polling, no file watcher.
- **Freshness**: the listing returns each file's `mtime` and `size`. The harness rewrites shots in place (banner, marks), which changes neither the listing nor the artifact's `updatedAt`, so the client's image query key is `(artifactId, name, size, mtime, thumb|full)`.
- **Thumbnails**: `artifacts.evidence-image` takes `size: "thumb" | "full"`. A thumb on macOS is made with `sips` (argument array, never a shell, the absolute real path as input so it never starts with `-`; long side about 2× the tile, around 160 px, JPEG) into a per-user temp folder created `0700`, keyed by content hash, size and mtime, written atomically (temp name then rename). On other platforms, on any `sips` failure, or when the result is not smaller, there is no thumb: the tile shows a plain image icon with the side label, and the full image loads only in the viewer (§9 Q10). Adapted from paseo-image-gallery's `readThumbnail` (MIT notice kept in the file header). Failures are logged with `logFailure`.
- **Images**: a new RPC `artifacts.evidence-image({ artifactId, name?, size })` returns one image as a `data:` URI. `name` is required for a folder artifact and must be a plain file name (no `/`, `\`, `..`, NUL) that is listed in that folder with an image extension. The joined path is realpath'ed, checked against the card's roots like `previewFile`, must be a regular file (a folder named `x.png` is refused), and that checked real path is the one opened and passed to `sips`. A symlink in the folder pointing outside is refused. The 8 MB limit applies to the source file, for thumb and full alike; bigger shows *Too large to preview* with the size.
- The client fetches an image only when its tile is visible and the section is open, caches it with React Query under the key above (`gcTime` a few minutes), and never prefetches the whole gallery. On phones every byte crosses the JS-decoded relay (PERFORMANCE-SPEC), so a 10-pair card costs only the pairs the user scrolls to.
- **Listing RPC**: `artifacts.evidence({ taskId })` returns the §6 structure without image bytes, with `{ artifactId, name, size, mtime }` per file in place of absolute paths (what `artifacts.evidence-image` takes).
- No change to `board.json`, the board version or any write path. The only new reads are of folders and files the card already registered.

## 8. Upstream reports (separate, not Flowly work)

Filed by the user, or with their go-ahead, independent of this spec. The main one goes to the gallery plugin, not to Paseo.

**8.1 paseo-image-gallery (`github.com/mordol/paseo-image-gallery`)** — *Hash-named copies from paseo-attachments replace or duplicate the real image*:

- Observed: tiles named `<64 hex>.png` from `…/T/paseo-attachments-XXXXXX/` next to, or instead of, the same image under its real name; no caption; cannot be removed.
- Cause: the scanner treats the daemon's `![Image](file:///…/paseo-attachments-…/<sha256>.png)` assistant message as a normal image; the content dedupe keeps the earliest appearance, which is often the copy; and when the real file is edited afterwards (a banner added in place) the hashes differ, so both stay.
- Asks: (1) when a content hash matches, prefer a path outside `paseo-attachments-*` over the earliest one; (2) an option to hide `paseo-attachments-*` images that have no other path, or show them under a "Viewed by the agent" label; (3) optionally, a per-tile *Hide* kept in plugin data.

**8.2 Paseo (`@getpaseo/server`)**, optional and lower priority — *Keep the source of a materialized provider image*: `renderProviderImageOutputAsAssistantMarkdown` writes alt text `Image`. When the provider's tool call read a file (Read of a PNG), putting the source file name in the alt text or a structured field would let any viewer caption and dedupe the copy. Also worth asking whether the shared `paseo-attachments-*` temp folders are ever cleaned up (several from past daemon runs remain on this machine).

Nothing here blocks Flowly's cards.

## 9. Open decisions (the user's)

Each has a recommendation; nothing below is built until ruled.

1. **What counts as evidence?** (a) every image reachable from output artifacts (recommended: zero new steps for agents; the harness already attaches the folder as an output), or (b) only outputs an agent or person marks as evidence (a field and a tool, §2.1).
2. **Folder depth.** (a) images directly in the folder only (recommended: matches today's layout, cheap, predictable), or (b) recursive, which pulls in old `before/`, `annotated/` and `copy-pass/` subfolders.
3. **Show the folder twice?** Should a folder that feeds the Evidence section still be listed under Artifacts → Outputs? (a) yes, unchanged (recommended: the folder may hold non-image files, and removing it from the list hides how to remove the source), or (b) no, like the plan is not listed again.
4. **Notes sidecar name and shape.** (a) `evidence.json` as in §4 (recommended), (b) a markdown file the harness already likes to write (`screens.md`) with a fixed line format, or (c) no notes in v1 (gallery with captions only, notes later).
5. **Section placement.** (a) its own movable sidebar section after Artifacts (recommended), or (b) a strip at the top of the Artifacts section.
6. **Zoom in the viewer.** (a) none in v1 (recommended: a shot fits a modal; the files stay openable outside), or (b) pinch/scroll zoom in v1.
7. **Dispatcher read.** Should `flowly_get_card` also return `evidence` so the dispatcher can post evidence? (a) not in v1 (recommended: the harness posts from the card session), or (b) yes.
8. **Onboarding.** (a) a one-time tip `evidence` on the first open of a card with evidence, *Before and after shots from this card's outputs, paired by file name.*, and a line in the tour's More features list (recommended), or (b) the tour line only.
9. **Pair shots attached one by one?** (a) yes: image outputs in the same real folder pair with each other and with that folder's output (recommended, §3: otherwise two separately attached halves show as two one-sided pairs), or (b) only within one folder output.
10. **Tiles without a thumbnail** (not macOS, or `sips` failed). (a) an image icon with the side label; the full image only in the viewer (recommended: phones never download up to 8 MB per tile), or (b) the full image in the tile.
11. **Older layouts** (`before/` and `after/` subfolders, free names). (a) not paired; images directly in a registered folder show as single shots, subfolders not at all (recommended: the harness's current naming is the contract), or (b) also pair `before/<name>` with `after/<name>` when an output folder holds both subfolders.
12. **What's new.** (a) an entry in the release that ships C2 if it is a minor release (recommended; AGENTS.md requires one for features existing users won't find themselves, and a new sidebar section that only appears on cards with image outputs qualifies), or (b) none, ship it in a patch release.
13. **Skill line.** §6 adds a skill line telling agents to use `evidence` paths and not open shots in chat. (a) keep it (recommended: it is what stops new hash copies), or (b) only the first half; leave chat behaviour to the user's own harness.

## 10. Proposed cards

Each card is one branch and one deliverable. Relations are for the dispatcher (`blocks` = must land first; `follow_up` = can start after, depends on its ideas but not its code).

| # | Card | Delivers | Relations |
| --- | --- | --- | --- |
| C1 | Evidence model: pairing, sidecar notes and `get_task.evidence` | `shared/evidence.ts` (pattern, pairing, order, captions, sidecar parse), folder reading with root checks, `artifacts.evidence` listing RPC, `flowly_get_task.evidence`, the skill line; unit tests. Agents can read pairs before any UI exists. | blocks C2, C3 |
| C2 | Evidence section in the card sidebar | `artifacts.evidence-image` RPC with the name and realpath guard and the `sips` thumbnail (adapted, MIT notice); the Evidence section (thumbnails, paging, missing state); section order settings; i18n; onboarding tip and tour line per §9 Q8; client tests for the section rules. | blocked by C1; blocks C3 |
| C3 | Evidence viewer | The modal: side by side / stacked, notes and marks, next/previous, arrow keys (navigation adapted from paseo-image-gallery's viewer, MIT notice), prefetch of one; desktop and compact verification with screenshots (shot-lib). | blocked by C2 |
| C4 | Harness: write `evidence.json` and read `get_task.evidence` for Linear | Not a Flowly repo card: the user's `stack.md` and scripts (`annotate-shots.py` could write the sidecar marks). Listed so it is not forgotten. | follow_up of C1 |
| C5 | Upstream reports | §8.1 on paseo-image-gallery's tracker (main), §8.2 on Paseo's (optional). Not a Flowly repo change; outward-facing, so only with the user's go-ahead. | independent |

C1 to C3 could be one card (one PR) if the user prefers; the split keeps each under the ~400-line review threshold and lets the harness use C1 before the UI lands.

## 11. Tests and docs (for the build cards)

- **Unit** (`shared/evidence.test.ts`): pattern matching and case rules; pairs with one side; same number, different screen; duplicate side across extensions; numeric order (2 before 10); non-images ignored; single shots; dedupe of a folder and an image inside it; sidecar parsing (valid, missing, invalid JSON, over size, wrong screen, unknown keys, long notes cut).
- **Server** (`server/artifacts.test.ts` or `server/evidence.test.ts`): only output artifacts count; input, plan, review ledger and external artifacts never do; folder read is one level and capped at 200; a symlink in the folder pointing outside the roots is refused; `name` with `/`, `..` or not in the folder is refused; a folder named `x.png` is refused; a sidecar symlinked outside the roots gives no notes and the fixed `notesError` (never parser text); images past entry 200 of a folder that has non-images first are still listed; image outputs in one folder pair (§9 Q9); files over 8 MB; extra artifact folders honoured; Missing files; `get_task.evidence` shape, the 100 cap and `more`; absent when no evidence.
- **Client**: section visibility (none without evidence), order and paging, missing slot, viewer next/previous bounds; i18n catalogs complete (`npm test` checks).
- **Verification** (C2/C3): desktop and compact screenshots via `docs/promo/shot-lib.mjs` on the Tinylink fixture with a fixture shots folder inside an extra artifact folder; evidence in `docs/verification/`.
- **Docs**: CARD-ARTIFACTS-SPEC gains a dated addition pointing here; DRAWER-SPEC "Section order" rules 1 and 2 (the section list, "six movable sections", the default order and *Starts open* defaults) and `shared/drawer-sections.ts` gain Evidence; What's new entry if the release is minor (§9 Q11); ONBOARDING-SPEC tip table; SPEC-OUTLINE entry; README highlight; `docs/PROGRESS.md` entries per card. Telemetry: no heartbeat field (a read-only view; TELEMETRY-SPEC §4) unless the user asks.
