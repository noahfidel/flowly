import { connect, PROJECT_ID } from './lib.mjs';
const p = await connect();
try {
  const g = await p.rpc('guardrails.read', { projectId: PROJECT_ID });
  console.log('guardrails.read keys', Object.keys(g), JSON.stringify(g.value ?? null).slice(0, 400));
  const det = await p.rpc('guardrails.detect', { projectId: PROJECT_ID });
  console.log('detect', JSON.stringify(det).slice(0, 400));
} finally { await p.close(); }
