// Live checks for the Flowly single pane (plan Task 12; DISPATCHER-SPEC, START-CARD-SPEC, IDEAS-IMPORT-EXPORT-SPEC).
// Runs against the real daemon with the installed plugin. Noah runs it after installing the branch build:
//   FLOWLY_TELEMETRY=0 node docs/verification/single-pane-live.mjs [--only 1,2,…] [--help]
// Each check prints PASS, FAIL <reason> or SKIP <reason>. Exit 0: all selected checks pass and cleanup verified.
// Exit 1: a FAIL or a cleanup problem. Exit 2: no FAIL, but a check was skipped. See single-pane.md.
//
// Safety (AGENTS.md "Tinylink" and testing rules): nothing here is created without being recorded first, only ids in
// the record are ever deleted, the Tinylink project and every card or session this run did not create are never
// touched, no message goes to a session this run did not create (the dispatcher only with --use-existing-dispatcher),
// and cleanup runs in `finally` and is verified in both Paseo and the board. No UI is driven: RPC only.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const MODEL = 'claude/claude-haiku-5-5';
const STEP_MS = 10 * 60_000; // agent steps wait at most 10 minutes
const NOTE_SETTLE_MS = 25_000; // longer than the note batch window (10 s), so a second note would have arrived

// ---- Checks ------------------------------------------------------------------------------------------------------

/** Skipped, not failed: a precondition this run cannot or must not create (reported, exit code 2). */
export class Skip extends Error {}

/**
 * `needsFinalFix`: the check (or part of it) asserts a behavior from Noah's rulings that lands in the fix round after
 * Task 12; until then it can fail on the current build.
 */
export const CHECKS = [
  {
    id: 1,
    title: 'Dispatcher: "make a card for X and start it" gives a card whose session runs in a new worktree workspace',
    needs: ['tinylink', 'dispatcher'],
    needsFinalFix: 'the dead dispatcher is archived when a new one starts (only when an ended dispatcher existed)',
    run: checkDispatcherStartsCard,
  },
  {
    id: 2,
    title: 'Asks: a Flowly question, an AskUserQuestion and a permission appear in the chat, answer through asks.answer, tick only on success, session_ended',
    needs: ['tinylink'],
    run: checkAsks,
  },
  {
    id: 3,
    title: 'Notes: a status change gives the dispatcher one batched note; its own create gives none',
    needs: ['tinylink', 'dispatcher'],
    run: checkNotes,
  },
  {
    id: 4,
    title: 'Dispatcher splits a plan into two cards, each with its own worktree; wrap-up removes the workspace from Paseo',
    needs: ['tinylink', 'dispatcher'],
    run: checkSplitAndWrapUp,
  },
  {
    id: 5,
    title: 'Import: a copy of the backlog through ideas.import-preview and ideas.import creates exactly the kept rows',
    needs: ['fixture'],
    run: checkImport,
  },
  {
    id: 6,
    title: 'Export: board.export-markdown lists the fixture project with its card, idea and memory entry',
    needs: ['fixture'],
    run: checkExport,
  },
  {
    id: 7,
    title: 'Bell: attention.count equals the open asks in the chat; dismissing in one clears the other',
    needs: ['tinylink'],
    run: checkBell,
  },
];

// ---- Arguments and help ------------------------------------------------------------------------------------------

export class UsageError extends Error {}

/** `argv` without node and the script. Throws UsageError for anything unknown or malformed. */
export function parseArgs(argv) {
  const args = {
    help: false,
    only: null,
    ids: null,
    backlog: null,
    useExistingDispatcher: false,
    keepDispatcher: false,
    cleanup: null,
    home: process.env.PASEO_HOME || join(homedir(), '.paseo'),
  };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--only') {
      const ids = value(i++, a).split(',').map((s) => s.trim()).filter(Boolean);
      if (!ids.length) throw new UsageError('--only needs check numbers, such as --only 1,2.');
      const known = new Set(CHECKS.map((c) => String(c.id)));
      for (const id of ids) if (!known.has(id)) throw new UsageError(`Unknown check "${id}". Checks: ${[...known].join(', ')}.`);
      args.only = new Set(ids.map(Number));
    } else if (a === '--ids') args.ids = value(i++, a);
    else if (a === '--backlog') args.backlog = value(i++, a);
    else if (a === '--cleanup') args.cleanup = value(i++, a);
    else if (a === '--home') args.home = value(i++, a);
    else if (a === '--use-existing-dispatcher') args.useExistingDispatcher = true;
    else if (a === '--keep-dispatcher') args.keepDispatcher = true;
    else throw new UsageError(`Unknown option "${a}". Try --help.`);
  }
  return args;
}

export function helpText() {
  const lines = [
    'Usage: FLOWLY_TELEMETRY=0 node docs/verification/single-pane-live.mjs [options]',
    '',
    'Live checks for the Flowly single pane, against the running daemon with the branch build installed.',
    'Exit 0: all selected checks pass and cleanup is verified. 1: a FAIL or a cleanup problem. 2: no FAIL, a check skipped.',
    '',
    'Checks:',
    ...CHECKS.map((c) => `  ${c.id}. ${c.title}${c.needsFinalFix ? `\n     (needs the final fix round: ${c.needsFinalFix})` : ''}`),
    '',
    'Options:',
    '  --only 1,2,…                 Run only these checks.',
    '  --ids <file>                 The Tinylink ids file (default docs/promo/ids.json; else the project titled "Tinylink").',
    '  --backlog <file>             Backlog markdown for check 5 (default $FLOWLY_BACKLOG_DIR or ~/.claude/backlogs, zenlytic.md;',
    '                               else the synthetic fixture shared/fixtures/backlogs/recipes.md).',
    '  --use-existing-dispatcher    Let checks 1, 3 and 4 message the dispatcher that is already running. Without it they',
    '                               skip, because this script sends messages only to sessions it created.',
    '  --keep-dispatcher            Do not archive a dispatcher this run started (default: archived at the end).',
    '  --cleanup <record file>      Clean up what a crashed run recorded (the file path is printed at the start), then exit.',
    '  --home <dir>                 Paseo home (default $PASEO_HOME or ~/.paseo).',
    '  --help                       This text.',
    '',
    'Created things carry the title prefix "[single-pane-live <run>]". Every id is recorded in',
    `${join(tmpdir(), 'single-pane-live-<run>.json')} before it is created.`,
  ];
  return lines.join('\n');
}

// ---- Small helpers -----------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => (e instanceof Error ? e.message : String(e));
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const within = (child, parent) => {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
};

/** Polls `fn` until it returns a truthy value; the last value or error goes into the timeout message. */
async function waitFor(label, fn, { timeout = 60_000, interval = 2_000 } = {}) {
  const started = Date.now();
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (e) {
      last = `error: ${errText(e)}`;
    }
    if (Date.now() - started >= timeout) throw new Error(`Timed out after ${Math.round(timeout / 1000)} s waiting for ${label}${last === undefined ? '' : ` (last: ${typeof last === 'string' ? last : JSON.stringify(last)})`}.`);
    await sleep(interval);
  }
}

