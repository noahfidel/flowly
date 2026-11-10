// Auto review live check on the Tinylink fixture (AUTO-REVIEW-SPEC). Creates one temporary card and one Haiku
// session, and cleans up only those. Usage: node drive.mjs setup|state|config <checksJSON> <rounds>|rerun|cleanup
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';

const STATE = new URL('./fixture.json', import.meta.url);
const ids = JSON.parse(await readFile(new URL('../../promo/ids.json', import.meta.url), 'utf8'));
const projectId = ids.project.id;
const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `ar-${randomUUID()}`, clientType: 'cli', appVersion: '0.14.0-beta.1', connectTimeoutMs: 10000, reconnect: { enabled: false } });
const api = createPaseoApi(client);
const rpc = (m, i) => client.invokePluginRpc('flowly', m, i);
const load = async () => JSON.parse(await readFile(STATE, 'utf8').catch(() => '{}'));
const save = (s) => writeFile(STATE, JSON.stringify(s, null, 2));
const board = () => rpc('board.read', {});
const project = async () => (await board()).projects.find((p) => p.id === projectId);
// P2: rules (command + LLM); P1 runs passed checks, which the daemon now reads as command rules.
const configure = async (rules, maxRounds, enabled = true, guidance) => {
  const p = await project();
  const list = rules.map((r, i) => (r.kind ? r : { id: `check-${i + 1}`, name: r.name, kind: 'command', argv: r.argv }));
  return rpc('projects.update', { id: p.id, revision: p.revision, autoReview: { enabled, rules: list, maxRounds, ...(guidance ? { guidance } : {}) } });
};
const prompt = `This is a Flowly auto-review test card. Do NOT edit, create or delete any files and do not run git commands. Steps:
1) Call flowly_get_task.
2) Set the status to development with flowly_update_status (note "Fixture work").
3) Call flowly_update_workpad with acceptance [{"text":"Fixture delivered","done":true}], validation [] and confusions [].
4) Deliver with flowly_update_status status=in_review, note "Fixture delivery", outputs [], nextMoves [].
Then end your turn without proposing ideas.
If you later receive a message that starts with "[Flowly auto review · rework", do not change any files: call flowly_get_task and deliver to in_review again exactly as in step 4 (use the current revision), then end your turn.`;

