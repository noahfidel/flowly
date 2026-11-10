// Fix 1 live check (AUTO-REVIEW-SPEC §12.3): Apply on a draft that was replaced after the page showed it.
// Creates one temp card + Haiku session on Tinylink, proposes drafts through the session's own Flowly CLI context,
// and removes everything it created. Usage: node live-stale.mjs
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';
import { launch, open, shot } from '../../promo/shot-lib.mjs';

const dir = new URL('./', import.meta.url).pathname;
const ids = JSON.parse(await readFile(new URL('../../promo/ids.json', import.meta.url), 'utf8'));
const projectId = ids.project.id;
const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `ar-${randomUUID()}`, clientType: 'cli', appVersion: '0.14.0-beta.1', connectTimeoutMs: 10000, reconnect: { enabled: false } });
const api = createPaseoApi(client);
const rpc = (m, i) => client.invokePluginRpc('flowly', m, i);
const project = async () => (await rpc('board.read', {})).projects.find((p) => p.id === projectId);
const out = {};
let browser, taskId = process.env.CLEAN_TASK;
if (process.env.CLEAN_SESSION) out.sessionId = process.env.CLEAN_SESSION;
try {
  await client.connect();
  if (process.env.CLEAN_TASK) throw new Error('cleanup only');
  const before = await project();
  out.before = { revision: before.revision, autoReview: before.autoReview, draft: before.reviewDraft ?? null };
  const t = await rpc('tasks.create', { projectId, operationId: `ar-${randomUUID()}`, title: 'Auto review stale-draft fixture (temp)', description: 'Temporary card; removed afterwards.', status: 'todo', priority: 'normal', type: 'chore', tags: ['fixture'], mode: 'directory' });
  taskId = t.id;
  const prep = await rpc('tools.prepare-session', { id: t.id, operationId: `ar-session-${randomUUID()}` });
  const agent = await api.workspaces.ref(t.workspaceId).agents.create({
    agentId: prep.agentId, idempotencyKey: `ar:${prep.agentId}`, title: 'Haiku · stale-draft fixture',
    labels: { 'ultra-kanban-task': t.id, 'ultra-kanban-project': projectId },
    config: { provider: 'claude/claude-haiku-5-5', modeId: 'bypassPermissions', systemPrompt: prep.instructions, mcpServers: { 'ultra-kanban': prep.mcp } },
    env: { ULTRA_KANBAN_CONTEXT_FILE: prep.contextFile, ULTRA_KANBAN_CLI: prep.cliPath, ULTRA_KANBAN_SKILL: prep.skillPath },
    prompt: 'Reply "OK" and end your turn. Do not call any tools.',
  });
  Object.assign(out, { taskId: t.id, workspaceId: t.workspaceId, sessionId: agent.id });
  const snap = `${process.env.TMPDIR || '/tmp'}/ar-stale-${randomUUID()}.json`;
  const cli = (...args) => execFileSync('node', [prep.cliPath, '--context-file', prep.contextFile, ...args], { encoding: 'utf8', env: { ...process.env, PASEO_AGENT_ID: agent.id } });
  const propose = (name, note) => {
    cli('current', '--save-request', snap);
    return cli('review-rules', '--request-file', snap, '--note', note, '--rules', JSON.stringify([{ id: 'syntax', name, kind: 'command', argv: ['node', '--check', 'src/server.js'] }]));
  };
  propose('Draft A rule', 'Draft A');
  out.draftA = (await project()).reviewDraft.at;

  browser = await launch();
  const s = await open(browser, { w: 2300, h: 1100, project: 'Tinylink' });
  const save = async (name) => { await s.page.mouse.move(s.w / 2, 8); await s.page.waitForTimeout(400); await shot(s, `${dir}fix1-${name}.png`); };
  await s.page.getByRole('button', { name: 'Project settings' }).first().click();
  await s.page.waitForTimeout(1500);
  await s.page.getByText('Proposed rules', { exact: true }).first().scrollIntoViewIfNeeded();
  await s.page.waitForTimeout(500);
  out.setupButtonWithSwitchOff = await s.page.getByText('Set up with AI', { exact: true }).count();
  await save('draft-a');
  // B replaces A; press Apply on the page that still shows A.
  propose('Draft B rule', 'Draft B');
  out.draftB = (await project()).reviewDraft.at;
  out.pageShowedBeforeApply = (await s.page.getByText('Draft B', { exact: true }).count()) ? 'B' : 'A';
  await s.page.getByRole('button', { name: /^Apply/ }).first().click();
  await s.page.waitForTimeout(2500);
  out.notice = await s.page.getByText('The agent proposed a new draft. Review it before applying.').count();
  out.pageShowsB = await s.page.getByText('Draft B', { exact: true }).count();
  const after = await project();
  out.afterStaleApply = { revision: after.revision, draft: after.reviewDraft?.note, enabled: after.autoReview?.enabled ?? false };
  await save('stale-notice');
  // Discard now targets B, which is shown: allowed.
  await s.page.getByRole('button', { name: 'Discard', exact: true }).first().click();
  await s.page.waitForTimeout(2000);
  out.afterDiscard = { draft: (await project()).reviewDraft ?? null, revision: (await project()).revision };
  out.errors = s.errors;
} catch (e) {
  out.error = e?.message || String(e);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (taskId) {
    // Wait for the fixture session's turn to end before archiving it.
    for (let i = 0; i < 60; i++) {
      const a = out.sessionId ? (await api.agents.ref(out.sessionId).refresh().catch(() => null))?.agent : null;
      if (!a || a.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const b = await rpc('board.read', {});
    const t = b.tasks.find((x) => x.id === taskId);
    if (t) out.cleanup = await rpc('tasks.delete', { id: t.id, revision: t.revision, archive: true, acknowledgeWarnings: true }).catch((e) => e.message);
    const p = await project();
    if (p.reviewDraft) out.leftDraft = await rpc('reviews.discard-draft', { projectId, at: p.reviewDraft.at });
    out.final = { card: !!(await rpc('board.read', {})).tasks.find((x) => x.id === taskId), draft: (await project()).reviewDraft ?? null, autoReview: (await project()).autoReview };
  }
  console.log(JSON.stringify(out, null, 2));
  await api.dispose().catch(() => {});
  await client.close().catch(() => {});
}