async function expectRejection(label, fn, pattern) {
  try {
    await fn();
  } catch (e) {
    if (!pattern.test(errText(e))) throw new Error(`${label}: refused with an unexpected message: ${errText(e)}`);
    return errText(e);
  }
  throw new Error(`${label}: expected a refusal, but the call succeeded.`);
}

// ---- Run record and cleanup --------------------------------------------------------------------------------------

/**
 * Everything this run creates, written to a file after each change, so a crash can be cleaned up with --cleanup. Only
 * ids in here are deleted; cards are also matched by the run's title prefix and, for the Tinylink project, never
 * outside it.
 */
class Record {
  constructor(file, data) {
    this.file = file;
    this.data = data;
  }
  static fresh(runId) {
    const file = join(tmpdir(), `single-pane-live-${runId}.json`);
    const rec = new Record(file, {
      runId,
      marker: `[single-pane-live ${runId}]`,
      startedAt: new Date().toISOString(),
      tinylinkProjectId: null,
      tinylinkRoot: null,
      cards: [], // { id, title, projectId, workspaces: [ids], branches: [names] }
      agents: [], // ids this run created (or the dispatcher it started)
      tmpDirs: [], // directories this run made under os.tmpdir()
      fixtureProjects: [], // { path, id? }
      memory: [], // { projectId, id }
      dispatcher: null, // { agentId, prior, ours }
    });
    rec.save();
    return rec;
  }
  static load(file) {
    return new Record(file, JSON.parse(readFileSync(file, 'utf8')));
  }
  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
  get marker() {
    return this.data.marker;
  }
  addAgent(id) {
    if (!this.data.agents.includes(id)) this.data.agents.push(id);
    this.save();
  }
  addDir(path) {
    this.data.tmpDirs.push(path);
    this.save();
  }
  addFixtureProject(entry) {
    this.data.fixtureProjects.push(entry);
    this.save();
  }
  addMemory(entry) {
    this.data.memory.push(entry);
    this.save();
  }
  card(task) {
    let c = this.data.cards.find((x) => x.id === task.id);
    if (!c) {
      c = { id: task.id, title: task.title, projectId: task.projectId, workspaces: [], branches: [] };
      this.data.cards.push(c);
    }
    for (const w of [task.workspaceId, ...(task.previousWorkspaces ?? []).map((p) => p.id)]) if (w && !c.workspaces.includes(w)) c.workspaces.push(w);
    this.save();
    return c;
  }
  branch(task, name) {
    const c = this.card(task);
    if (name && !c.branches.includes(name)) c.branches.push(name);
    this.save();
  }
}

// ---- Connection and API helpers ----------------------------------------------------------------------------------

async function connect(args) {
  const { DaemonClient } = await import('@getpaseo/client/internal/daemon-client');
  const { createPaseoApi } = await import('@getpaseo/client');
  let url = 'ws://127.0.0.1:6767/ws';
  let token = null;
  try {
    const lock = JSON.parse(readFileSync(join(args.home, 'paseo.pid'), 'utf8'));
    url = `ws://${String(lock.listen).replace(/^tcp:\/\//, '')}/ws`;
    token = readFileSync(join(args.home, 'local-credential'), 'utf8').trim();
  } catch {
    // Fall back to the default local address without a credential.
  }
  const client = new DaemonClient({
    url,
    clientId: 'single-pane-live-verification',
    clientType: 'cli',
    ...(token ? { localCredential: () => token } : {}),
    connectTimeoutMs: 15_000,
    reconnect: { enabled: false },
  });
  await client.connect();
  const api = createPaseoApi(client);
  return { client, api };
}

