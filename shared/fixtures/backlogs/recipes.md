# whisk recipes backlog

Notes for later: nothing here is urgent unless it says so.

- [ ] Scale ingredient quantities when servings change (added 2026-04-02, scaling)
  - Fractions such as 1/3 and 3/4 should stay fractions, not turn into decimals.
  - Decide what to do with "a pinch" and "to taste".
  - The stepper lives in the header: 1 to 24, defaulting to the recipe's own count.
- [ ] Unit conversion rounds 1/3 cup wrong: `to_ml(1/3, "cup")` gives 78 instead of 79 (banker's rounding) (added 2026-04-03)
  - Round half up, and add a test with 1/4, 1/3 and 2/3.
- [ ] URGENT: saving a recipe with an empty title wipes the whole draft (added 2026-04-05, reported by user)
- [x] Print view cuts off the last step on A4 paper (added 2026-03-28, print-fix)
- [ ] Photo upload: the progress ring never reaches 100% for files over 8 MB, so people tap Save twice (started 2026-04-06; added 2026-04-04, upload-ring)
  - Likely the `onProgress` callback fires before the resize finishes.
- [ ] Tags with a trailing space create a second, identical-looking tag (pre-existing, added 2026-04-01, tag review)
- [ ] Dark mode: step numbers are unreadable on the amber card (added 2026-04-04; built 2026-04-07 then reverted, dark-mode branch)
- [ ] Offline mode: show which saved recipes have their photos cached (added 04/08/26, offline)
- [ ] Share sheet: remember the last app the user picked (added 2026-04-02, rescoped 04/09/26)
- [ ] SECURITY: the public profile page lists the names of private collections (added 2026-04-06, profiles)
  - Hide them unless the viewer is the owner.
  - Check the JSON feed as well as the HTML page.
- [ ] Importer follow-ups (added 2026-04-05, importer): (a) duplicate titles merge silently; (b) HTML in notes is kept; (c) the `servings` field accepts 0.
- [ ] Pantry page minors (added 2026-04-05, pantry): expiry colors, empty text, and the sort label (a) soonest (b) alphabetical

- [ ] Write a short guide for contributors who add a new unit (see `units.py`) (added 2026-04-08, units)
  - Mention that `units.py` keeps ratios, not formulas.
- [ ] Let people reorder the steps of a recipe by dragging, keep the numbering in sync, announce the move to screen readers, and undo it with one tap (added 2026-04-09, reorder)
  - Keep the existing step ids: other pages link to them.
- [ ] Make the empty state friendlier
