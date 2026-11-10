import { connect, startCardSession, readItems, task } from './lib.mjs';
const [key, prompt] = [process.argv[2], process.argv[3]];
const cards = JSON.parse(process.argv[4] || '{}');
const card = cards[key];
const p = await connect();
try {
  const s = await startCardSession(p, { id: card.id, workspaceId: card.workspaceId, title: card.title }, prompt, key);
  console.log('started', key, s.id);
} finally { await p.close(); }
