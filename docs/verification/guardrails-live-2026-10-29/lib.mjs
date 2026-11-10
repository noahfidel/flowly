// Helper for the live guardrails check (GUARDRAILS-SPEC §14). Uses the plugin RPCs and the Paseo client only.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';

export const PROJECT_ID = '3db2ad5b-e6c4-4054-b2ed-a13a8dfa0663';
const FX = new URL('../../promo/ids.json', import.meta.url);
export const LOG = new URL('./created.json', import.meta.url);
const SQLITE = `${process.env.HOME}/.paseo/plugin-data/flowly/flowly.sqlite`;

export async function connect() {
  const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `guardrails-live-${randomUUID()}`, clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 10000, reconnect: { enabled: false } });
  await client.connect();
  const api = createPaseoApi(client);
  const rpc = (name, input) => client.invokePluginRpc('flowly', name, input);
  return { client, api, rpc, close: async () => { await api.dispose().catch(() => {}); await client.close().catch(() => {}); } };
}

// Read-only view of the board table (the daemon's own store; never written here).
export function readItems(collection) {
  const out = execFileSync('sqlite3', ['-readonly', '-json', SQLITE, `select body from items where collection='${collection}'`], { encoding: 'utf8' });
  return (out.trim() ? JSON.parse(out) : []).map((r) => JSON.parse(r.body));
}
export const task = (id) => readItems('tasks').find((t) => t.id === id);

// Records every id this run creates, so cleanup can be checked against the list.
export async function record(entry) {
  let log = { created: [] };
  try { log = JSON.parse(await readFile(LOG, 'utf8')); } catch { /* first write */ }
  log.created.push({ at: new Date().toISOString(), ...entry });
  await writeFile(LOG, JSON.stringify(log, null, 2));
}

// Same as docs/promo/start-session.mjs: a session started through Flowly so it gets the Flowly MCP tools.
export async function startCardSession(p, card, prompt, key) {
  const prep = await p.rpc('tools.prepare-session', { id: card.id, operationId: `guardrails-live-${randomUUID()}` });
  const s = await p.api.workspaces.ref(card.workspaceId).agents.create({
    agentId: prep.agentId, idempotencyKey: `guardrails-live:${prep.agentId}`, title: `Haiku · ${key} · ${card.title.slice(0, 40)}`,
    labels: { 'ultra-kanban-task': card.id, 'ultra-kanban-project': PROJECT_ID },
    config: { provider: 'claude/claude-haiku-5-5', modeId: 'bypassPermissions', systemPrompt: prep.instructions, mcpServers: { 'ultra-kanban': prep.mcp } },
    env: { ULTRA_KANBAN_CONTEXT_FILE: prep.contextFile, ULTRA_KANBAN_CLI: prep.cliPath, ULTRA_KANBAN_SKILL: prep.skillPath },
    prompt,
  });
  await record({ kind: 'session', key, agentId: s.id, cardId: card.id, workspaceId: card.workspaceId });
  return s;
}
