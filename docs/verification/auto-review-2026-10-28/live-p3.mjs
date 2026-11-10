// P3 live check on the Tinylink fixture (AUTO-REVIEW-SPEC §13.2). Creates temporary cards and Haiku sessions and
// removes only those. Usage: node live-p3.mjs <step>; state in p3-fixture.json.
//   insufficient   analyze-history before any fixture delivery: "insufficient", no model
//   cards          3 cards, each delivered by its session
//   rework         a person's message to each delivered card; the session reworks and delivers again
//   state          cards, flow counts, analysis status, nudge
//   goal           Auto review on with only the built-in check; a 4th card whose conversation drops a requirement
//   cleanup        delete every card this script made, discard any draft, Auto review back off
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';

const STATE = new URL('./p3-fixture.json', import.meta.url);
const ids = JSON.parse(await readFile(new URL('../../promo/ids.json', import.meta.url), 'utf8'));
const projectId = ids.project.id;
const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `ar-${randomUUID()}`, clientType: 'cli', appVersion: '0.14.0-beta.1', connectTimeoutMs: 10000, reconnect: { enabled: false } });
const api = createPaseoApi(client);
const rpc = (m, i) => client.invokePluginRpc('flowly', m, i);
const load = async () => JSON.parse(await readFile(STATE, 'utf8').catch(() => '{"cards":[]}'));
const save = (s) => writeFile(STATE, JSON.stringify(s, null, 2));
const board = () => rpc('board.read', {});
const project = async () => (await board()).projects.find((p) => p.id === projectId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const basePrompt = (extra) => `This is a Flowly test card. Do NOT edit, create or delete any files and do not run git commands. Do not propose ideas.
Steps:
1) Call flowly_get_task.
2) Set the status to development with flowly_update_status (note "Fixture work").
3) Call flowly_update_workpad with acceptance [{"text":"Fixture delivered","done":true}], validation [] and confusions [].
4) Deliver with flowly_update_status status=in_review, note "Fixture delivery", outputs [], nextMoves [].
Then end your turn.
${extra}`;
const reworkRule = `When a later message from me starts with "REWORK:", treat it as real work: call flowly_get_task, set the status to development (note "Rework"), call flowly_update_workpad again with the same items plus one confusion that quotes my message, then deliver to in_review again exactly as in step 4 (use the current revision), and end your turn.
If a message starts with "[Flowly auto review", call flowly_get_task and deliver to in_review again as in step 4, then end your turn.`;

async function makeCard(s, title, prompt) {
  const t = await rpc('tasks.create', { projectId, operationId: `ar-${randomUUID()}`, title, description: 'Temporary card for the auto review P3 live check; removed afterwards.', status: 'todo', priority: 'normal', type: 'chore', tags: ['fixture'], mode: 'directory' });
  const prep = await rpc('tools.prepare-session', { id: t.id, operationId: `ar-session-${randomUUID()}` });
  const agent = await api.workspaces.ref(t.workspaceId).agents.create({
    agentId: prep.agentId, idempotencyKey: `ar:${prep.agentId}`, title: `Haiku · ${title}`.slice(0, 80),
    labels: { 'ultra-kanban-task': t.id, 'ultra-kanban-project': projectId },
    config: { provider: 'claude/claude-haiku-5-5', modeId: 'bypassPermissions', systemPrompt: prep.instructions, mcpServers: { 'ultra-kanban': prep.mcp } },
    env: { ULTRA_KANBAN_CONTEXT_FILE: prep.contextFile, ULTRA_KANBAN_CLI: prep.cliPath, ULTRA_KANBAN_SKILL: prep.skillPath },
    prompt,
  });
  s.cards.push({ taskId: t.id, workspaceId: t.workspaceId, sessionId: agent.id, title });
  await save(s);
  return s.cards.at(-1);
}

async function waitFor(check, label, limit = 240) {
  for (let i = 0; i < limit; i++) {
    if (await check()) return true;
    await sleep(2000);
  }
  console.log(`timed out: ${label}`);
  return false;
}
const idle = async (sessionId) => (await api.agents.ref(sessionId).refresh())?.agent?.status !== 'running';

try {
  await client.connect();
  const step = process.argv[2];
  const s = await load();
  if (step === 'insufficient') {
    console.log(JSON.stringify({ analyze: await rpc('reviews.analyze-history', { projectId }), status: await rpc('reviews.analysis-status', { projectId }) }));
  } else if (step === 'cards') {
    for (const n of [1, 2, 3]) await makeCard(s, `P3 fixture ${n} (temp)`, basePrompt(reworkRule));
    await waitFor(async () => {
      const b = await board();
      return s.cards.every((c) => b.tasks.find((t) => t.id === c.taskId)?.status === 'in_review');
    }, 'deliveries');
    for (const c of s.cards) await waitFor(() => idle(c.sessionId), 'idle');
    console.log(JSON.stringify((await board()).tasks.filter((t) => s.cards.some((c) => c.taskId === t.id)).map((t) => [t.title, t.status])));
  } else if (step === 'rework') {
    const quotes = ['REWORK: the README must mention the new limit.', 'REWORK: add a test for the expired link case.', 'REWORK: the README is missing the new endpoint.'];
    for (const [i, c] of s.cards.slice(0, 3).entries()) await api.agents.ref(c.sessionId).send(quotes[i]);
    await sleep(8000);
    await waitFor(async () => {
      const b = await board();
      return s.cards.slice(0, 3).every((c) => b.tasks.find((t) => t.id === c.taskId)?.status === 'in_review');
    }, 'redeliveries');
    for (const c of s.cards) await waitFor(() => idle(c.sessionId), 'idle');
    console.log('reworked');
  } else if (step === 'state') {
    const b = await board();
    const mine = new Set(s.cards.map((c) => c.taskId));
    const events = b.events.filter((e) => mine.has(e.taskId) && (e.action === 'status_changed' || e.action.startsWith('review_'))).map((e) => `${e.at.slice(11, 19)} ${e.taskId.slice(0, 6)} ${e.actor} ${e.action}${e.rule ? ` [${e.rule}]` : ''}${e.from ? ` ${e.from}→${e.to}` : ''} ${(e.note || '').slice(0, 100)}${e.results ? ` ${JSON.stringify(e.results)}` : ''}`);
    console.log(events.join('\n'));
    const p = await project();
    console.log(JSON.stringify({ status: await rpc('reviews.analysis-status', { projectId }), autoReview: p.autoReview, draft: p.reviewDraft ? { by: p.reviewDraft.by, summary: p.reviewDraft.summary, added: p.reviewDraft.added, rules: p.reviewDraft.rules.map((r) => r.id) } : null }, null, 1));
    for (const c of s.cards) {
      const t = b.tasks.find((x) => x.id === c.taskId);
      if (t?.review) console.log(c.title, JSON.stringify(t.review.rules.map((r) => ({ id: r.id, state: r.state, detail: r.detail, reason: r.reason }))), t.review.state);
    }
  } else if (step === 'goal') {
    const p = await project();
    await rpc('projects.update', { id: p.id, revision: p.revision, autoReview: { enabled: true, maxRounds: 1, rules: [] } });
    const prompt = basePrompt(`Card requirements from me (the user): 1) Report the fixture as delivered. 2) Also add a CHANGELOG entry.
Update from me: skip the CHANGELOG entry for now, we will do it later. Do not add it.
If you receive a message that starts with "[Flowly auto review", call flowly_get_task and deliver to in_review again as in step 4, then end your turn.`);
    const c = await makeCard(s, 'P3 goal fixture (temp)', prompt);
    await waitFor(async () => {
      const t = (await board()).tasks.find((x) => x.id === c.taskId);
      return !!t?.review && t.review.state !== 'running';
    }, 'goal review', 300);
    const t = (await board()).tasks.find((x) => x.id === c.taskId);
    console.log(JSON.stringify({ status: t.status, review: t.review }, null, 1));
  } else if (step === 'cleanup') {
    for (const c of s.cards) await waitFor(() => idle(c.sessionId), 'idle before delete', 60);
    const out = [];
    for (const c of s.cards) {
      const t = (await board()).tasks.find((x) => x.id === c.taskId);
      if (t) out.push(await rpc('tasks.delete', { id: t.id, revision: t.revision, archive: true, acknowledgeWarnings: true }).then((r) => r.id, (e) => `ERR ${e.message}`));
    }
    let p = await project();
    if (p.reviewDraft) await rpc('reviews.discard-draft', { projectId, at: p.reviewDraft.at });
    p = await project();
    await rpc('projects.update', { id: p.id, revision: p.revision, autoReview: { enabled: false, maxRounds: 2, rules: [] } });
    p = await project();
    const b = await board();
    console.log(JSON.stringify({ deleted: out, left: s.cards.filter((c) => b.tasks.some((t) => t.id === c.taskId)).length, autoReview: p.autoReview, draft: p.reviewDraft ?? null }));
    await rm(STATE, { force: true });
  }
} catch (e) {
  console.error('ERROR', e?.message || e);
  process.exitCode = 1;
} finally {
  await api.dispose().catch(() => {});
  await client.close().catch(() => {});
}
