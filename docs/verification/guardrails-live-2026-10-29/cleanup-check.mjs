import { connect, task, readItems } from './lib.mjs';
import { readFile } from 'node:fs/promises';
const log = JSON.parse(await readFile(new URL('./created.json', import.meta.url), 'utf8'));
const cards = log.created.filter((c) => c.kind === 'card');
const p = await connect();
try {
  for (const c of cards) {
    const t = task(c.id);
    const r = await p.rpc('tasks.delete-check', { id: c.id }).catch((e) => ({ error: String(e).slice(0, 300) }));
    console.log(c.key, c.id.slice(0, 8), t.status, JSON.stringify(r).slice(0, 400));
  }
} finally { await p.close(); }
