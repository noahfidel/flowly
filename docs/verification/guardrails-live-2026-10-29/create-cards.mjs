import { randomUUID } from 'node:crypto';
import { connect, PROJECT_ID, record } from './lib.mjs';
const CARDS = [
  ['A', 'Add GET /health', 'Add GET /health to the Tinylink server: 200 with JSON {"ok":true}. Cover it with a test in test/.'],
  ['B', 'Add GET /version', 'Add GET /version to the Tinylink server: 200 with JSON {"name","version"} read from package.json. Cover it with a test in test/.'],
  ['C', 'Add GET /ping', 'Add GET /ping to the Tinylink server: 200 with the plain text pong. Cover it with a test in test/.'],
  ['D', 'Add a 450-line fixture', 'Add test/fixtures/big.txt with 450 lines (for example seq 1 450). Add a test that reads it and checks it has 450 lines.'],
  ['E', 'Add GET /echo/:word', 'Add GET /echo/:word to the Tinylink server: 200 with JSON {"word"}. Cover it with a test in test/.'],
];
const p = await connect();
try {
  const out = {};
  for (const [key, title, description] of CARDS) {
    const t = await p.rpc('tasks.create', { projectId: PROJECT_ID, operationId: `guardrails-live-${randomUUID()}`, title: `[guardrails-live ${key}] ${title}`, description, status: 'development', type: 'feature', mode: 'worktree' });
    out[key] = { id: t.id, workspaceId: t.workspaceId, title: t.title };
    await record({ kind: 'card', key, id: t.id, workspaceId: t.workspaceId, title: t.title });
    console.log(key, t.id, t.workspaceId, t.status, t.type, JSON.stringify(t.branchName ?? null), JSON.stringify(t.workspaceDirectory ?? null));
  }
} finally { await p.close(); }
