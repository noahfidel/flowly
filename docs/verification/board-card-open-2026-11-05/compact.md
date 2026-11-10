# Compact-width testID evidence (2026-11-05)

One-off Playwright probe (700×900, en-US, real daemon, plugin build a27e544+dirty docs):
enter the Flowly screen, then click `[data-testid="lane-chooser"]` and dump the open modal.

- `[data-testid="lane-chooser"]` present (1) and opens the status chooser.
- Status chooser rows, in order, each with its accessible name:
  `lane-tab-backlog(Backlog) | lane-tab-todo(Todo) | lane-tab-design(Design) | lane-tab-development(Development) | lane-tab-test(Test) | lane-tab-in_review(In review) | lane-tab-blocked(Blocked) | lane-tab-done(Done) | lane-tab-cancelled(Cancelled)`
- Compact lane list renders `card-{taskId}` buttons (sample: card-9fc35bf7-…, card-d7c6b495-…).
- `lane-page-{status}` is touch-only (`client/lane-pager.tsx` mounts only on iOS/Android);
  web never renders it, so it is verified in code and typecheck only until a phone run.
