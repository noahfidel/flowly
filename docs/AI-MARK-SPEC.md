# AI mark (AI-MARK-SPEC) — 2026-10-19

The card asked: "add a star mark to all AI features". Existing AI features (progress summary, daily summary, Ideas, artifacts and tags added by agents, etc.) use a star icon, like the next-step suggestion, to show "this was written or suggested by AI".

## 1. The mark

- Shared component `AiMark` (`client/ui.tsx`): the `Sparkles` icon, theme `accent` color, 13 px by default, the same icon as at the start of the next-step suggestion row.
- With a `label` it is an accessible image named "AI generated". Inline, or where the source is already stated in a button's accessible name, it is decorative (not read aloud separately).
- `SectionHeader` gets a new `ai` prop: it shows the labeled mark after the title.
- `Sparkles` is used only for AI content. The card type `feature`, which used `Sparkles`, now uses `Puzzle` (TASK-TYPE-SPEC), so a feature card is not misread as AI content. The icon of the "AI features" group in settings was already `Sparkles` and stays.

## 2. Where the mark goes

| Place | AI content | Mark |
| --- | --- | --- |
| Next-step suggestion above the session input | The next message the agent suggests | Icon at the start of the row (already there, NEXT-MOVES-SPEC) |
| Progress line in the card body | The state written by the summary model | The icon at the start of the row replaces the old `Flag` (12 px) |
| Sidebar "Progress" group | The summary's state / target / recap / next | Group title |
| Sidebar "Ideas" group | Ideas proposed by an agent | Group title |
| Ideas page title bar | Ideas of the whole project | After the "Ideas" title |
| Insights "Summary" (daily summary) | The day's summary written by the summary model | Group title |
| Artifact row | Artifacts added by an agent | The source icon changes from `Bot` to the mark; user-added ones stay `User` |
| Tag capsule | Tags set by an agent | Changes from `Bot` to the mark |

Not marked: Insights "Suggestions" (computed by rules, not model-generated), the idea count on a card (the `Lightbulb` count, its meaning is already clear), and the card type set by an agent (it cannot be told apart from a type set by the user, and it is only a fixed value).

## 3. New-user onboarding

Welcome page 3 (What makes it different) gets one sentence under its title: "Anything marked with the sparkle was written or suggested by AI." No one-time tip is added: the mark needs no action, and the labeled mark has an accessible name.

## 4. Unchanged

No data, RPC, tool or skill changes; no migration. Two new strings, added to all 9 language packs.
