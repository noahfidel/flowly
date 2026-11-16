import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { BoardStore } from "./store";
import {
  PrReviewArchiver,
  approvalOf,
  firstKnownReview,
  ghPrReviews,
  type PrState,
  type PrTarget,
  type ReviewFacts,
} from "./pr-review-archive";
import type { Status, Task } from "../shared/model";

// A PR review card moves to Done once the user approves the PR (LANDED-DONE-SPEC §9). Made-up repositories and PRs only.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const stamp = "2026-11-16T09:00:00.000Z";
type CardSpec = { id: string; prRef?: string; status?: Status; review?: boolean; workspaceId?: string };
type Review = ReviewFacts["reviews"][number];
const rv = (state: string, at: string, login = "me"): Review => ({ login, state, submittedAt: `2026-11-16T${at}:00Z` });
const facts = (reviews: Review[], author = "them", viewer = "me"): ReviewFacts => ({ viewer, author, reviews });

async function fixture(
  cards: CardSpec[],
  options: { states?: Record<string, PrState | null>; facts?: Record<string, ReviewFacts | null | "throw">; during?: (store: BoardStore) => Promise<void> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "flowly-approval-"));
  roots.push(root);
  const store = new BoardStore(join(root, "data"), { storage: { checkVersion: false } });
  await store.mutate((board) => {
    board.projects.push({ id: "p", paseoProjectId: "native-p", title: "p", description: "", primaryPath: root, repos: [root], revision: 1, createdAt: stamp, updatedAt: stamp, archivedAt: null } as never);
    cards.forEach((c, i) =>
      board.tasks.push({
        id: c.id,
        projectId: "p",
        workspaceId: c.workspaceId ?? `w-${c.id}`,
        sourcePath: root,
        repoPaths: [],
        title: `Review ${c.id}`,
        description: "",
        status: c.status ?? "in_review",
        priority: "normal",
        position: i,
        revision: 1,
        operationId: c.review === false ? `op-${c.id}` : `pr-review:agent-${c.id}`,
        ownsWorkspace: false,
        createdAt: stamp,
        updatedAt: stamp,
        archivedAt: null,
        ...(c.prRef ? { prRef: c.prRef } : {}),
      } as Task),
    );
  });
  const running = new Set<string>();
  const paseo = {
    agents: {
      list: async () => ({
        entries: [...running].map((workspaceId, i) => ({ agent: { id: `a${i}`, workspaceId, status: "running", archivedAt: null } })),
        pageInfo: { nextCursor: null },
      }),
    },
  } as unknown as PaseoApi;
  const stateLooked: string[] = [];
  const reviewLooked: string[] = [];
  const archiver = new PrReviewArchiver(store, async (pr: PrTarget) => {
    stateLooked.push(pr.key);
    return options.states?.[pr.key] ?? "open";
  }, () => Date.now(), () => undefined);
  archiver.reviews = async (pr: PrTarget) => {
    reviewLooked.push(pr.key);
    await options.during?.(store);
    const f = options.facts?.[pr.key];
    if (f === "throw") throw new Error("offline");
    return f ?? null;
  };
  const switches = { review: true, done: true };
  archiver.enabled = async () => switches.review;
  archiver.doneOnLand = async () => switches.done;
  archiver.paseo = () => paseo;
  const afterDone: { taskId: string; previous: Status }[] = [];
  archiver.afterDone = (taskId, previous) => afterDone.push({ taskId, previous });
  const card = async (id: string) => (await store.read()).tasks.find((t) => t.id === id)!;
  const events = async (id: string) => (await store.read()).events.filter((e) => e.taskId === id);
  return { store, archiver, running, stateLooked, reviewLooked, switches, afterDone, card, events };
}

const pr = "acme/web#7";
const approved = { [pr]: facts([rv("APPROVED", "10:00")]) };

