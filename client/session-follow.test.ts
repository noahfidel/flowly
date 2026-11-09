import { expect, test } from "vitest";
import { createFocusJump, createTailFollower, FOLLOW_SLACK } from "./session-follow";

const at = (y: number, height = 2000, viewport = 600) => ({
  contentOffset: { x: 0, y },
  contentSize: { width: 300, height },
  layoutMeasurement: { width: 300, height: viewport },
});

test("normal list: scrolling up stops following, returning to the end resumes", () => {
  const follower = createTailFollower();
  expect(follower.scroll(at(1400))).toBe(true);
  follower.beginDrag();
  expect(follower.scroll(at(900))).toBe(false);
  follower.endDrag();
  // Content growing below the reader does not resume following.
  expect(follower.scroll(at(900, 2400))).toBe(false);
  expect(follower.scroll(at(2400 - 600 - FOLLOW_SLACK, 2400))).toBe(true);
});

test("inverted list: following is being near offset 0 (the newest output)", () => {
  const follower = createTailFollower(true);
  expect(follower.scroll(at(0))).toBe(true);
  follower.beginDrag();
  expect(follower.scroll(at(FOLLOW_SLACK + 1))).toBe(false);
  // The list keeping the reading position as output arrives moves the offset; still not following.
  expect(follower.scroll(at(400, 2600))).toBe(false);
  follower.endDrag();
  expect(follower.scroll(at(10))).toBe(true);
  follower.resume();
  expect(follower.following).toBe(true);
});

test("a jump away from the newest output stops following until the reader comes back (DISPATCHER-SPEC §9.3)", () => {
  const follower = createTailFollower();
  expect(follower.scroll(at(1400))).toBe(true);
  follower.pause();
  expect(follower.following).toBe(false);
  // Output growing below the row jumped to does not pull the list back to the end.
  expect(follower.scroll(at(1400, 2400))).toBe(false);
  expect(follower.scroll(at(2400 - 600, 2400))).toBe(true);
});

test("the bell's jump to a row happens once per request, retried only until the row is reachable (DISPATCHER-SPEC §9.3)", () => {
  const jump = createFocusJump();
  expect(jump.pending(undefined)).toBe(false);
  expect(jump.pending(1)).toBe(true);
  // Not laid out yet: still owed.
  expect(jump.pending(1)).toBe(true);
  jump.done(1);
  // Streamed output and new rows after the jump do not jump again.
  expect(jump.pending(1)).toBe(false);
  // Another press of the bell does.
  expect(jump.pending(2)).toBe(true);
});