function makeContext(args, client, api, rec) {
  const rpc = (method, input) => client.invokePluginRpc('flowly', method, input);
  const ctx = { args, client, api, rec, rpc, fx: null, fixture: null, dispatcherState: null, counter: 0, notes: [] };

  ctx.note = (text) => {
    ctx.notes.push(text);
    console.log(`     ${text}`);
  };
  ctx.next = (label) => `${rec.data.runId}-${label}-${++ctx.counter}`;
  ctx.board = () => rpc('board.read', {});
  ctx.title = (text) => `${rec.marker} ${text}`;

  ctx.workspaces = async () => {
    const out = [];
    let cursor;
    do {
      const page = await client.fetchWorkspaces({ page: { limit: 200, cursor } });
      out.push(...page.entries);
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return out.filter((w) => !w.archivedAt);
  };
  ctx.agents = async (includeArchived = false) => {
    const out = [];
    let cursor;
    do {
      const page = await client.fetchAgents({ filter: { includeArchived }, page: { limit: 200, cursor } });
      out.push(...page.entries.map((e) => e.agent));
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return out;
  };
  ctx.agent = async (id) => (await client.fetchAgent(id).catch(() => null))?.agent ?? null;
  ctx.waitIdle = (id, label, timeout = STEP_MS) =>
    waitFor(`${label} to be idle`, async () => {
      const a = await ctx.agent(id);
      if (!a) return false;
      if (a.status === 'error' || a.status === 'closed') throw new Error(`${label} ended with status ${a.status}.`);
      return a.status === 'idle' ? a : false;
    }, { timeout, interval: 3_000 });
  /** The projected timeline of a session as one JSON string per entry (user and assistant text, tool calls). */
  ctx.timeline = async (id) => {
    const page = await client.fetchAgentTimeline(id, { direction: 'tail', limit: 500, projection: 'projected' });
    return (page.entries ?? []).map((e) => ({ type: e.item?.type ?? '', json: JSON.stringify(e.item ?? e) }));
  };
  ctx.items = async () => (await rpc('dispatcher.items-changed', {})).value ?? [];
  ctx.asksOf = async (taskId) => (await ctx.items()).filter((i) => i.kind === 'ask' && i.taskId === taskId);

  ctx.needTinylink = async () => {
    if (ctx.fx) return ctx.fx;
    const board = await ctx.board();
    let id = null;
    const idsFile = args.ids ?? resolve(here, '../promo/ids.json');
    if (existsSync(idsFile)) id = JSON.parse(readFileSync(idsFile, 'utf8'))?.project?.id ?? null;
    let project = id ? board.projects.find((p) => p.id === id) : null;
    project ??= board.projects.find((p) => p.title === 'Tinylink' && !p.archivedAt);
    if (!project) throw new Skip('The Tinylink project is not on the board (docs/promo/setup.mjs creates it; --ids <file> points to its ids).');
    if (project.archivedAt) throw new Skip('The Tinylink project is archived.');
    ctx.fx = { id: project.id, title: project.title, root: project.primaryPath };
    rec.data.tinylinkProjectId = project.id;
    rec.data.tinylinkRoot = project.primaryPath;
    rec.save();
    return ctx.fx;
  };

  /** A throwaway git repository under os.tmpdir() registered as a Flowly project; removed in cleanup. */
  ctx.needFixture = async () => {
    if (ctx.fixture) return ctx.fixture;
    const dir = mkdtempSync(join(tmpdir(), 'single-pane-live-fixture-'));
    rec.addDir(dir); // recorded before anything else uses it
    const real = realpathSync(dir);
    git(['init', '-q', '-b', 'main'], real);
    git(['config', 'user.name', 'Single Pane Live'], real);
    git(['config', 'user.email', 'single-pane-live@example.invalid'], real);
    writeFileSync(join(real, 'README.md'), '# single-pane-live fixture\n');
    git(['add', 'README.md'], real);
    git(['commit', '-q', '-m', 'Initial commit'], real);
    rec.addFixtureProject({ path: real });
    const project = await rpc('projects.create', { title: ctx.title('fixture project'), description: 'Temporary project of the single-pane live checks.', primaryPath: real });
    rec.data.fixtureProjects.find((f) => f.path === real).id = project.id;
    rec.save();
    ctx.fixture = { id: project.id, title: project.title, root: real, revision: project.revision };
    return ctx.fixture;
  };

  /** A card of this run (title prefixed with the marker), recorded as soon as it exists. */
  ctx.makeCard = async (projectId, text, { description = '', mode = 'directory' } = {}) => {
    const task = await rpc('tasks.create', {
      projectId,
      operationId: ctx.next('card'),
      title: ctx.title(text),
      description,
      status: 'todo',
      priority: 'normal',
      mode,
      baseRef: '',
    });
    rec.card(task);
    await ctx.noteBranch(task);
    return task;
  };
  ctx.card = async (id) => (await ctx.board()).tasks.find((t) => t.id === id) ?? null;
  /** Records a worktree card's branch while the worktree still exists, so cleanup can delete the branch this run made. */
  ctx.noteBranch = async (task) => {
    const ws = (await ctx.workspaces()).find((w) => w.id === task.workspaceId);
    if (ws?.workspaceKind === 'worktree' && ws.workspaceDirectory && existsSync(ws.workspaceDirectory)) {
      try {
        const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], ws.workspaceDirectory);
        if (branch && branch !== 'HEAD') rec.branch(task, branch);
      } catch {
        // No branch to record.
      }
    }
  };

  /**
   * Starts a session of this run in a card's workspace the way the drawer's Start session does (tools.prepare-session,
   * the card's MCP credential), with a chosen mode and prompt. The agent id is recorded before the session exists.
   */
  ctx.startSession = async (task, { prompt, modeId, label }) => {
    const prep = await rpc('tools.prepare-session', { id: task.id, operationId: ctx.next(`session-${label}`) });
    rec.addAgent(prep.agentId);
    await api.workspaces.ref(task.workspaceId).agents.create({
      agentId: prep.agentId,
      idempotencyKey: `single-pane-live:${prep.agentId}`,
      title: `${rec.marker} ${label}`,
      labels: { 'flowly-task': task.id, 'flowly-started-by': 'single-pane-live' },
      config: { provider: MODEL, modeId, systemPrompt: prep.instructions, mcpServers: { flowly: prep.mcp } },
      env: { FLOWLY_CONTEXT_FILE: prep.contextFile, FLOWLY_CLI: prep.cliPath, FLOWLY_SKILL: prep.skillPath },
      prompt,
    });
    return prep.agentId;
  };

  /**
   * The dispatcher, for checks 1, 3 and 4. This run messages only a dispatcher it started; an existing one is used
   * only with --use-existing-dispatcher. An ended or missing one is started (Noah's ruling: a new dispatcher only when
   * the old one died or was archived; there is no "start fresh" for a live one).
   */
  ctx.needDispatcher = async () => {
    if (ctx.dispatcherState) return ctx.dispatcherState;
    const status = await rpc('dispatcher.status', {});
    let agentId;
    if (status.state === 'none' || status.state === 'ended') {
      rec.data.dispatcher = { agentId: null, prior: status.agentId, ours: true };
      rec.save(); // recorded before the start
      const started = await rpc('dispatcher.start', {});
      agentId = started.agentId;
      rec.data.dispatcher.agentId = agentId;
      rec.addAgent(agentId);
      ctx.dispatcherState = { agentId, ours: true, prior: status.agentId };
      ctx.note(`started a dispatcher (${agentId}${status.agentId ? `; it replaces ended ${status.agentId}` : ''}).`);
      // A fresh session reads idle before its first turn begins: wait for the board summary, then for the turn to end.
      await waitFor('the dispatcher to receive its board summary', async () => (await ctx.timeline(agentId)).some((e) => e.type === 'user_message' && e.json.includes('Flowly board summary.')), { timeout: 120_000, interval: 3_000 });
    } else {
      if (!args.useExistingDispatcher)
        throw new Skip(`A dispatcher is already running (${status.agentId}, ${status.state}) and this run did not start it; it sends messages only to sessions it created. Archive that dispatcher, or pass --use-existing-dispatcher.`);
      agentId = status.agentId;
      ctx.dispatcherState = { agentId, ours: false, prior: null };
      ctx.note(`using the running dispatcher ${agentId} (--use-existing-dispatcher).`);
    }
    await ctx.waitIdle(agentId, 'the dispatcher', STEP_MS);
    return ctx.dispatcherState;
  };
  ctx.tell = async (agentId, text) => {
    await ctx.waitIdle(agentId, 'the dispatcher');
    await client.sendAgentMessage(agentId, text, { activeTurnBehavior: 'steer' });
  };
  return ctx;
}

// ---- Cleanup (verified) ------------------------------------------------------------------------------------------