test("approved open PR: the card moves to Done with the note, once, not archived", async () => {
  const f = await fixture([{ id: "c", prRef: pr }], { facts: approved });
  expect(await f.archiver.tick()).toEqual([{ taskId: "c", done: "approved", pr }]);
  const c = await f.card("c");
  expect(c.status).toBe("done");
  expect(c.archivedAt).toBeNull();
  expect(c.revision).toBe(2);
  const e = (await f.events("c")).filter((x) => x.action === "status_changed");
  expect(e).toHaveLength(1);
  expect(e[0]).toMatchObject({ actor: "system", from: "in_review", to: "done", note: `Moved to Done: PR approved (${pr})` });
  expect(f.afterDone).toEqual([{ taskId: "c", previous: "in_review" }]);
});

const stays: [string, ReviewFacts | null | "throw"][] = [
  ["latest decisive is CHANGES_REQUESTED", facts([rv("APPROVED", "09:00"), rv("CHANGES_REQUESTED", "10:00")])],
  ["latest is DISMISSED", facts([rv("APPROVED", "09:00"), rv("DISMISSED", "10:00")])],
  ["only comments", facts([rv("COMMENTED", "10:00")])],
  ["user is the author", facts([rv("APPROVED", "10:00")], "ME")],
  ["lookup returns null", null],
  ["lookup throws", "throw"],
];
for (const [name, value] of stays)
  test(`stays in In review when ${name}`, async () => {
    const f = await fixture([{ id: "c", prRef: pr }], { facts: { [pr]: value } });
    expect(await f.archiver.tick()).toEqual([]);
    expect((await f.card("c")).status).toBe("in_review");
    expect(f.afterDone).toEqual([]);
  });

test("approval followed by a comment still moves", async () => {
  const f = await fixture([{ id: "c", prRef: pr }], { facts: { [pr]: facts([rv("APPROVED", "09:00"), rv("COMMENTED", "10:00")]) } });
  expect(await f.archiver.tick()).toHaveLength(1);
});

test("a running session or another lane leaves the card alone", async () => {
  const f = await fixture(
    [
      { id: "busy", prRef: pr, workspaceId: "wb" },
      { id: "lane", prRef: "acme/web#8", status: "development" },
    ],
    { facts: { ...approved, "acme/web#8": facts([rv("APPROVED", "10:00")]) } },
  );
  f.running.add("wb");
  expect(await f.archiver.tick()).toEqual([]);
  expect(f.reviewLooked).toEqual([]);
  expect((await f.card("busy")).status).toBe("in_review");
  expect((await f.card("lane")).status).toBe("development");
});

test("a running session that starts after the check read leaves the card alone", async () => {
  const f = await fixture([{ id: "c", prRef: pr, workspaceId: "wc" }], { facts: approved, during: async () => void 0 });
  f.archiver.reviews = async () => {
    f.running.add("wc");
    return facts([rv("APPROVED", "10:00")]);
  };
  expect(await f.archiver.tick()).toEqual([]);
  expect((await f.card("c")).status).toBe("in_review");
});

for (const state of ["merged", "closed"] as const)
  test(`a ${state} PR archives the card, never moves it to Done, and reads no reviews`, async () => {
    const f = await fixture([{ id: "c", prRef: pr }], { states: { [pr]: state }, facts: approved });
    expect(await f.archiver.tick()).toEqual([{ taskId: "c", state }]);
    const c = await f.card("c");
    expect(c.status).toBe("in_review");
    expect(c.archivedAt).not.toBeNull();
    expect(f.reviewLooked).toEqual([]);
  });

test("doneOnLand off: no Done, archive still works", async () => {
  const f = await fixture(
    [
      { id: "a", prRef: pr },
      { id: "m", prRef: "acme/web#9" },
    ],
    { states: { "acme/web#9": "merged" }, facts: approved },
  );
  f.switches.done = false;
  expect(await f.archiver.tick()).toEqual([{ taskId: "m", state: "merged" }]);
  expect((await f.card("a")).status).toBe("in_review");
  expect(f.reviewLooked).toEqual([]);
});

test("only doneOnLand on: approval is checked and a merged PR is not archived", async () => {
  const f = await fixture(
    [
      { id: "a", prRef: pr },
      { id: "m", prRef: "acme/web#9" },
    ],
    { states: { "acme/web#9": "merged" }, facts: approved },
  );
  f.switches.review = false;
  expect(await f.archiver.tick()).toEqual([{ taskId: "a", done: "approved", pr }]);
  const m = await f.card("m");
  expect(m.archivedAt).toBeNull();
  expect(m.status).toBe("in_review");
});

