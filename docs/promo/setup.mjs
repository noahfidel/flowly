// Persistent test fixture (kept on purpose, not removed after use; directory: $TINYLINK_DIR or ~/Developer/personal/flowly-test/tinylink).
// Promo fixture: a realistic "Tinylink" repo + Ultra Kanban project + cards + Haiku sessions.
// --no-sessions: the repo, the project and the cards only (no Haiku sessions, so no asks reach the dispatcher chat or the bell).
// Importing this file runs nothing; only `node docs/promo/setup.mjs` does.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';

export const setupUsage = [
  'Usage: node docs/promo/setup.mjs [--no-sessions]',
  '',
  'Builds the Tinylink repo ($TINYLINK_DIR or ~/Developer/personal/flowly-test/tinylink), its Flowly project and 6 cards,',
  'and starts 3 Haiku sessions on them. Writes the ids to docs/promo/ids.json.',
  '',
  '  --no-sessions   Repo, project and cards only; no Haiku sessions (use this for the single-pane live checks).',
  '  --help          This text.',
].join('\n');

/** The options: `sessions` false with --no-sessions; any other option is refused. */
export function setupArgs(argv) {
  const out = { sessions: true, help: false };
  for (const arg of argv) {
    if (arg === '--no-sessions') out.sessions = false;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return out;
}

async function main(opts) {
const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `promo-${randomUUID()}`, clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 10000, reconnect: { enabled: false } });
const api = createPaseoApi(client);
const rpc = (m, i) => client.invokePluginRpc('flowly', m, i);
const fx = { startedAt: new Date().toISOString(), directory: null, project: null, cards: [], sessions: [] };
const save = () => writeFile(new URL('./ids.json', import.meta.url), JSON.stringify(fx, null, 2), { mode: 0o600 });
const day = (n) => new Date(Date.now() - n * 864e5).toISOString();
const git = (args, cwd, date) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } }).trim();

const files = {
  'package.json': JSON.stringify({ name: 'tinylink', version: '0.3.0', type: 'module', scripts: { start: 'node src/server.js', test: 'node --test' } }, null, 2) + '\n',
  'README.md': '# Tinylink\n\nA tiny URL shortener with zero dependencies.\n\n- `POST /shorten` `{ "url": "https://…", "ttlSeconds": 3600 }` → `{ "code": "ab12cd" }`\n- `GET /:code` → 302 redirect\n\n```\nnpm start\nnpm test\n```\n',
  'src/store.js': `const links = new Map();\n\nexport function save(code, url, ttlSeconds) {\n  links.set(code, { url, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });\n}\n\nexport function find(code) {\n  const link = links.get(code);\n  if (!link) return null;\n  return link; // TODO: expired links are returned as-is\n}\n\nexport function clear() { links.clear(); }\n`,
  'src/code.js': `import { randomBytes } from 'node:crypto';\n\nexport function newCode(length = 6) {\n  return randomBytes(length).toString('base64url').slice(0, length);\n}\n`,
  'src/server.js': `import http from 'node:http';\nimport { save, find } from './store.js';\nimport { newCode } from './code.js';\n\nexport function createServer() {\n  return http.createServer(async (req, res) => {\n    if (req.method === 'POST' && req.url === '/shorten') {\n      let body = '';\n      for await (const chunk of req) body += chunk;\n      const { url, ttlSeconds } = JSON.parse(body);\n      const code = newCode();\n      save(code, url, ttlSeconds);\n      res.writeHead(201, { 'content-type': 'application/json' });\n      return res.end(JSON.stringify({ code }));\n    }\n    if (req.method === 'GET') {\n      const link = find(req.url.slice(1));\n      if (!link) { res.writeHead(404); return res.end('not found'); }\n      if (link.expiresAt < Date.now()) { throw new Error('link expired'); }\n      res.writeHead(302, { location: link.url });\n      return res.end();\n    }\n    res.writeHead(405); res.end();\n  });\n}\n\nif (import.meta.url === \`file://\${process.argv[1]}\`) createServer().listen(process.env.PORT ?? 3000);\n`,
  'test/store.test.js': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { save, find, clear } from '../src/store.js';\n\ntest('saves and finds a link', () => {\n  clear();\n  save('abc', 'https://example.com');\n  assert.equal(find('abc').url, 'https://example.com');\n});\n`,
  'test/code.test.js': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { newCode } from '../src/code.js';\n\ntest('codes have the requested length', () => {\n  assert.equal(newCode(8).length, 8);\n});\n`,
};

