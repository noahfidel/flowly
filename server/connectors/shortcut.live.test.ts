import { afterEach, describe, expect, test } from "vitest";
import { fixtures } from "./fake";

/**
 * Live check against a real Shortcut workspace (CONNECTORS-SPEC §14 acceptance).
 * Skipped unless SHORTCUT_API_TOKEN is set, so CI and the normal suite never call out:
 *
 *   SHORTCUT_API_TOKEN=… SHORTCUT_WORKSPACE=… SHORTCUT_STORY=… SHORTCUT_EPIC=… \
 *     npx vitest run server/connectors/shortcut.live.test.ts
 *
 * All four are required; the story must belong to the epic.
 */

const token = process.env.SHORTCUT_API_TOKEN || "";
const slug = process.env.SHORTCUT_WORKSPACE || "";
const storyId = process.env.SHORTCUT_STORY || "";
// The story must belong to this epic: one case checks that the hop resolves.
const epicId = process.env.SHORTCUT_EPIC || "";
const base = `https://app.shortcut.com/${slug}`;

const env = fixtures();
afterEach(() => env.cleanup());

describe.skipIf(!token || !slug || !storyId || !epicId)("Shortcut live workspace", () => {
  const connect = async () => {
    const service = await env.service(fetch);
    const connection = await service.save({ provider: "shortcut", baseUrl: base, secret: token });
    return { service, connection };
  };

  test("the token verifies and names the account", async () => {
    const { connection } = await connect();
    expect(connection.account).toMatch(/\(@.+\)$/);
    expect(connection.authFailed).toBe(false);
    console.log(`account: ${connection.account}`);
  });

  test("my open stories come back", async () => {
    const { service, connection } = await connect();
    const recent = await service.search({ connectionId: connection.id, query: "" });
    console.log(`recent: ${recent.results.map((r) => `${r.key} ${r.summary} [${r.status}]`).join("\n        ") || "(none)"}`);
    for (const row of recent.results) expect(row.key).toMatch(/^sc-\d+$/);
  });

  test("a story reads with its metadata and comments", async () => {
    const { service, connection } = await connect();
    const ref = { connectionId: connection.id, provider: "shortcut" as const, itemType: "story" as const, key: `sc-${storyId}`, remoteId: storyId };
    const detail = await service.detail(ref);
    console.log(`\n--- story sc-${storyId} ---\n${detail.markdown.slice(0, 1200)}\n`);
    expect(detail.markdown).toContain(`# sc-${storyId} `);
    expect(detail.markdown).toContain("## Description");
    expect(detail.fingerprint).toBeTruthy();
  });

  test("an epic reads and lists its stories", async () => {
    const { service, connection } = await connect();
    const ref = { connectionId: connection.id, provider: "shortcut" as const, itemType: "epic" as const, key: `epic-${epicId}`, remoteId: epicId };
    const detail = await service.detail(ref);
    const stories = detail.markdown.match(/^## Stories \((\d+)\)$/m);
    console.log(`\n--- epic epic-${epicId} ---\n${detail.markdown.slice(0, 900)}\n…\nstory list: ${stories?.[1] ?? "none"}`);
    expect(detail.markdown).toContain(`# epic-${epicId} `);
    expect(Number(stories?.[1] || 0)).toBeGreaterThan(0);
  });


  test("a pasted link resolves to the same item", async () => {
    const { service } = await connect();
    const found = await service.recognize(`${base}/story/${storyId}`);
    expect(found).not.toBeNull();
    console.log(`link → ${found!.title}`);
    expect(found!.external?.key).toBe(`sc-${storyId}`);
  });
});