test("a card changed between the check read and the write stays", async () => {
  const f = await fixture([{ id: "c", prRef: pr }], {
    facts: approved,
    during: (store) =>
      store.mutate((board) => {
        const t = board.tasks.find((x) => x.id === "c")!;
        t.revision++;
      }) as Promise<void>,
  });
  expect(await f.archiver.tick()).toEqual([]);
  expect((await f.card("c")).status).toBe("in_review");
  expect(f.afterDone).toEqual([]);
});

test("review cards and ordinary cards share the 20-lookup cap", async () => {
  const cards = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, prRef: `acme/web#${100 + i}` }));
  const f = await fixture(cards, {});
  await f.archiver.tick();
  expect(f.stateLooked).toHaveLength(20);
});

test("approvalOf", () => {
  expect(approvalOf(facts([rv("APPROVED", "10:00", "ME")]))).toBe("approved");
  expect(approvalOf(facts([rv("APPROVED", "10:00")], "Me"))).toBe("own");
  expect(approvalOf(facts([rv("APPROVED", "10:00", "other")]))).toBe("not");
  expect(approvalOf(facts([]))).toBe("not");
  expect(approvalOf(facts([rv("APPROVED", "10:00"), rv("CHANGES_REQUESTED", "10:00")]))).toBe("not");
  expect(approvalOf(facts([rv("CHANGES_REQUESTED", "10:00"), rv("APPROVED", "10:00")]))).toBe("approved");
  expect(approvalOf(facts([rv("APPROVED", "11:00"), rv("PENDING", "12:00")]))).toBe("approved");
});

test("firstKnownReview: first non-null wins, errors count as unknown", async () => {
  const a = facts([]);
  expect(await firstKnownReview(async () => { throw new Error("x"); }, async () => a, async () => null)({ key: pr, repo: "acme/web", number: 7 })).toBe(a);
  expect(await firstKnownReview(async () => null)({ key: pr, repo: "acme/web", number: 7 })).toBeNull();
});

test("ghPrReviews: reads the login once per host and maps gh's JSON", async () => {
  const calls: string[][] = [];
  const out = JSON.stringify({ author: { login: "them" }, reviews: [{ author: { login: "me" }, state: "APPROVED", submittedAt: "2026-11-16T10:00:00Z" }] });
  const lookup = ghPrReviews(async (file, args) => {
    calls.push([file, ...args]);
    return args[0] === "api" ? "me\n" : out;
  });
  const target = { key: pr, repo: "acme/web", number: 7 };
  expect(await lookup(target)).toEqual({ viewer: "me", author: "them", reviews: [{ login: "me", state: "APPROVED", submittedAt: "2026-11-16T10:00:00Z" }] });
  await lookup({ ...target, number: 8 });
  expect(calls.filter((c) => c[1] === "api")).toEqual([["gh", "api", "user", "--jq", ".login"]]);
  expect(calls[1]).toEqual(["gh", "pr", "view", "7", "--repo", "acme/web", "--json", "author,reviews"]);
  await lookup({ ...target, host: "ghe.example.invalid" });
  expect(calls.find((c) => c.includes("--hostname"))).toEqual(["gh", "api", "user", "--jq", ".login", "--hostname", "ghe.example.invalid"]);
  expect(calls[calls.length - 1]).toContain("ghe.example.invalid/acme/web");
});

test("ghPrReviews: an empty login or missing author is unknown and the empty login is not cached", async () => {
  let login = "\n";
  let n = 0;
  const lookup = ghPrReviews(async (_f, args) => {
    if (args[0] === "api") {
      n++;
      return login;
    }
    return JSON.stringify({ author: {}, reviews: [] });
  });
  const target = { key: pr, repo: "acme/web", number: 7 };
  expect(await lookup(target)).toBeNull();
  login = "me\n";
  expect(await lookup(target)).toBeNull(); // author missing
  expect(n).toBe(2);
});
