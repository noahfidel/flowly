// Fixture for the "suggested next steps" screenshot: one tiny repo, one temporary project (NM_PROJECT, never the
// permanent Tinylink), one card and one Haiku session that ends its turn with kanban_suggest_next_moves.
// Usage: node next-moves.mjs setup|remove   (screenshots: node shots.mjs next-moves). ids go to ids-next-moves.json.
// remove only touches projects whose directory is a tinylink-nm-* temp dir, so it is safe while Tinylink exists.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';

const NM_PROJECT = 'Tinylink NM'; // shots.mjs opens this project for the next-moves shot
const idsFile = new URL('./ids-next-moves.json', import.meta.url);
const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `promo-${randomUUID()}`, clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 10000, reconnect: { enabled: false } });
const api = createPaseoApi(client);
const rpc = (m, i) => client.invokePluginRpc('flowly', m, i);
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
try {
  await client.connect();
  if (process.argv[2] === 'remove') {
    // Removes every project whose directory is a tinylink-nm-* temp dir (this fixture's), plus the dirs.
    const overview = await rpc('board.overview-changed', {});
    for (const pr of overview.value.projects.filter((x) => /tinylink-nm-/.test(x.primaryPath ?? ''))) {
      console.log(pr.id, pr.primaryPath, JSON.stringify(await rpc('projects.remove', { id: pr.id, revision: pr.revision, alsoPaseo: true })));
      await rm(pr.primaryPath, { recursive: true, force: true });
    }
  } else {
    const d = await mkdtemp(join(tmpdir(), 'tinylink-nm-'));
    await writeFile(join(d, 'package.json'), '{"name":"tinylink","version":"0.3.0","type":"module","scripts":{"test":"node --test"}}\n');
    await mkdir(join(d, 'src')); await mkdir(join(d, 'test'));
    await writeFile(join(d, 'src/limiter.js'), "const hits = new Map();\n\n// Fixed one-minute window per client IP. Returns { allowed, retryAfter }.\nexport function check(ip, limit = 5, now = Date.now()) {\n  const w = hits.get(ip);\n  if (!w || now - w.start >= 60000) { hits.set(ip, { start: now, count: 1 }); return { allowed: true, retryAfter: 0 }; }\n  w.count += 1;\n  return w.count <= limit ? { allowed: true, retryAfter: 0 } : { allowed: false, retryAfter: Math.ceil((60000 - (now - w.start)) / 1000) };\n}\n");
    await writeFile(join(d, 'test/limiter.test.js'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { check } from '../src/limiter.js';\n\ntest('the sixth request in a minute is rejected with Retry-After', () => {\n  for (let i = 0; i < 5; i++) assert.equal(check('1.1.1.1', 5, 1000).allowed, true);\n  const r = check('1.1.1.1', 5, 1000);\n  assert.equal(r.allowed, false);\n  assert.equal(r.retryAfter, 60);\n});\n");
    git(['init', '-q', '-b', 'main'], d); git(['config', 'user.name', 'Alex Chen'], d); git(['config', 'user.email', 'alex@tinylink.example'], d);
    git(['add', '.'], d); git(['commit', '-q', '-m', 'Add per-IP rate limiter with tests'], d);
    const project = await rpc('projects.create', { title: NM_PROJECT, description: 'Temporary fixture for the next-moves screenshot.', primaryPath: d });
    const fx = { directory: d, project: project.id };
    await writeFile(idsFile, JSON.stringify(fx, null, 2));
    const card = await rpc('tasks.create', { projectId: project.id, operationId: `promo-${randomUUID()}`, title: 'Add rate limiting to POST /shorten', description: 'Limit each client IP to 5 shorten requests per minute; respond 429 with Retry-After.', status: 'todo', priority: 'high', type: 'feature', mode: 'directory' });
    fx.card = card.id; await writeFile(idsFile, JSON.stringify(fx, null, 2));
    const prep = await rpc('tools.prepare-session', { id: card.id, operationId: `promo-session-${randomUUID()}` });
    const prompt = 'You are working on the Tinylink repo in your working directory. Task from the card: add rate limiting to POST /shorten. The limiter is already in src/limiter.js with a test; do NOT edit files. First set your stage to test with the Kanban tools, run `npm test` and report one progress note with the result. Then, as your last action, call kanban_suggest_next_moves exactly once with exactly three moves, recommended first: (1) label "Verify with Luna", prompt "Verify the rate limiter end to end with a Luna test session and report any failures."; (2) label "Commit and push", prompt "Commit the rate limiting change with a clear message and push the branch."; (3) label "Add 429 tests", prompt "Add tests for the 429 response and the Retry-After header." Then reply in one short sentence.';
    const s = await api.workspaces.ref(card.workspaceId).agents.create({
      agentId: prep.agentId, idempotencyKey: `promo:${prep.agentId}`, title: 'Haiku · Add rate limiting',
      labels: { 'ultra-kanban-task': card.id, 'ultra-kanban-project': project.id },
      config: { provider: 'claude/claude-haiku-5-5', modeId: 'bypassPermissions', systemPrompt: prep.instructions },
      env: { ULTRA_KANBAN_CONTEXT_FILE: prep.contextFile, ULTRA_KANBAN_CLI: prep.cliPath, ULTRA_KANBAN_SKILL: prep.skillPath },
      prompt
    });
    fx.session = s.id; await writeFile(idsFile, JSON.stringify(fx, null, 2));
    console.log(JSON.stringify(fx));
  }
} finally { await api.dispose().catch(() => {}); await client.close().catch(() => {}); }
