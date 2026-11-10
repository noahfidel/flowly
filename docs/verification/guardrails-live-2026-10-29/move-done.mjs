import { connect, task } from './lib.mjs';
const id = process.argv[2];
const t = task(id);
const p = await connect();
try {
  const out = await p.rpc('tasks.update', { id, revision: t.revision, status: 'done', actor: 'human' });
  console.log('status now', out.status, 'revision', out.revision);
} finally { await p.close(); }
