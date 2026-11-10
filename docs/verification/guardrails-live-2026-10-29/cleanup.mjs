import { connect, task, readItems, PROJECT_ID, record } from './lib.mjs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
const log = JSON.parse(await readFile(new URL('./created.json', import.meta.url), 'utf8'));
const cards = log.created.filter((c) => c.kind === 'card');
const p = await connect();
try {
  for (const c of cards) {
    const t = task(c.id);
    const out = await p.rpc('tasks.delete', { id: c.id, revision: t.revision, archive: true, acknowledgeWarnings: true });
    // The backup path names the local home directory; keep it out of the committed log.
    if (typeof out?.backup === 'string') out.backup = out.backup.replace(homedir(), '~');
    await record({ kind: 'cleanup', note: 'card deleted with archive (sessions and worktree workspace)', key: c.key, id: c.id, out: JSON.stringify(out).slice(0, 300) });
    console.log('deleted', c.key, c.id.slice(0, 8), JSON.stringify(out).slice(0, 200));
  }
  // Restore the project's Auto review to its earlier state (absent, i.e. off).
  const proj = readItems('projects').find((x) => x.id === PROJECT_ID);
  const after = await p.rpc('projects.update', { id: PROJECT_ID, revision: proj.revision, autoReview: { enabled: false, maxRounds: 2 } });
  console.log('project autoReview', JSON.stringify(after.autoReview));
  await record({ kind: 'cleanup', note: 'Tinylink autoReview set back to enabled:false (was absent)', id: PROJECT_ID });
  // Guardrail entries this run created: the detected "Tests" command and the learned README guideline.
  const g = await p.rpc('guardrails.read', { projectId: PROJECT_ID });
  for (const e of g.value.entries) {
    if (e.id === 'ec4340c2-3e0f-41ff-bc98-f52166a9305b' || e.id === '09e1edb5-b57f-4d0f-aeba-79b86834e182') {
      const d = await p.rpc('guardrails.delete', { id: e.id, revision: e.revision });
      console.log('guardrail deleted', e.text.slice(0, 40), JSON.stringify(d));
      await record({ kind: 'cleanup', note: 'guardrail entry created by this run deleted', id: e.id });
    }
  }
} finally { await p.close(); }
