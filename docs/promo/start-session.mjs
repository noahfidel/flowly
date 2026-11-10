// Usage: node start-session.mjs <cardTitleSubstring> <prompt>
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';
const fx = JSON.parse(await readFile(new URL('./ids.json', import.meta.url), 'utf8'));
const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `promo-${randomUUID()}`, clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 10000, reconnect: { enabled: false } });
const api = createPaseoApi(client);
try {
  await client.connect();
  const card = fx.cards.find((c) => c.title.includes(process.argv[2]));
  const prep = await client.invokePluginRpc('flowly', 'tools.prepare-session', { id: card.id, operationId: `promo-session-${randomUUID()}` });
  const s = await api.workspaces.ref(card.workspaceId).agents.create({
    agentId: prep.agentId, idempotencyKey: `promo:${prep.agentId}`, title: `Haiku · ${card.title.slice(0, 40)}`,
    labels: { 'ultra-kanban-task': card.id, 'ultra-kanban-project': fx.project.id },
    config: { provider: 'claude/claude-haiku-5-5', modeId: 'bypassPermissions', systemPrompt: prep.instructions },
    env: { ULTRA_KANBAN_CONTEXT_FILE: prep.contextFile, ULTRA_KANBAN_CLI: prep.cliPath, ULTRA_KANBAN_SKILL: prep.skillPath },
    prompt: process.argv[3]
  });
  fx.sessions.push({ key: 'late', id: s.id, cardId: card.id }); await writeFile(new URL('./ids.json', import.meta.url), JSON.stringify(fx, null, 2));
  console.log('started', s.id);
} finally { await api.dispose().catch(() => {}); await client.close().catch(() => {}); }