try {
  await client.connect();
  fx.directory = process.env.TINYLINK_DIR ?? join(homedir(), 'Developer/personal/flowly-test/tinylink');
  await mkdir(fx.directory, { recursive: true });
  const d = fx.directory;
  git(['init', '-q', '-b', 'main'], d);
  git(['config', 'user.name', 'Alex Chen'], d); git(['config', 'user.email', 'alex@tinylink.example'], d);
  const commit = async (msg, names, n) => { for (const f of names) { await mkdir(join(d, f, '..'), { recursive: true }); await writeFile(join(d, f), files[f]); git(['add', f], d); } git(['commit', '-q', '-m', msg], d, day(n)); };
  await commit('Scaffold tinylink package', ['package.json', 'README.md'], 6);
  await commit('Add in-memory link store with TTL', ['src/store.js', 'test/store.test.js'], 5);
  await commit('Add short code generator', ['src/code.js', 'test/code.test.js'], 3);
  await commit('Add HTTP server: shorten and redirect', ['src/server.js'], 1);
  await save();

  fx.project = await rpc('projects.create', { title: 'Tinylink', description: 'URL shortener service — demo project for Ultra Kanban.', primaryPath: d });
  await save();
  const make = async (title, description, o = {}) => {
    const t = await rpc('tasks.create', { projectId: fx.project.id, operationId: `promo-${randomUUID()}`, title, description, status: o.status ?? 'todo', priority: o.priority ?? 'normal', type: o.type, mode: 'directory' });
    fx.cards.push({ id: t.id, workspaceId: t.workspaceId, title }); await save(); return t;
  };
  const move = (t, status) => rpc('tasks.update', { id: t.id, revision: t.revision, status, actor: 'human' });

  const cards = {
    rate: await make('Add rate limiting to POST /shorten', 'Limit each client IP to 5 shorten requests per minute; respond 429 with a Retry-After header when exceeded. Keep it dependency-free and add tests.', { priority: 'high', type: 'feature' }),
    expired: await make('Expired links crash the server instead of returning an error', 'GET /:code for a link past its TTL throws and the request hangs. Fix it and add a regression test.', { priority: 'urgent', type: 'bugfix' }),
    stats: await make('Add click counter and GET /stats/:code', 'Count redirects per link and expose them as JSON at /stats/:code. Add tests and a README section.', { priority: 'normal', type: 'feature' }),
  };
  await make('Custom aliases for short links', 'Let POST /shorten accept an optional "alias". Reject duplicates with 409.', { type: 'feature' });
  await make('Add Dockerfile and GitHub Actions workflow', 'Containerize the service and run npm test on every push.', { status: 'backlog', type: 'chore', priority: 'low' });
  let doneCard = await make('Scaffold project and short code generator', 'Initial package, store and code generator.', { type: 'chore' });
  doneCard = await move(doneCard, 'development'); doneCard = await move(doneCard, 'in_review'); await move(doneCard, 'done');

  const common = 'You are working on the Tinylink repo in your working directory (Node, zero dependencies, `npm test` uses node:test). Keep the change small and focused. Use the Kanban tools to set your stage (design while planning, development while editing, test while verifying), report progress once at each checkpoint, commit your work with git (clear message), and when finished deliver the card to in_review with a short note. ';
  const prompts = {
    rate: common + 'Task: implement the rate limiting described in the card. Plan briefly first, then implement in a new src/limiter.js wired into src/server.js, add test/limiter.test.js, run npm test. After delivering, propose exactly two ideas with kanban_propose_idea: one scope=here (e.g. make the limit configurable via env vars) and one scope=new (e.g. Redis-backed limiter for multi-instance deploys), each with concrete detail/rationale/context. As your very last action call kanban_suggest_next_moves once with three moves, recommended first: "Verify with Luna", "Commit and push", "Add 429 tests" (each prompt written as the user\'s instruction to you).',
    expired: common + 'Task: investigate the expired-link bug described in the card. Read the code and reproduce it, then BEFORE changing anything, ask the user ONE question with kanban_report_progress kind=question: should expired links return 410 Gone (and be deleted from the store) or 404 Not Found? Offer both options, then end your turn and wait for the answer. Do not edit files until answered.',
    stats: common + 'Task: implement the click counter and /stats/:code endpoint described in the card, with tests and a short README section. Run npm test, commit, deliver to in_review. After delivering, propose one idea with scope=new via kanban_propose_idea (e.g. a bug or refactor you noticed in src/server.js such as JSON.parse errors returning 500 on invalid bodies).'
  };
  for (const [key, card] of opts.sessions ? Object.entries(cards) : []) {
    const prep = await rpc('tools.prepare-session', { id: card.id, operationId: `promo-session-${randomUUID()}` });
    const s = await api.workspaces.ref(card.workspaceId).agents.create({
      agentId: prep.agentId, idempotencyKey: `promo:${prep.agentId}`,
      title: `Haiku · ${card.title.slice(0, 40)}`,
      labels: { 'ultra-kanban-task': card.id, 'ultra-kanban-project': fx.project.id },
      config: { provider: 'claude/claude-haiku-5-5', modeId: 'bypassPermissions', systemPrompt: prep.instructions, mcpServers: { 'ultra-kanban': prep.mcp } },
      env: { ULTRA_KANBAN_CONTEXT_FILE: prep.contextFile, ULTRA_KANBAN_CLI: prep.cliPath, ULTRA_KANBAN_SKILL: prep.skillPath },
      prompt: prompts[key]
    });
    fx.sessions.push({ key, id: s.id, cardId: card.id }); await save();
  }
  console.log(JSON.stringify({ status: opts.sessions ? 'started' : 'created', project: fx.project.id, dir: d, sessions: fx.sessions }));
} catch (e) {
  fx.error = String(e?.stack ?? e).slice(0, 2000); await save(); console.error(fx.error); process.exitCode = 1;
} finally {
  await api.dispose().catch(() => {}); await client.close().catch(() => {});
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let opts;
  try {
    opts = setupArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${setupUsage}`);
    process.exit(64);
  }
  if (opts.help) console.log(setupUsage);
  else await main(opts);
}
