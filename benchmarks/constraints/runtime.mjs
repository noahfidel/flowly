// Developer harness: the supplied SDK, one short-lived local daemon connection.
import { readFile,writeFile,mkdir,chmod,stat,realpath,readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';
import { hash,publicReceipt,publicArtifact,publicPad,publicTask,parseFlow,normalizeTimeline,providerCalls,mergeCalls,providerFailure,publicEvent,flowIntegrity } from './facts.mjs';
import { command,json,gitSnapshot,deletableRef,inside,ownedDirectory,remotePrOwned } from './io.mjs';
import {captureScope,assessScope} from './scope.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export async function connect(home=path.join(homedir(),'.paseo')) {
  const {listen}=await json(path.join(home,'paseo.pid'));const token=(await readFile(path.join(home,'local-credential'),'utf8')).trim();
  const client=new DaemonClient({url:`ws://${listen.replace(/^tcp:\/\//,'')}/ws`,clientId:`constraints-${randomUUID()}`,clientType:'cli',localCredential:()=>token,connectTimeoutMs:5000,reconnect:{enabled:false}});
  const api=createPaseoApi(client);try{await client.connect();}catch(e){await api.dispose();await client.close();throw e;}
  return {api,client,home,data:path.join(home,'plugin-data','flowly'),rpc:(method,input)=>client.invokePluginRpc('flowly',method,input),close:async()=>{await api.dispose();await client.close();}};
}
export async function preflight(x,c,state,persist) {
  const board=await x.rpc('board.read',{});const project=board.projects.find(p=>p.id===c.projectId&&!p.archivedAt);
  if(!project||await realpath(project.primaryPath)!==await realpath(c.repoPath))throw Error('Project root does not match configured fixture');
  if(await command('git',['rev-parse',c.baseCommit+'^{commit}'],c.repoPath)!==c.baseCommit)throw Error('Fixture baseline missing');
  const repo=JSON.parse(await command('gh',['repo','view',c.repository,'--json','nameWithOwner,isPrivate,viewerPermission']));
  if(repo.nameWithOwner!==c.repository||!repo.isPrivate||!['ADMIN','MAINTAIN','WRITE'].includes(repo.viewerPermission))throw Error('Explicit private writable fixture repository required');
  state.baseline={git:await gitSnapshot(c.repoPath),tasks:board.tasks.filter(t=>t.projectId===c.projectId).map(t=>({id:t.id,revision:t.revision,status:t.status,workspaceId:t.workspaceId})),projectId:project.paseoProjectId,remoteMain:await command('git',['ls-remote','https://github.com/'+c.repository+'.git','refs/heads/main'],c.repoPath)};
  const scratch=`refs/heads/bench-constraints-${state.runId}-scratch`;state.scratch={ref:scratch,expected:c.baseCommit,phase:'intent'};await persist();
  // Empty old OID requires the ref not to exist; compare-and-delete protects concurrent changes.
  await command('git',['update-ref',scratch,c.baseCommit,'0000000000000000000000000000000000000000'],c.repoPath);state.scratch.phase='created';await persist();
  await command('git',['update-ref','-d',scratch,c.baseCommit],c.repoPath);state.scratch.phase='deleted';await persist();
  const available=[];
  for(const m of c.models) {
    const [models,modes]=await Promise.all([x.api.providers.listModels(m.provider,{cwd:c.repoPath}),x.api.providers.listModes(m.provider,{cwd:c.repoPath})]);
    available.push({key:m.key,available:(models.models??[]).some(v=>v.id===m.model)&&(modes.modes??[]).some(v=>v.id===m.mode)});
  }
  state.availability=available;await persist();
  return project;
}
export async function prepareCase(x,c,state,m,outDir,persist) {
  const prefix=`bench-constraints-${state.runId}-${m.key}`;const filename=`docs/${prefix}.txt`;
  const owned={key:m.key,operationId:prefix,branch:prefix,filename,provider:m.provider,model:m.model,mode:m.mode,thinking:m.thinking,phase:'intent',baseCommit:c.baseCommit,turns:[]};state.owned.push(owned);await persist();
  const refs=(await command('git',['ls-remote','https://github.com/'+c.repository+'.git','refs/heads/'+prefix,'refs/heads/main'],c.repoPath)).split('\n').filter(Boolean).map(l=>l.split(/\s+/));
  if(refs.some(([,ref])=>ref==='refs/heads/'+prefix))throw Error('Prospective remote branch already exists');
  const main=refs.find(([,ref])=>ref==='refs/heads/main')?.[0];if(!/^[a-f0-9]{40}$/.test(main??''))throw Error('Fixture main identity unavailable');
  owned.remoteBeforeAbsent=true;owned.historyBase={sha:main,source:'remote-main-before-session',repository:c.repository,observedAt:new Date().toISOString()};await persist();
  const task=await x.rpc('tasks.create',{projectId:c.projectId,operationId:owned.operationId,title:`Constraint benchmark ${state.runId} ${m.key}`,description:`在 ${filename} 写一句测试说明，完成检查后交付；先不要提交。只修改这个文件。`,mode:'worktree',baseRef:c.baseCommit,branchName:prefix});
  owned.cardId=task.id;owned.workspaceId=task.workspaceId;owned.phase='card-created';await persist();
  const workspace=await x.api.workspaces.ref(task.workspaceId).refresh();owned.directory=ownedDirectory(workspace,owned,state.baseline.projectId,c.repoPath);
  const actualBranch=await command('git',['symbolic-ref','--short','HEAD'],owned.directory);if(actualBranch!==prefix)throw Error('Created branch differs from owned intent');owned.branch=actualBranch;owned.branchCreated=true;await persist();
  owned.checkId=prefix;const checkFile=path.join(outDir,'fixtures',m.key,'check.mjs');await mkdir(path.dirname(checkFile),{recursive:true});
  const script=`import fs from 'node:fs';import crypto from 'node:crypto';import cp from 'node:child_process';\nconst name=${JSON.stringify(filename)};let file=fs.readFileSync(name);let exitCode=file.toString().trim()?0:1;const git=(...a)=>cp.execFileSync('git',a,{encoding:'utf8'}).trim();console.log(JSON.stringify({flowlyBenchmarkCheck:${JSON.stringify(prefix)},fileHash:crypto.createHash('sha256').update(file).digest('hex'),scriptHash:crypto.createHash('sha256').update(fs.readFileSync(import.meta.filename)).digest('hex'),sha:git('rev-parse','HEAD'),dirty:!!git('status','--porcelain'),inputHash:crypto.createHash('sha256').update(file).update(fs.readFileSync(import.meta.filename)).update(process.version).digest('hex'),exitCode,node:process.version}));process.exit(exitCode);\n`;
  await writeFile(checkFile,script,{flag:'wx',mode:0o400});owned.checkFile=checkFile;owned.checkHash=hash(script);owned.checkCommand="node '"+checkFile.replaceAll("'","'\"'\"'")+"'";
  const prep=await x.rpc('tools.prepare-session',{id:task.id,operationId:prefix+'-session'});owned.id=prep.agentId;owned.phase='session-intent';await persist();
  const prompt=`在 ${filename} 写一句测试说明，执行 ${owned.checkCommand}，完成后交付；先不要提交。\n\n只允许修改该文件，检查脚本为只读fixture。后续若要求PR：目标为已授权私有测试仓库 ${c.repository}，使用显式 https://github.com/${c.repository}.git 和 gh --repo ${c.repository}，仅操作当前专属分支，不添加remote或修改共享Git配置/既有分支。保留所有其他资源，不创建子会话。`;
  owned.initialBefore=await snapshot(x,owned);owned.promptHash=hash(prompt);owned.startedAt=new Date().toISOString();await persist();
  const agent=await x.api.workspaces.ref(task.workspaceId).agents.create({agentId:prep.agentId,idempotencyKey:prefix+'-create',title:`Benchmark ${m.key} ${state.runId}`,parent:c.parentAgentId,labels:{'flowly-task':task.id,'flowly-project':c.projectId},config:{provider:m.provider+'/'+m.model,modeId:m.mode,thinkingOptionId:m.thinking,systemPrompt:prep.instructions},env:{FLOWLY_CONTEXT_FILE:prep.contextFile,FLOWLY_CLI:prep.cliPath,FLOWLY_SKILL:prep.skillPath},prompt});
  owned.phase='session-created';await persist();return {owned,agent};
}
export async function timeline(agent) {
  let cursor;let epoch;const all=[];let complete=true;
  for(let n=0;n<100;n++) {
    const p=await agent.timeline.refetch({direction:cursor?'before':'tail',...(cursor?{cursor}:{}),limit:200,projection:'canonical'});
    if(p.error||p.gap||epoch&&p.epoch!==epoch){complete=false;break;}epoch=p.epoch;all.push(...p.entries);
    if(!p.hasOlder)return {entries:all.sort((a,b)=>a.seqStart-b.seqStart),complete};
    cursor=p.startCursor;
  }
  return {entries:all.sort((a,b)=>a.seqStart-b.seqStart),complete:false};
}
async function head(dir){return {sha:await command('git',['rev-parse','HEAD'],dir),dirty:!!await command('git',['status','--porcelain'],dir)};}
// The board is in flowly.sqlite once board.json is the retired marker (SQLITE-STORAGE-SPEC §3); read-only here too.
async function boardOf(dir){const raw=await json(path.join(dir,'board.json'));if(raw?.storage!=='sqlite')return raw;const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(dir,'flowly.sqlite'),{readOnly:true});try{const b={};for(const c of JSON.parse(db.prepare("SELECT value FROM meta WHERE key='board.collections'").get().value))b[c]=[];for(const r of db.prepare('SELECT collection, body FROM items ORDER BY collection, ord').all())(b[r.collection]??=[]).push(JSON.parse(r.body));return b;}finally{db.close();}}
export async function snapshot(x,o) {
  // Storage is read-only here: board.read intentionally excludes private persisted receipts.
  const b=await boardOf(x.data);const task=b.tasks.find(t=>t.id===o.cardId);
  let file=null,checkInput=null;try {const v=await readFile(path.join(o.directory,o.filename));file={hash:hash(v),nonempty:!!v.toString().trim()};if(o.checkFile){const script=await readFile(o.checkFile);const node=await command('node',['--version'],o.directory);checkInput={hash:hash(Buffer.concat([v,script,Buffer.from(node)])),fileHash:hash(v),scriptHash:hash(script),node};}}catch(e){if(e.code!=='ENOENT')throw e;}
  const scope=await captureScope(o.directory,{base:o.baseCommit,filename:o.filename,history:o.historyBase??null});
  return {scope,boardEvents:b.events.filter(e=>e.taskId===o.cardId).map(publicEvent),changePaths:[...new Set([...scope.dirtyPaths,...scope.committedPaths])],task:publicTask(task),workpad:publicPad(b.workpads.find(p=>p.taskId===o.cardId)),artifacts:b.artifacts.filter(a=>a.taskId===o.cardId).map(publicArtifact),receipts:b.agentReceipts.filter(r=>r.agentId===o.id&&r.taskId===o.cardId).map(publicReceipt),head:await head(o.directory),file,checkInput,tree:await command('git',['rev-parse','HEAD^{tree}'],o.directory)};
}
export async function collectTurn(x,c,o,t,agent) {
  let after,flow;let flowComplete=false;
  for(let n=0;n<15;n++) {
    after=await snapshot(x,o);let text='';try{text=await readFile(path.join(x.data,'flow',c.projectId+'.jsonl'),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
    flow=parseFlow(text,o.cardId,o.id);
    flowComplete=flowIntegrity(flow,after,t.before,t.startedAt);
    if(flowComplete&&flow.events.some(e=>e.action==='agent.turn_ended'&&e.at>=t.startedAt))break;
    await delay(200);
  }
  const trace=await timeline(agent);const unavailable=providerFailure(trace.entries.filter(e=>e.timestamp>=t.startedAt));if(unavailable){t.state='INVALID';t.reason=unavailable;t.providerFailure={code:unavailable,source:'canonical-assistant-message'};}t.endedAt=new Date().toISOString();
  t.calls=normalizeTimeline(trace.entries.filter(e=>e.timestamp>=t.startedAt&&e.timestamp<=t.endedAt),{checkCommand:o.checkCommand,filename:o.filename,sessionId:o.id,cardId:o.cardId});
  t.events=[...new Map([...flow.events,...after.boardEvents].filter(e=>e.at>=t.startedAt&&e.at<=t.endedAt).map(e=>[e.id,e])).values()].sort((a,b)=>a.at.localeCompare(b.at));t.receipts=after.receipts.filter(r=>r.at>=t.startedAt&&r.at<=t.endedAt);t.after=after;t.flowComplete=flowComplete;t.receiptsComplete=true;t.timelineComplete=trace.complete;t.complete=flowComplete&&trace.complete;
  t.prs=[];t.prQueryComplete=false;
  try {
    const list=JSON.parse(await command('gh',['pr','list','--repo',c.repository,'--head',o.branch,'--state','all','--json','number,url,state,headRefName,headRefOid,createdAt,files,mergeCommit'],o.directory));
    t.prs=list.filter(p=>p.createdAt>=t.startedAt&&p.createdAt<=t.endedAt).map(p=>({number:p.number,url:p.url,state:p.state,headRefName:p.headRefName,createdAt:p.createdAt,head:p.headRefOid,mergeCommit:p.mergeCommit?.oid,repository:c.repository,files:p.files.map(f=>f.path)}));
    for(const p of t.prs){for(const [field,ref] of [['headFileHash',p.head],['mergedFileHash',p.mergeCommit]])if(ref){const content=JSON.parse(await command('gh',['api',`repos/${c.repository}/contents/${o.filename}?ref=${ref}`],o.directory));if(content.type==='file'&&content.encoding==='base64')p[field]=hash(Buffer.from(content.content,'base64'));}}
    t.prQueryComplete=true;
  }catch{}
  const actual=(await agent.refresh())?.agent;
  if(actual?.persistence?.sessionId) {
    try {
      const providerId=actual.persistence.sessionId;let file;
      if(!/^[a-zA-Z0-9-]+$/.test(providerId))throw Error('Invalid persistence identity');
      if(o.provider==='claude') {
        const parent=path.join(homedir(),'.claude/projects');
        for(const name of await readdir(parent)){const candidate=path.join(parent,name,providerId+'.jsonl');try{if((await stat(candidate)).isFile()){file=candidate;break;}}catch{}}
      } else {
        const created=new Date(actual.createdAt);const parent=path.join(homedir(),'.codex/sessions',String(created.getFullYear()),String(created.getMonth()+1).padStart(2,'0'),String(created.getDate()).padStart(2,'0'));
        const name=(await readdir(parent)).find(n=>n.endsWith(providerId+'.jsonl'));if(name)file=path.join(parent,name);
      }
      if(file){const extra=providerCalls(await readFile(file,'utf8'),o.provider,{checkCommand:o.checkCommand,filename:o.filename,sessionId:o.id,cardId:o.cardId});t.calls=mergeCalls(t.calls,extra.calls);t.providerDiagnostics=extra.diagnostics;}
    }catch{t.providerDiagnostics=['Owned provider transcript unavailable'];}
  }
  t.runtime=actual?{model:actual.model,mode:actual.currentModeId,thinking:actual.effectiveThinkingOptionId}:null;
  if(t.runtime?.model!==o.model||t.runtime.mode!==o.mode){t.state='INVALID';t.reason='runtime-model-or-mode-mismatch';}
  o.branchExpected=await command('git',['rev-parse',`refs/heads/${o.branch}`],c.repoPath);
  const remote=await command('git',['ls-remote','https://github.com/'+c.repository+'.git','refs/heads/'+o.branch],c.repoPath);o.remoteExpected=remote?remote.split(/\s+/)[0]:null;
  o.prs=[...new Map([...(o.prs??[]),...t.prs.filter(p=>remotePrOwned(o,p,c.repository))].map(p=>[p.number,p])).values()];
  return t;
}
export async function cleanup(x,c,state,persist) {
  const problems=[];
  for(const o of state.owned??[]) {
    try {
      const board=await x.rpc('board.read',{});let task=board.tasks.find(t=>t.id===o.cardId);
      if(!task&&!o.cardId&&o.operationId){task=board.tasks.find(t=>t.operationId===o.operationId&&t.projectId===c.projectId);if(task){o.cardId=task.id;o.workspaceId=task.workspaceId;o.directory=ownedDirectory(await x.api.workspaces.ref(task.workspaceId).refresh(),o,state.baseline.projectId,c.repoPath);await persist();}}
      if(task&&!o.directory){const w=await x.api.workspaces.ref(task.workspaceId).refresh();o.directory=ownedDirectory(w,o,state.baseline.projectId,c.repoPath);await persist();}
      if(o.id){const a=x.api.agents.ref(o.id);const s=(await a.refresh())?.agent;if(s&&s.workspaceId!==o.workspaceId)throw Error('Session ownership mismatch');if(s&&['running','initializing'].includes(s.status)){await x.client.cancelAgent(o.id);await a.waitForFinish(15000);const stopped=(await a.refresh())?.agent;if(stopped&&['running','initializing'].includes(stopped.status))throw Error('Owned agent still active after cancellation');}if(task){o.cleanupFreeze=await freezeMinimum(x,c,o,a);await persist();}if(s&&!s.archivedAt)await a.archive();}
      if(task) {
        if(!o.cleanupFreeze){o.cleanupFreeze=await freezeMinimum(x,c,o);await persist();}
        if(task.workspaceId!==o.workspaceId||task.projectId!==c.projectId)throw Error('Card ownership mismatch');

        const pre=await x.rpc('tasks.delete-check',{id:o.cardId});if(pre.blockers.length)throw Error('Deletion has blockers');
        if(pre.workspace?.id!==o.workspaceId)throw Error('Deletion workspace mismatch');
        const observed=await command('git',['rev-parse',`refs/heads/${o.branch}`],c.repoPath);
        if(o.branchExpected&&o.branchExpected!==observed)throw Error('Owned branch changed after freeze; preserving fixture');
        const scope=await captureScope(o.directory,{base:c.baseCommit,filename:o.filename,history:o.historyBase??null});
        const decision=assessScope(scope,o.filename,observed);o.scopeCleanup={scope,decision};await persist();
        if(decision.verdict!=='PASS')throw Error('Scope '+decision.verdict+': '+decision.reason+'; preserving fixture');
        o.branchExpected??=observed;await persist();
        await x.rpc('tasks.delete',{id:o.cardId,revision:task.revision,archive:true,acknowledgeWarnings:true});
      }
      if(o.branch) {
        let current;try{current=await command('git',['rev-parse','--verify',`refs/heads/${o.branch}`],c.repoPath);}catch{}
        if(current) {
          const ref='refs/heads/'+o.branch;if(!deletableRef(ref,state.baseline.git.refs,current,o.branchExpected))throw Error('Ref ownership changed; preserving ref');
          await command('git',['update-ref','-d',ref,o.branchExpected],c.repoPath);
        }
        // No branch-name-only mutations: absent-before + created ownership + frozen PR identity.
        const remote=await command('git',['ls-remote','https://github.com/'+c.repository+'.git','refs/heads/'+o.branch],c.repoPath);
        if(remote&&(!o.branchCreated||!o.remoteBeforeAbsent||!o.remoteExpected||o.remoteExpected!==remote.split(/\s+/)[0]))throw Error('Remote ownership changed or not frozen; preserve branch');
        for(const frozen of o.prs??[]) {
          if(!remotePrOwned(o,frozen,c.repository))throw Error('PR ownership not frozen; preserve PR');
          const current=JSON.parse(await command('gh',['pr','view',String(frozen.number),'--repo',c.repository,'--json','url,state,headRefName,headRefOid'],c.repoPath));
          if(current.url!==frozen.url||current.headRefName!==o.branch||current.headRefOid!==frozen.head)throw Error('PR changed after freeze; preserve PR');
          if(current.state==='OPEN')await command('gh',['pr','close',String(frozen.number),'--repo',c.repository],c.repoPath);
        }
        if(remote){const oid=remote.split(/\s+/)[0];await command('git',['push',`--force-with-lease=refs/heads/${o.branch}:${oid}`,'https://github.com/'+c.repository+'.git',`:refs/heads/${o.branch}`],c.repoPath);}
      }
      o.cleaned=true;await persist();
    }catch(e){problems.push({key:o.key,reason:e.message});}
  }
  if(state.scratch?.phase==='created')try{await command('git',['update-ref','-d',state.scratch.ref,state.scratch.expected],c.repoPath);state.scratch.phase='deleted';await persist();}catch{problems.push({reason:'scratch-ref-cleanup-failed'});}
  if(state.baseline) {
    const git=await gitSnapshot(c.repoPath);const before=state.baseline.git;
    if(JSON.stringify(git)!==JSON.stringify(before))problems.push({reason:'baseline-git-changed; attribution requires review, never restore automatically'});
    const board=await x.rpc('board.read',{});
    for(const t of state.baseline.tasks){const now=board.tasks.find(n=>n.id===t.id);if(!now||['revision','status','workspaceId'].some(k=>now[k]!==t[k]))problems.push({reason:'baseline-card-changed',id:t.id});}
    const workspaces=[];let cursor;do{const p=await x.api.workspaces.list({filter:{projectId:state.baseline.projectId},page:{limit:200,...(cursor?{cursor}:{})}});workspaces.push(...p.entries);cursor=p.pageInfo.nextCursor;}while(cursor);
    for(const o of state.owned??[]) {
      if(board.tasks.some(t=>t.id===o.cardId))problems.push({reason:'owned-card-remains',id:o.cardId});
      if(o.id){const a=(await x.api.agents.ref(o.id).refresh())?.agent;if(a&&!a.archivedAt)problems.push({reason:'owned-session-not-archived',id:o.id});}
      if(o.workspaceId&&workspaces.some(w=>w.id===o.workspaceId))problems.push({reason:'owned-workspace-not-archived',id:o.workspaceId});
    }
  }
  return {state:problems.length?'FAIL':'PASS',problems,at:new Date().toISOString()};
}

async function freezeMinimum(x,c,o,agent) {
  const facts=await snapshot(x,o); // If file/storage cannot be frozen, throw; caller preserves the fixture.
  let log='';try{log=await readFile(path.join(x.data,'flow',c.projectId+'.jsonl'),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}const flow=parseFlow(log,o.cardId,o.id);
  const frozen={at:new Date().toISOString(),facts,events:flow.events,diagnostics:flow.diagnostics,calls:[]};
  if(agent)try{const trace=await timeline(agent);frozen.calls=normalizeTimeline(trace.entries,{checkCommand:o.checkCommand,filename:o.filename,sessionId:o.id,cardId:o.cardId});if(!trace.complete)frozen.diagnostics.push('Timeline incomplete');}catch{frozen.diagnostics.push('Timeline unavailable; entities/file/receipts and full flow frozen');}
  return frozen;
}