/** Cleans up exactly what the record names. Returns { problems: string[], done: string[] }. */
async function cleanup(ctx, { keepDispatcher }) {
  const { client, rpc, rec } = ctx;
  const problems = [];
  const done = [];
  const data = rec.data;
  const guard = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      problems.push(`${label}: ${errText(e)}`);
    }
  };

  // 1. Cards: the recorded ones plus any carrying this run's prefix in a project this run uses (the dispatcher made
  // some). A card outside those projects, or without the prefix, is never touched.
  const projectIds = new Set([data.tinylinkProjectId, ...data.fixtureProjects.map((f) => f.id)].filter(Boolean));
  let board = await ctx.board().catch((e) => {
    problems.push(`board.read: ${errText(e)}`);
    return null;
  });
  if (!board) return { problems, done };
  for (const t of board.tasks)
    if (projectIds.has(t.projectId) && t.title.startsWith(data.marker)) rec.card(t);
  const owned = (id) => data.cards.find((c) => c.id === id && c.title.startsWith(data.marker));
  const cardIds = data.cards.filter((c) => c.title.startsWith(data.marker)).map((c) => c.id);
  const workspaces = new Set(data.cards.flatMap((c) => c.workspaces));
  // A workspace another (not this run's) card refers to is never expected to leave Paseo.
  const shared = new Set(board.tasks.filter((t) => !cardIds.includes(t.id)).flatMap((t) => [t.workspaceId, ...(t.previousWorkspaces ?? []).map((p) => p.id)]));
  for (const id of shared) workspaces.delete(id);

  // 2. Sessions of this run: recorded ids, and sessions in the cards' workspaces that carry a recorded card's label.
  const live = await ctx.agents().catch(() => []);
  const sessionIds = new Set(data.agents);
  for (const a of live) if (cardIds.includes(a.labels?.['flowly-task']) && workspaces.has(a.workspaceId)) sessionIds.add(a.id);
  const dispatcherId = data.dispatcher?.agentId;
  for (const id of sessionIds) {
    if (id === dispatcherId && (!data.dispatcher.ours || keepDispatcher)) continue;
    await guard(`archive session ${id}`, async () => {
      const a = await ctx.agent(id);
      if (!a || a.archivedAt) return;
      if (a.status === 'running' || a.status === 'initializing') {
        await client.cancelAgent(id).catch(() => {});
        await waitFor(`session ${id} to stop`, async () => (await ctx.agent(id))?.status !== 'running', { timeout: 60_000, interval: 2_000 }).catch(() => {});
      }
      await client.archiveAgent(id);
      done.push(`archived session ${id}`);
    });
  }

  // 3. Memory entries first (project removal does not clear them).
  for (const m of data.memory)
    await guard(`delete memory ${m.id}`, async () => {
      const view = (await rpc('memory.read', { projectId: m.projectId })).value;
      const entry = view?.entries?.find((e) => e.id === m.id) ?? view?.candidates?.find((e) => e.id === m.id);
      if (!entry) return;
      await rpc('memory.delete', { id: m.id, revision: entry.revision });
      done.push(`deleted memory entry ${m.id}`);
    });

  // 4. Cards: delete with archive (their sessions and own workspace go to Paseo's archive), then check.
  for (const id of cardIds) {
    await guard(`delete card ${id}`, async () => {
      const card = (await ctx.board()).tasks.find((t) => t.id === id);
      if (!card) return;
      if (!owned(card.id) || !card.title.startsWith(data.marker)) throw new Error('refusing: not a card of this run.');
      if (!projectIds.has(card.projectId)) throw new Error('refusing: not in a project of this run.');
      await ctx.noteBranch(card);
      for (const w of [card.workspaceId, ...(card.previousWorkspaces ?? []).map((p) => p.id)]) if (!shared.has(w)) workspaces.add(w);
      await rpc('tasks.delete', { id, revision: card.revision, archive: true, acknowledgeWarnings: true });
      done.push(`deleted card ${id}`);
    });
  }

  // 5. The fixture projects of this run (Remove, also from Paseo), then their directories.
  for (const f of data.fixtureProjects) {
    await guard(`remove fixture project ${f.id ?? f.path}`, async () => {
      if (!within(f.path, tmpdir()) && !within(f.path, realpathSync(tmpdir()))) throw new Error('refusing: not under the temp directory.');
      const project = (await ctx.board()).projects.find((p) => p.id === f.id || (!f.id && p.primaryPath === f.path));
      if (project) {
        if (project.primaryPath !== f.path) throw new Error('refusing: the project root differs from the record.');
        const result = await rpc('projects.remove', { id: project.id, revision: project.revision, alsoPaseo: true });
        if (result.paseo && !result.paseo.removed) throw new Error(`the Paseo project was not removed: ${result.paseo.error}`);
        done.push(`removed fixture project ${project.id}`);
      }
    });
  }

  // 6. Branches this run made in the Tinylink repository (generated names only, and only when no worktree holds them).
  for (const c of data.cards)
    for (const branch of c.branches) {
      if (!data.tinylinkRoot || !c.title.startsWith(data.marker)) continue;
      await guard(`delete branch ${branch}`, async () => {
        if (!/^kanban\//.test(branch)) return;
        const worktrees = git(['worktree', 'list', '--porcelain'], data.tinylinkRoot);
        if (worktrees.split('\n').some((l) => l === `branch refs/heads/${branch}`)) throw new Error('still checked out in a worktree; left in place.');
        try {
          git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], data.tinylinkRoot);
        } catch {
          return;
        }
        git(['branch', '-D', branch], data.tinylinkRoot);
        done.push(`deleted branch ${branch}`);
      });
    }

  // 7. The dispatcher, when this run started it.
  if (dispatcherId && data.dispatcher.ours && !keepDispatcher)
    await guard(`archive dispatcher ${dispatcherId}`, async () => {
      const a = await ctx.agent(dispatcherId);
      if (a && !a.archivedAt) {
        await client.archiveAgent(dispatcherId);
        done.push(`archived dispatcher ${dispatcherId}`);
      }
    });

  for (const dir of data.tmpDirs)
    await guard(`remove ${dir}`, async () => {
      if (!within(dir, tmpdir()) && !within(dir, realpathSync(tmpdir()))) throw new Error('refusing: not under the temp directory.');
      rmSync(dir, { recursive: true, force: true });
      done.push(`removed ${dir}`);
    });

  // 8. Verify, in both the board and Paseo.
  await guard('verify the board', async () => {
    board = await ctx.board();
    const leftCards = board.tasks.filter((t) => cardIds.includes(t.id));
    if (leftCards.length) throw new Error(`cards still on the board: ${leftCards.map((t) => t.id).join(', ')}`);
    const leftMarked = board.tasks.filter((t) => t.title.startsWith(data.marker));
    if (leftMarked.length) throw new Error(`cards with this run's prefix still on the board: ${leftMarked.map((t) => t.id).join(', ')}`);
    const leftProjects = board.projects.filter((p) => data.fixtureProjects.some((f) => f.id === p.id || f.path === p.primaryPath));
    if (leftProjects.length) throw new Error(`fixture projects still on the board: ${leftProjects.map((p) => p.id).join(', ')}`);
    if (data.tinylinkProjectId && !board.projects.some((p) => p.id === data.tinylinkProjectId)) throw new Error('the Tinylink project is gone from the board.');
  });
  await guard('verify Paseo', async () => {
    const active = await ctx.workspaces();
    const leftWs = active.filter((w) => workspaces.has(w.id) || data.fixtureProjects.some((f) => w.workspaceDirectory && within(w.workspaceDirectory, f.path)));
    if (leftWs.length) throw new Error(`workspaces still active in Paseo: ${leftWs.map((w) => `${w.id} (${w.workspaceKind})`).join(', ')}`);
    const stillLive = [];
    for (const id of sessionIds) {
      if (id === dispatcherId && (!data.dispatcher.ours || keepDispatcher)) continue;
      const a = await ctx.agent(id);
      if (a && !a.archivedAt) stillLive.push(id);
    }
    if (stillLive.length) throw new Error(`sessions still live in Paseo: ${stillLive.join(', ')}`);
    for (const dir of data.tmpDirs) if (existsSync(dir)) throw new Error(`${dir} still exists`);
  });
  return { problems, done };
}