try {
  await client.connect();
  const cmd = process.argv[2];
  const s = await load();
  if (cmd === 'session') {
    // Paseo 0.14's agent.session_open rejects the prepared-session path (see report), so attach an existing one.
    const created = await api.workspaces.ref(s.workspaceId).agents.create({ title: 'Haiku · Auto review fixture', config: { provider: 'claude/claude-haiku-5-5', modeId: 'bypassPermissions' } });
    s.sessionId = created.id; await save(s);
    const prep = await rpc('tools.prepare-existing', { id: s.taskId, agentId: created.id });
    await api.agents.ref(created.id).send(`${prep.instructions}\n\n${prompt.replaceAll('flowly_get_task', 'the Flowly CLI `current`').replaceAll('flowly_update_status', 'the CLI `status`').replaceAll('flowly_update_workpad', 'the CLI `workpad`')}`);
    console.log(JSON.stringify(s));
  } else if (cmd === 'setup') {
    const failing = [{ name: 'Unit tests', argv: ['node', '-e', "console.error('FAIL test/links.test.js: expected 1 to be 2'); process.exit(1)"] }];
    await configure(process.env.CHECKS ? JSON.parse(process.env.CHECKS) : failing, 1);
    const t = await rpc('tasks.create', { projectId, operationId: `ar-${randomUUID()}`, title: 'Auto review fixture (temp)', description: 'Temporary card for the auto review live check; removed afterwards.', status: 'todo', priority: 'normal', type: 'chore', tags: ['fixture'], mode: 'directory' });
    Object.assign(s, { taskId: t.id, workspaceId: t.workspaceId, createdAt: new Date().toISOString() });
    await save(s);
    const prep = await rpc('tools.prepare-session', { id: t.id, operationId: `ar-session-${randomUUID()}` });
    const agent = await api.workspaces.ref(t.workspaceId).agents.create({
      agentId: prep.agentId, idempotencyKey: `ar:${prep.agentId}`, title: 'Haiku · Auto review fixture',
      labels: { 'ultra-kanban-task': t.id, 'ultra-kanban-project': projectId },
      config: { provider: 'claude/claude-haiku-5-5', modeId: 'bypassPermissions', systemPrompt: prep.instructions, mcpServers: { 'ultra-kanban': prep.mcp } },
      env: { ULTRA_KANBAN_CONTEXT_FILE: prep.contextFile, ULTRA_KANBAN_CLI: prep.cliPath, ULTRA_KANBAN_SKILL: prep.skillPath },
      prompt,
    });
    s.sessionId = agent.id; await save(s);
    console.log(JSON.stringify(s));
  } else if (cmd === 'state') {
    const b = await board();
    const t = b.tasks.find((x) => x.id === s.taskId);
    const agent = s.sessionId ? (await api.agents.ref(s.sessionId).refresh())?.agent : null;
    const events = b.events.filter((e) => e.taskId === s.taskId).map((e) => `${e.at.slice(11, 19)} ${e.actor} ${e.action}${e.rule ? ` [${e.rule}]` : ''}${e.from ? ` ${e.from}→${e.to}` : ''} ${(e.note || '').slice(0, 120)}`);
    console.log(JSON.stringify({ status: t?.status, session: agent?.status, review: t?.review && { ...t.review, rules: t.review.rules.map((c) => ({ ...c, tail: c.tail?.slice(-120) })) }, draft: (await project()).reviewDraft }, null, 2));
    console.log(events.join('\n'));
  } else if (cmd === 'config') {
    await configure(JSON.parse(process.argv[3]), Number(process.argv[4]));
    console.log('configured');
  } else if (cmd === 'move') {
    const t = (await board()).tasks.find((x) => x.id === s.taskId);
    console.log((await rpc('tasks.update', { id: t.id, revision: t.revision, status: process.argv[3], actor: 'human' })).status);
  } else if (cmd === 'setup-card') {
    // Set up with AI from the daemon side; the UI path is checked in shots-p2.mjs.
    const p = await project();
    const card = (await board()).tasks.find((x) => x.projectId === p.id && x.reviewSetup && !x.archivedAt);
    console.log(JSON.stringify({ existing: card?.id ?? null, autoReview: p.autoReview, draft: p.reviewDraft ?? null }));
  } else if (cmd === 'setup-state') {
    const b = await board();
    const t = b.tasks.find((x) => x.projectId === projectId && x.reviewSetup && !x.archivedAt);
    const agents = [];
    const events = t ? b.events.filter((e) => e.taskId === t.id).map((e) => `${e.at.slice(11, 19)} ${e.actor} ${e.action} ${(e.note || '').slice(0, 160)}`) : [];
    console.log(JSON.stringify({ task: t && { id: t.id, status: t.status, workspaceId: t.workspaceId, review: t.review ?? null }, agents: agents.map?.((a) => ({ id: a.id, status: a.status, provider: a.provider, model: a.model })), project: { revision: (await project()).revision, autoReview: (await project()).autoReview, draft: (await project()).reviewDraft ?? null } }, null, 2));
    console.log(events.join('\n'));
  } else if (cmd === 'rerun') {
    console.log(await rpc('reviews.rerun', { taskId: s.taskId }));
  } else if (cmd === 'cleanup') {
    const b = await board();
    const t = b.tasks.find((x) => x.id === s.taskId);
    if (t) console.log('deleted', JSON.stringify(await rpc('tasks.delete', { id: t.id, revision: t.revision, archive: true, acknowledgeWarnings: true })));
    const setup = (await board()).tasks.find((x) => x.id === process.env.SETUP_TASK);
    if (setup) console.log('deleted setup', JSON.stringify(await rpc('tasks.delete', { id: setup.id, revision: setup.revision, archive: true, acknowledgeWarnings: true })));
    // The project had no autoReview before this test; the default (off, no checks) behaves the same.
    await configure([], 2, false);
    const agent = s.sessionId ? (await api.agents.ref(s.sessionId).refresh())?.agent : null;
    const ws = s.workspaceId ? await api.workspaces.ref(s.workspaceId).refresh().catch(() => null) : null;
    console.log(JSON.stringify({ card: !!(await board()).tasks.find((x) => x.id === s.taskId), session: agent ? { status: agent.status, archivedAt: agent.archivedAt } : null, workspace: ws ? { archivingAt: ws.archivingAt, status: ws.status } : null, autoReview: (await project()).autoReview }));
  }
} catch (e) {
  console.error('ERROR', e?.message || e);
  process.exitCode = 1;
} finally {
  await api.dispose().catch(() => {});
  await client.close().catch(() => {});
}
