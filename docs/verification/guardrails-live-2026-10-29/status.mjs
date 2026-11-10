import { readItems } from './lib.mjs';
const ids = process.argv.slice(2);
const tasks = readItems('tasks');
for (const id of ids) {
  const t = tasks.find((x) => x.id === id);
  if (!t) { console.log(id, 'missing'); continue; }
  const r = t.review;
  console.log(id.slice(0, 8), 'status', t.status, 'review', r ? `${r.state} round ${r.round}/${r.maxRounds} items ${(r.items || []).map((i) => `${i.kind}:${i.name}:${i.state}`).join(' | ')}` : 'none', 'rework', t.reworkRound ?? '', 'disputes', (t.disputes || []).length);
}