// ---- Check 1: the dispatcher starts a card -----------------------------------------------------------------------

async function checkDispatcherStartsCard(ctx) {
  const fx = await ctx.needTinylink();
  const d = await ctx.needDispatcher();
  const status = await ctx.rpc('dispatcher.status', {});
  if (status.state === 'running' || status.state === 'idle') {
    await expectRejection('a second dispatcher.start', () => ctx.rpc('dispatcher.start', {}), /DISPATCHER_RUNNING|already running/i);
    ctx.note('a second dispatcher.start is refused while one runs (one long-lived dispatcher).');
  }
  if (d.ours && d.prior) {
    // Ruling 2026-11-08 (final fix round): a new dispatcher replaces a dead one, which Flowly then archives.
    const old = await waitFor('the dead dispatcher to be archived', async () => {
      const a = await ctx.agent(d.prior);
      return !a || a.archivedAt ? true : false;
    }, { timeout: 30_000 }).catch((e) => {
      throw new Error(`the ended dispatcher ${d.prior} was not archived when the new one started (needs the final fix round): ${errText(e)}`);
    });
    if (old) ctx.note(`the ended dispatcher ${d.prior} is archived.`);
  }

  const title = ctx.title('check 1: add CHECK-1.txt');
  await ctx.tell(
    d.agentId,
    `Make a card in project ${fx.id} (${fx.title}) and start it. The card's title must be exactly "${title}". Its work: create a file named CHECK-1.txt containing the word ok, then stop; nothing else. Use flowly_create_card and flowly_start_card, then reply "started" with the card id.`,
  );
  const card = await waitFor('the dispatcher to create the card', async () => (await ctx.board()).tasks.find((t) => t.projectId === fx.id && t.title === title) ?? false, { timeout: STEP_MS, interval: 3_000 });
  ctx.rec.card(card);
  // The session starts a moment later: wait for it, then for the card to sit in a worktree.
  const session = await waitFor('the card to have a session in a worktree workspace', async () => {
    const current = await ctx.card(card.id);
    if (!current) return false;
    ctx.rec.card(current);
    const ws = (await ctx.workspaces()).find((w) => w.id === current.workspaceId);
    if (ws?.workspaceKind !== 'worktree') return false;
    const a = (await ctx.agents()).find((x) => x.labels?.['flowly-task'] === current.id && x.workspaceId === current.workspaceId);
    return a ? { agent: a, ws, current } : false;
  }, { timeout: STEP_MS, interval: 3_000 });
  await ctx.noteBranch(session.current);
  if (session.agent.labels['flowly-task'] !== card.id) throw new Error('the session label flowly-task does not name the card.');
  ctx.note(`card ${card.id}: session ${session.agent.id} runs in worktree workspace ${session.ws.id} (label flowly-task=${card.id}).`);
  // Q2(b): a card the dispatcher made starts in a directory workspace; start_card moves it to a worktree and archives the empty directory workspace.
  const previous = session.current.previousWorkspaces ?? [];
  if (previous.length) {
    const stillActive = (await ctx.workspaces()).filter((w) => previous.some((p) => p.id === w.id));
    if (stillActive.length) throw new Error(`the card's earlier directory workspace is still active: ${stillActive.map((w) => w.id).join(', ')}.`);
    ctx.note(`the earlier directory workspace ${previous.map((p) => p.id).join(', ')} is archived.`);
  }
}

// ---- Check 2: asks -----------------------------------------------------------------------------------------------

const askPrompts = {
  permission:
    'single-pane-live check. Use the Bash tool to run exactly: touch SINGLE-PANE-LIVE-PERMISSION.txt . Then reply with exactly DONE-PERMISSION. Do nothing else and call no Flowly tool.',
  askUser:
    'single-pane-live check. Use the AskUserQuestion tool to ask exactly one question, "Pick a colour", with header "Colour" and two options, "Red" and "Blue". After I answer, reply with exactly CHOSEN=<the label I picked>. Do nothing else and call no Flowly tool.',
  question:
    'single-pane-live check. Call flowly_get_task, then flowly_report_progress with kind "question", text "single-pane-live: which name should I use?" and nextMoves []. Then stop and wait for my answer. Do nothing else.',
};

async function openAsk(ctx, taskId, kind, label) {
  return waitFor(`the ${label} ask in dispatcher.items-changed`, async () => (await ctx.asksOf(taskId)).find((a) => a.askKind === kind && a.state === 'open') ?? false, { timeout: 5 * 60_000, interval: 3_000 });
}
const answerItem = async (ctx, signal) => (await ctx.items()).find((i) => i.kind === 'answer' && i.signal === signal);

