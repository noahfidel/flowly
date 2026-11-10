import { connect, PROJECT_ID, record, readItems } from './lib.mjs';
const p = await connect();
try {
  const before = readItems('projects').find((x) => x.id === PROJECT_ID);
  await record({ kind: 'guardrail-entry', note: 'created by guardrails.detect in probe.mjs (observing "Tests")', id: 'ec4340c2-3e0f-41ff-bc98-f52166a9305b', projectId: PROJECT_ID });
  console.log('before autoReview:', JSON.stringify(before.autoReview ?? null), 'revision', before.revision);
  const proj = await p.rpc('projects.update', { id: PROJECT_ID, revision: before.revision, autoReview: { enabled: true, maxRounds: 2 } });
  console.log('after autoReview:', JSON.stringify(proj.autoReview ?? null), 'revision', proj.revision);
  await record({ kind: 'project-setting', note: 'Tinylink autoReview was absent (off); set enabled, maxRounds 2. Restore to off at the end.', projectId: PROJECT_ID });
  const g = await p.rpc('guardrails.read', { projectId: PROJECT_ID });
  const cmd = g.value.entries.find((e) => e.kind === 'command');
  console.log('command', cmd.id, cmd.text, cmd.state, cmd.revision);
  const upd = await p.rpc('guardrails.update', { id: cmd.id, revision: cmd.revision, state: 'active', stateReason: 'activated for the live check' });
  console.log('command now', upd.state, upd.revision);
  await record({ kind: 'guardrail-state', note: 'Tests command set active (observing -> active) so a failure gates the card', id: cmd.id });
} finally { await p.close(); }