async function checkAsks(ctx) {
  const fx = await ctx.needTinylink();
  const card = await ctx.makeCard(fx.id, 'check 2: asks', { description: 'Temporary card of the single-pane live checks.', mode: 'worktree' });
  const dir = (await ctx.workspaces()).find((w) => w.id === card.workspaceId)?.workspaceDirectory;
  const sessions = {
    permission: await ctx.startSession(card, { prompt: askPrompts.permission, modeId: 'default', label: 'permission' }),
    askUser: await ctx.startSession(card, { prompt: askPrompts.askUser, modeId: 'default', label: 'ask-user' }),
    question: await ctx.startSession(card, { prompt: askPrompts.question, modeId: 'bypassPermissions', label: 'question' }),
  };
  const asks = {
    permission: await openAsk(ctx, card.id, 'permission', 'permission'),
    askUser: await openAsk(ctx, card.id, 'ask_user', 'AskUserQuestion'),
    question: await openAsk(ctx, card.id, 'question_report', 'Flowly question'),
  };
  ctx.note('a permission, an AskUserQuestion and a Flowly question are all open in dispatcher.items-changed.');
  for (const [kind, ask] of Object.entries(asks)) {
    if (ask.agentId !== sessions[kind]) throw new Error(`the ${kind} ask belongs to session ${ask.agentId}, expected ${sessions[kind]}.`);
    if (await answerItem(ctx, ask.signal)) throw new Error(`the ${kind} ask shows a tick before it was answered.`);
  }

  // Permission: choose a plain Allow (never "always" or a deny), then the command must have run.
  const permissionOption =
    asks.permission.options?.find((o) => o.id === 'allow') ??
    asks.permission.options?.find((o) => /^(allow|yes|approve)\b/i.test(o.label) && !/always|session|don'?t|deny|no\b/i.test(o.label));
  if (!permissionOption) throw new Error(`the permission ask has no plain Allow option: ${JSON.stringify(asks.permission.options)}.`);
  let result = await ctx.rpc('asks.answer', { signal: asks.permission.signal, answer: { optionIds: [permissionOption.id] } });
  if (!result.delivered || result.state !== 'answered') throw new Error(`answering the permission gave ${JSON.stringify(result)}.`);
  const tick = await answerItem(ctx, asks.permission.signal);
  if (!tick?.delivered) throw new Error('no delivered tick after the permission answer.');
  await ctx.waitIdle(sessions.permission, 'the permission session');
  if (dir && !existsSync(join(dir, 'SINGLE-PANE-LIVE-PERMISSION.txt'))) throw new Error('the permission was answered, but the command did not run (no SINGLE-PANE-LIVE-PERMISSION.txt in the worktree).');
  ctx.note(`permission "${permissionOption.label}" delivered; the command ran.`);

  // AskUserQuestion: choose Blue; the session's reply carries it.
  const blue = asks.askUser.options?.find((o) => /blue/i.test(o.label));
  if (!blue) throw new Error(`the AskUserQuestion ask has no "Blue" option: ${JSON.stringify(asks.askUser.options)}.`);
  result = await ctx.rpc('asks.answer', { signal: asks.askUser.signal, answer: { optionIds: [blue.id] } });
  if (!result.delivered || result.state !== 'answered') throw new Error(`answering the AskUserQuestion gave ${JSON.stringify(result)}.`);
  if (!(await answerItem(ctx, asks.askUser.signal))?.delivered) throw new Error('no delivered tick after the AskUserQuestion answer.');
  await ctx.waitIdle(sessions.askUser, 'the AskUserQuestion session');
  if (!(await ctx.timeline(sessions.askUser)).some((e) => e.json.includes('CHOSEN=Blue'))) throw new Error('the session did not report CHOSEN=Blue after the answer.');
  ctx.note('AskUserQuestion resolved with "Blue" and the session answered CHOSEN=Blue.');

  // Flowly question: the typed text arrives as the user's message.
  const text = `single-pane-live-answer-${ctx.rec.data.runId}`;
  result = await ctx.rpc('asks.answer', { signal: asks.question.signal, answer: { text } });
  if (!result.delivered || result.state !== 'answered') throw new Error(`answering the question gave ${JSON.stringify(result)}.`);
  if (!(await answerItem(ctx, asks.question.signal))?.delivered) throw new Error('no delivered tick after the question answer.');
  await waitFor('the answer in the session transcript', async () => (await ctx.timeline(sessions.question)).some((e) => e.type === 'user_message' && e.json.includes(text)), { timeout: 60_000 });
  ctx.note('the question answer is in the session transcript as the user message.');

  // A replayed answer never reaches the session again.
  result = await ctx.rpc('asks.answer', { signal: asks.question.signal, answer: { text: `${text}-again` } });
  if (result.delivered) throw new Error('a second answer to the same ask was delivered.');
  if ((await ctx.timeline(sessions.question)).some((e) => e.json.includes(`${text}-again`))) throw new Error('a second answer reached the session.');

  // An ended session: answer gives session_ended, no tick.
  const ending = await ctx.startSession(card, { prompt: askPrompts.permission, modeId: 'default', label: 'ended' });
  const endedAsk = await waitFor('the ask of the session to be ended', async () => (await ctx.asksOf(card.id)).find((a) => a.agentId === ending && a.state === 'open') ?? false, { timeout: 5 * 60_000, interval: 3_000 });
  await ctx.client.archiveAgent(ending);
  result = await ctx.rpc('asks.answer', { signal: endedAsk.signal, answer: { optionIds: [endedAsk.options?.[0]?.id ?? 'allow'] } });
  if (result.delivered || result.state !== 'session_ended') throw new Error(`answering an ended session gave ${JSON.stringify(result)}, expected delivered false and session_ended.`);
  const stray = await answerItem(ctx, endedAsk.signal);
  if (stray?.delivered) throw new Error('a delivered tick appeared for an ended session.');
  ctx.note('answering an ended session gives session_ended and no tick.');
}

// ---- Check 3: notes ----------------------------------------------------------------------------------------------

const noteCount = async (ctx, taskId) => (await ctx.items()).filter((i) => i.kind === 'note' && i.note?.taskId === taskId).length;
const messagesAbout = async (ctx, dispatcherId, taskId) =>
  (await ctx.timeline(dispatcherId)).filter((e) => e.type === 'user_message' && e.json.includes('Flowly board update (') && e.json.includes(`[${taskId}]`)).length;

async function checkNotes(ctx) {
  const fx = await ctx.needTinylink();
  const d = await ctx.needDispatcher();
  const card = await ctx.makeCard(fx.id, 'check 3: status change', { description: 'Temporary card of the single-pane live checks.' });
  const before = { notes: await noteCount(ctx, card.id), messages: await messagesAbout(ctx, d.agentId, card.id) };
  if (before.notes || before.messages) throw new Error('the new card already has notes.');
  await ctx.rpc('tasks.update', { id: card.id, revision: card.revision, status: 'blocked', actor: 'human', note: 'single-pane-live: status change for the note check' });
  await waitFor('the note item for the card', async () => (await noteCount(ctx, card.id)) >= 1, { timeout: 3 * 60_000, interval: 3_000 });
  await waitFor('the note message in the dispatcher timeline', async () => (await messagesAbout(ctx, d.agentId, card.id)) >= 1, { timeout: 60_000, interval: 3_000 });
  await sleep(NOTE_SETTLE_MS);
  const after = { notes: await noteCount(ctx, card.id), messages: await messagesAbout(ctx, d.agentId, card.id) };
  if (after.notes !== 1 || after.messages !== 1) throw new Error(`expected one note and one batched message for the status change, got ${after.notes} note item(s) and ${after.messages} message(s).`);
  ctx.note('one status change gave one note item and one batched user message.');

  // The dispatcher's own create produces no note for its card.
  const title = ctx.title('check 3: made by the dispatcher');
  await ctx.tell(d.agentId, `Create one card in project ${fx.id} (${fx.title}) with exactly this title: "${title}". Do not start it. Then reply "created".`);
  const own = await waitFor('the dispatcher to create its card', async () => (await ctx.board()).tasks.find((t) => t.projectId === fx.id && t.title === title) ?? false, { timeout: STEP_MS, interval: 3_000 });
  ctx.rec.card(own);
  await ctx.waitIdle(d.agentId, 'the dispatcher');
  await sleep(NOTE_SETTLE_MS);
  const ownNotes = await noteCount(ctx, own.id);
  const ownMessages = await messagesAbout(ctx, d.agentId, own.id);
  if (ownNotes || ownMessages) throw new Error(`the dispatcher's own create produced ${ownNotes} note item(s) and ${ownMessages} message(s).`);
  ctx.note("the dispatcher's own create produced no note.");
}

// ---- Check 4: split and wrap-up ----------------------------------------------------------------------------------

async function checkSplitAndWrapUp(ctx) {
  const fx = await ctx.needTinylink();
  const d = await ctx.needDispatcher();
  const titles = [ctx.title('check 4 A: add A.txt'), ctx.title('check 4 B: add B.txt')];
  await ctx.tell(
    d.agentId,
    `Here is a plan for project ${fx.id} (${fx.title}) with two independent deliverables: (A) add a file A.txt containing "a"; (B) add a file B.txt containing "b". Neither needs the other. Make one card for each, with exactly these titles: "${titles[0]}" and "${titles[1]}", and start both. Do not do the work yourself. Reply "started" when both are running.`,
  );
  const cards = [];
  for (const title of titles) {
    const found = await waitFor(`the card "${title}"`, async () => (await ctx.board()).tasks.find((t) => t.projectId === fx.id && t.title === title) ?? false, { timeout: STEP_MS, interval: 3_000 });
    ctx.rec.card(found);
    cards.push(found);
  }
  const placed = [];
  for (const card of cards) {
    placed.push(
      await waitFor(`${card.id} to run in its own worktree`, async () => {
        const current = await ctx.card(card.id);
        ctx.rec.card(current);
        const ws = (await ctx.workspaces()).find((w) => w.id === current.workspaceId);
        if (ws?.workspaceKind !== 'worktree') return false;
        const agent = (await ctx.agents()).find((x) => x.labels?.['flowly-task'] === current.id && x.workspaceId === current.workspaceId);
        return agent ? { current, ws, agent } : false;
      }, { timeout: STEP_MS, interval: 3_000 }),
    );
  }
  for (const p of placed) await ctx.noteBranch(p.current);
  if (placed[0].ws.id === placed[1].ws.id) throw new Error('both cards share one workspace.');
  if (placed[0].agent.id === placed[1].agent.id) throw new Error('both cards share one session.');
  ctx.note(`two cards, two worktrees (${placed[0].ws.id}, ${placed[1].ws.id}), two sessions.`);

  // Wrap up one card: stop its session, move it to Done, wrap up; its worktree leaves Paseo's active list.
  const target = placed[0];
  await ctx.client.cancelAgent(target.agent.id).catch(() => {});
  await waitFor('the session to stop', async () => (await ctx.agent(target.agent.id))?.status !== 'running', { timeout: 120_000, interval: 3_000 });
  const fresh = await ctx.card(target.current.id);
  const done = await ctx.rpc('tasks.update', { id: fresh.id, revision: fresh.revision, status: 'done', actor: 'human' });
  const check = await ctx.rpc('tasks.wrapup-check', { id: done.id });
  if (check.blockers?.length) throw new Error(`wrap-up is blocked: ${JSON.stringify(check.blockers)}.`);
  if (!check.archiveWorkspace) throw new Error(`wrap-up would not archive the card's worktree workspace (${JSON.stringify(check.workspace)}).`);
  const wrapped = await ctx.rpc('tasks.wrapup', { id: done.id, revision: done.revision, acknowledgeWarnings: true, keepCard: true });
  if (!wrapped.archivedWorkspace) throw new Error(`wrap-up reported no archived workspace: ${wrapped.note}`);
  await waitFor('the worktree workspace to leave Paseo', async () => !(await ctx.workspaces()).some((w) => w.id === target.ws.id), { timeout: 60_000, interval: 3_000 });
  const other = (await ctx.workspaces()).some((w) => w.id === placed[1].ws.id);
  if (!other) throw new Error("wrapping up one card also removed the other card's workspace.");
  ctx.note(`wrap-up archived workspace ${target.ws.id} and left ${placed[1].ws.id} alone.`);
}

// ---- Checks 5 and 6: import and export on the fixture project ----------------------------------------------------

function backlogText(ctx) {
  const wanted = ctx.args.backlog ?? join(process.env.FLOWLY_BACKLOG_DIR || join(homedir(), '.claude', 'backlogs'), 'zenlytic.md');
  if (existsSync(wanted)) return { text: readFileSync(wanted, 'utf8'), source: wanted };
  if (ctx.args.backlog) throw new Skip(`--backlog ${wanted} does not exist.`);
  const synthetic = resolve(here, '../../shared/fixtures/backlogs/recipes.md');
  ctx.note(`the real backlog (${wanted}) is not here; using the synthetic fixture.`);
  return { text: readFileSync(synthetic, 'utf8'), source: synthetic };
}

async function checkImport(ctx) {
  const fx = await ctx.needFixture();
  const { text, source } = backlogText(ctx);
  const preview = await ctx.rpc('ideas.import-preview', { projectId: fx.id, markdown: text });
  const dup = new Set(preview.duplicates);
  const kept = preview.rows.filter((r, i) => r.keep && !dup.has(i));
  const keptDuplicates = preview.rows.filter((r, i) => r.keep && dup.has(i)).length;
  if (!kept.length) throw new Error(`no importable rows in ${source}.`);
  const operationId = ctx.next('import');
  const result = await ctx.rpc('ideas.import', { projectId: fx.id, rows: kept, operationId });
  if (result.created !== kept.length) throw new Error(`kept ${kept.length} rows, created ${result.created} ideas; skipped: ${JSON.stringify(result.skipped.slice(0, 5))}.`);
  if (result.skipped.length) throw new Error(`rows were skipped: ${JSON.stringify(result.skipped.slice(0, 5))}.`);
  const open = ((await ctx.rpc('projects.ideas-changed', { projectId: fx.id })).value?.ideas ?? []).filter((i) => i.status === 'open' && !i.taskId);
  if (open.length !== kept.length) throw new Error(`the project shows ${open.length} open project ideas, expected ${kept.length}.`);
  const replay = await ctx.rpc('ideas.import', { projectId: fx.id, rows: kept, operationId });
  if (replay.created !== result.created) throw new Error('replaying the same operationId gave a different result.');
  ctx.note(`${source}: ${preview.rows.length} items, ${kept.length} kept (${keptDuplicates} repeated in the paste), ${result.created} ideas created; the replay returned the first result.`);
}

async function checkExport(ctx) {
  const fx = await ctx.needFixture();
  const card = await ctx.makeCard(fx.id, 'export card', { description: 'First line of the export card.\nSecond line.' });
  const ideaTitle = ctx.title('export idea');
  await ctx.rpc('ideas.create-project', { projectId: fx.id, idea: { title: ideaTitle, detail: 'Detail of the export idea.', rationale: 'Seeded by the single-pane live checks.' } });
  const memoryTitle = ctx.title('export memory');
  const entry = await ctx.rpc('memory.create', { projectId: fx.id, kind: 'convention', title: memoryTitle, body: 'Seeded by the single-pane live checks.', pinned: false });
  ctx.rec.addMemory({ projectId: fx.id, id: entry.id });
  if (entry.status !== 'active') throw new Error(`the seeded memory entry is "${entry.status}", not active; the export lists active entries only.`);
  const { markdown } = await ctx.rpc('board.export-markdown', { projectId: fx.id });
  const section = markdown.split(/^## /m).find((s) => s.startsWith(fx.title));
  if (!section) throw new Error(`no "## ${fx.title}" section in the export.`);
  const missing = [];
  if (!section.includes('### Open cards') || !section.includes(`- ${card.title} (${card.status}, ${card.id})`)) missing.push('the open card');
  if (!section.includes('### Ideas') || !section.includes(`- [ ] ${ideaTitle}`)) missing.push('the idea');
  if (!section.includes('### Memory') || !section.includes(`- ${memoryTitle}`)) missing.push('the memory entry');
  if (missing.length) throw new Error(`the fixture section lacks ${missing.join(', ')}:\n${section}`);
  const all = await ctx.rpc('board.export-markdown', {});
  if (!all.markdown.includes(`## ${fx.title}`)) throw new Error('the export of all projects lacks the fixture project.');
  ctx.note('the fixture section lists its card, idea and memory entry (single project and all projects).');
}

// ---- Check 7: the bell --------------------------------------------------------------------------------------------

const openAskCount = async (ctx) => (await ctx.items()).filter((i) => i.kind === 'ask' && i.state === 'open').length;
/** The bell's count and the chat's open asks, read until they agree (other cards may change in between). */
async function parity(ctx, label, expected) {
  let last = {};
  await waitFor(`${label}: the bell count to equal the open asks${expected === undefined ? '' : ` (${expected})`}`, async () => {
    const bell = (await ctx.rpc('attention.count', {})).count;
    const chat = await openAskCount(ctx);
    last = { bell, chat };
    return bell !== null && bell === chat && (expected === undefined || chat === expected) ? last : false;
  }, { timeout: 45_000, interval: 2_500 }).catch((e) => {
    throw new Error(`${errText(e)} Last read: bell ${last.bell}, chat ${last.chat}.`);
  });
  return last;
}

async function checkBell(ctx) {
  const fx = await ctx.needTinylink();
  const card = await ctx.makeCard(fx.id, 'check 7: bell', { description: 'Temporary card of the single-pane live checks.', mode: 'worktree' });
  const base = await parity(ctx, 'before the asks');
  const first = await ctx.startSession(card, { prompt: askPrompts.permission, modeId: 'default', label: 'bell-1' });
  const askOne = await waitFor('the first ask', async () => (await ctx.asksOf(card.id)).find((a) => a.agentId === first && a.state === 'open') ?? false, { timeout: 5 * 60_000, interval: 3_000 });
  const withOne = await parity(ctx, 'with one ask');
  if (withOne.chat <= base.chat) throw new Error(`the open asks did not grow with a pending permission (${base.chat} → ${withOne.chat}).`);
  ctx.note(`bell ${withOne.bell} = chat ${withOne.chat} with the fixture ask open (baseline ${base.chat}).`);

  // Dismiss in the chat: the bell drops by one.
  await ctx.rpc('asks.dismiss', { signal: askOne.signal });
  const afterChat = await parity(ctx, 'after dismissing in the chat', withOne.chat - 1);
  ctx.note('dismissing in the chat lowered the bell by one.');

  // Dismiss in the bell: the chat's ask turns dismissed and the count drops by one.
  const second = await ctx.startSession(card, { prompt: askPrompts.permission, modeId: 'default', label: 'bell-2' });
  const askTwo = await waitFor('the second ask', async () => (await ctx.asksOf(card.id)).find((a) => a.agentId === second && a.state === 'open') ?? false, { timeout: 5 * 60_000, interval: 3_000 });
  const withTwo = await parity(ctx, 'with the second ask');
  if (withTwo.chat <= afterChat.chat) throw new Error(`the open asks did not grow with the second permission (${afterChat.chat} → ${withTwo.chat}).`);
  await ctx.rpc('attention.dismiss', { taskId: card.id, signals: [askTwo.signal] });
  await waitFor('the chat ask to read dismissed', async () => (await ctx.asksOf(card.id)).find((a) => a.signal === askTwo.signal)?.state === 'dismissed', { timeout: 30_000 });
  await parity(ctx, 'after dismissing in the bell', withTwo.chat - 1);
  ctx.note('dismissing in the bell turned the chat ask dismissed and the counts still agree.');
}

// ---- Runner -------------------------------------------------------------------------------------------------------

export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`${e.message}\n`);
    console.error(helpText());
    return 64;
  }
  if (args.help) {
    console.log(helpText());
    return 0;
  }
  process.env.FLOWLY_TELEMETRY = '0';

  const { client, api } = await connect(args);
  const rec = args.cleanup ? Record.load(args.cleanup) : Record.fresh(randomBytes(3).toString('hex'));
  const ctx = makeContext(args, client, api, rec);
  console.log(`single-pane live checks, run ${rec.data.runId}; record ${rec.file}`);
  let code = 0;
  try {
    const telemetry = await ctx.rpc('telemetry.status', {}).catch(() => null);
    if (telemetry && !telemetry.forcedOff && !telemetry.builtOff) console.log('NOTE the daemon does not force telemetry off; start it with FLOWLY_TELEMETRY=0.');
    if (args.cleanup) {
      const { problems, done } = await cleanup(ctx, { keepDispatcher: args.keepDispatcher });
      done.forEach((d) => console.log(`  ${d}`));
      problems.forEach((p) => console.log(`CLEANUP PROBLEM ${p}`));
      return problems.length ? 1 : 0;
    }
    const selected = CHECKS.filter((c) => !args.only || args.only.has(c.id));
    const results = [];
    for (const check of selected) {
      console.log(`\n[${check.id}] ${check.title}`);
      ctx.notes = [];
      try {
        await check.run(ctx);
        results.push({ id: check.id, status: 'PASS' });
        console.log(`PASS ${check.id}`);
      } catch (e) {
        if (e instanceof Skip) {
          results.push({ id: check.id, status: 'SKIP', reason: e.message });
          console.log(`SKIP ${check.id} ${e.message}`);
        } else {
          results.push({ id: check.id, status: 'FAIL', reason: errText(e) });
          console.log(`FAIL ${check.id} ${errText(e)}${check.needsFinalFix ? `\n     (this check needs the final fix round: ${check.needsFinalFix})` : ''}`);
        }
      }
    }
    console.log('\nCleaning up what this run created …');
    const { problems, done } = await cleanup(ctx, { keepDispatcher: args.keepDispatcher });
    done.forEach((d) => console.log(`  ${d}`));
    console.log(problems.length ? problems.map((p) => `CLEANUP PROBLEM ${p}`).join('\n') : 'CLEANUP verified in the board and in Paseo.');
    if (problems.length) console.log(`Retry with: node docs/verification/single-pane-live.mjs --cleanup ${rec.file}`);
    console.log('\nSummary');
    for (const r of results) console.log(`  ${r.status.padEnd(4)} ${r.id}${r.reason ? `  ${r.reason.split('\n')[0]}` : ''}`);
    if (results.some((r) => r.status === 'FAIL') || problems.length) code = 1;
    else if (results.some((r) => r.status === 'SKIP')) code = 2;
  } finally {
    await api.dispose?.().catch(() => {});
    await client.close().catch(() => {});
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(await main(process.argv.slice(2)));
}
