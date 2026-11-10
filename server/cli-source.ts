export const cliSource = String.raw`#!/usr/bin/env node
import {readFile, writeFile} from 'node:fs/promises';

const args=process.argv.slice(2), opts={}, positional=[];
const allowed=new Set(['context-file','save-request','request-file','task-revision','project-revision','note','kind','title','detail','rationale','context','type','priority','scope','role','target','id','add','remove','tags','moves','workpad','workpad-file','workpad-revision','acknowledge-open','no-moves','body','keywords','supersedes','query','outputs','no-outputs','dismiss','sources','limit','input','files','notes','notes-file','ref','disputes']);
const booleanFlags=new Set(['acknowledge-open','no-moves','no-outputs','dismiss']);
const workpadFlags=['workpad','workpad-file','workpad-revision'];
const ideaFlags=['detail','rationale','context','type','priority','scope','tags'];
const tagFlags=['add','remove'];
const list=v=>v===undefined?[]:v.split(',').map(x=>x.trim()).filter(Boolean);
const artifactFlags=['role','target','id'];
const memoryFlags=['body','keywords','supersedes'];
const cardCommands=['cards','card','create-card','update-card'];
const handoverFlags=['files','notes','notes-file'];
function fail(message){throw new Error(message);}
try {
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg.startsWith('--')) {const key=arg.slice(2);if(!allowed.has(key)||Object.hasOwn(opts,key))fail('Unknown or duplicate flag: '+arg); if(booleanFlags.has(key)){opts[key]=true;continue;} const value=args[++i];if(value===undefined||value.startsWith('--'))fail('Missing value for '+arg);opts[key]=value;}
    else positional.push(arg);
  }
  const command=positional[0];if(!['current','get','status','note','idea','idea-update','idea-remove','remember','recall','search','artifact','artifact-remove','tags','set-type','next-moves','workpad','handover','integrate','external','ticket',...cardCommands].includes(command))fail('Usage: current [--save-request path] | external --id <artifact id> (read an external input: Jira ticket, Confluence page, GitHub/GitLab issue or PR/MR; ticket is an alias) | status <design|development|test|blocked|in_review|committed|integrated> | note (status and note also take --moves <JSON array of 0-3 {label, prompt} or {label, moveTo:"done"}> or --no-moves: the next steps for the user, recorded with the call) | idea --title --detail --rationale [--context --type --priority --scope here|new] | idea-update --id <idea id> [--title --detail --rationale --context --type --priority --scope --tags] [--dismiss] (edit an open idea of this card, or dismiss it) | idea-remove --id <idea id> (delete an idea proposed by mistake) | remember --kind decision|convention|pitfall|contact --title [--body --tags a,b --keywords x,y --supersedes <memory id>] (remember for the project; takes effect at once) | recall [--query words --kind k] (search project memory and guardrails; no request file) | search --query <words> [--sources card,summary,note,workpad,idea,artifact --limit n] (search other cards in this project; no request file) | artifact --role input|output --target <path or link> [--title --note] | artifact-remove --id <artifact id> | tags [--add a,b] [--remove c] | handover --files a,b [--notes text | --notes-file path] | integrate [--ref ref] | set-type <feature|bugfix|research|refactor|docs|chore> (only when the card has no type) | next-moves --moves <JSON array of 0-3 {label, prompt} or {label, moveTo:"done"}> | workpad --workpad-revision <n> (--workpad <JSON> | --workpad-file <path>) with {acceptance: [{id?, text, done}]} only; status in_review|committed|integrated / note --kind result take --outputs <JSON array of {target,title?,note?}> or --no-outputs; omission returns a reminder. status in_review [--disputes <JSON array of {id, reason}>] disputes findings of the latest auto review (ids from current guardrails.lastReview); status in_review|committed|integrated [--acknowledge-open] confirms missing card setup only after a prior SETUP_INCOMPLETE for the current state, with --context-file and --request-file. Card tools, only when the user asks (no request file): cards [--input <JSON flowly_list_cards input>] | card --id <taskId> | create-card --input <JSON flowly_create_card input> | update-card --input <JSON flowly_update_card input>.');
  if(positional.length!==(['status','set-type'].includes(command)?2:1))fail('Unexpected positional arguments.');
  const path=opts['context-file']||process.env.FLOWLY_CONTEXT_FILE||process.env.ULTRA_KANBAN_CONTEXT_FILE;if(!path)fail('No session context. Use the command supplied by the card drawer.');
  const context=JSON.parse(await readFile(path,'utf8'));
  if(context.version!==1||!context.identity||typeof context.credential!=='string'||typeof context.discoveryFile!=='string')fail('Invalid session context; ask the drawer to prepare it again.');
  if(!process.env.PASEO_AGENT_ID||process.env.PASEO_AGENT_ID!==context.identity.agentId)fail('PASEO_AGENT_ID is missing or does not match this session context.');
  const discovery=JSON.parse(await readFile(context.discoveryFile,'utf8'));
  const url=new URL(discovery.url);if(discovery.version!==1||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/')fail('Invalid loopback service discovery file.');
  let input={}, action='get';
  const ideaOnly=command==='remember'?ideaFlags.filter(k=>k!=='tags'):ideaFlags;
  if(!['idea','idea-update'].includes(command)&&ideaOnly.some(k=>opts[k]!==undefined))fail('--'+ideaOnly.find(k=>opts[k]!==undefined)+' is only valid for idea and idea-update.');
  if(command!=='idea-update'&&opts.dismiss!==undefined)fail('--dismiss is only valid for idea-update.');
  if(command!=='remember'&&memoryFlags.some(k=>opts[k]!==undefined))fail('--'+memoryFlags.find(k=>opts[k]!==undefined)+' is only valid for remember.');
  if(!['recall','search'].includes(command)&&opts.query!==undefined)fail('--query is only valid for recall and search.');
  if(command!=='search'&&(opts.sources!==undefined||opts.limit!==undefined))fail('--'+(opts.sources!==undefined?'sources':'limit')+' is only valid for search.');
  if(opts.title!==undefined&&!['idea','idea-update','artifact','remember'].includes(command))fail('--title is only valid for idea, idea-update, artifact and remember.');
  if(!['artifact','artifact-remove','external','ticket','idea-update','idea-remove','card'].includes(command)&&artifactFlags.some(k=>opts[k]!==undefined))fail('--'+artifactFlags.find(k=>opts[k]!==undefined)+' is only valid for artifact commands.');
  if(!['status','note','next-moves'].includes(command)&&(opts.moves!==undefined||opts['no-moves']!==undefined))fail('--'+(opts.moves!==undefined?'moves':'no-moves')+' is only valid for status, note and next-moves.');
  if(opts.moves!==undefined&&opts['no-moves']!==undefined)fail('--moves and --no-moves cannot be combined; use one.');
  if(opts.outputs!==undefined&&opts['no-outputs']!==undefined)fail('--outputs and --no-outputs cannot be combined; use one.');
  if(opts.outputs!==undefined||opts['no-outputs']!==undefined){
    if(!((command==='status'&&['in_review','committed','integrated'].includes(positional[1]))||(command==='note'&&opts.kind==='result')))fail('--outputs and --no-outputs are only valid for status in_review, committed or integrated, or note --kind result.');
  }
  if(command==='next-moves'&&opts['no-moves']!==undefined)fail('--no-moves is not valid for next-moves; pass --moves with a JSON array (it may be empty).');
  if(command!=='workpad'&&workpadFlags.some(k=>opts[k]!==undefined))fail('--'+workpadFlags.find(k=>opts[k]!==undefined)+' is only valid for workpad.');
  if(command!=='status'&&opts['acknowledge-open']!==undefined)fail('--acknowledge-open is only valid for status.');
  if(opts.disputes!==undefined&&!(command==='status'&&positional[1]==='in_review'))fail('--disputes is only valid for status in_review.');
  if(command!=='tags'&&tagFlags.some(k=>opts[k]!==undefined))fail('--'+tagFlags.find(k=>opts[k]!==undefined)+' is only valid for tags.');
  if(!['cards','create-card','update-card'].includes(command)&&opts.input!==undefined)fail('--input is only valid for cards, create-card and update-card.');
  if(command!=='handover'&&handoverFlags.some(k=>opts[k]!==undefined))fail('--'+handoverFlags.find(k=>opts[k]!==undefined)+' is only valid for handover.');
  if(command!=='integrate'&&opts.ref!==undefined)fail('--ref is only valid for integrate.');
  if(command==='recall'){if(['request-file','save-request','note','role','target','id'].some(k=>opts[k]!==undefined))fail('Only --query and --kind are valid for recall.');action='recall';input={query:opts.query||''};if(opts.kind)input.kind=opts.kind;}
  else if(command==='search'){if(['request-file','save-request','note','kind','role','target','id'].some(k=>opts[k]!==undefined))fail('Only --query, --sources and --limit are valid for search.');if(!opts.query?.trim())fail('search requires --query <words>.');action='search';input={query:opts.query};if(opts.sources!==undefined)input.sources=list(opts.sources);if(opts.limit!==undefined){if(!/^[1-9][0-9]*$/.test(opts.limit))fail('--limit must be a positive number.');input.limit=Number(opts.limit);}}
  else if(command==='external'||command==='ticket'){if(!opts.id)fail(command+' requires --id <artifact id> (an external input from current).');if(['request-file','save-request','note','kind','role','target'].some(k=>opts[k]!==undefined))fail('Only --id is valid for '+command+'.');action='external';input={artifactId:opts.id};}
  else if(cardCommands.includes(command)){if(['request-file','save-request','note','kind','role','target','query','title'].some(k=>opts[k]!==undefined))fail('Only --input'+(command==='card'?' and --id are':' is')+' valid for '+command+'.');if(command==='card'){if(!opts.id)fail('card requires --id <taskId> (from cards).');action='get_card';input={taskId:opts.id};}else{if(command!=='cards'&&opts.input===undefined)fail(command+' requires --input <JSON object>.');try{input=opts.input===undefined?{}:JSON.parse(opts.input);}catch{input=null;}if(!input||typeof input!=='object'||Array.isArray(input))fail('--input must be a JSON object.');action={cards:'list_cards','create-card':'create_card','update-card':'update_card'}[command];}}
  else if(command==='get'||command==='current') {if(['request-file','task-revision','project-revision','note','kind','role','target','id'].some(k=>opts[k]!==undefined))fail('Write flags are not valid for current.');}
  else {
    if(opts['save-request'])fail('--save-request is only valid for current.');
    if(command==='idea'){if(!opts['request-file']||!opts.title?.trim()||!opts.detail?.trim()||!opts.rationale?.trim())fail('idea requires --request-file, --title, --detail and --rationale.');if(opts.note||opts.kind)fail('--note and --kind are not valid for idea.');}
    else if(command==='idea-update'||command==='idea-remove'){if(!opts['request-file']||!opts.id)fail(command+' requires --request-file and --id.');if(opts.note||opts.kind||opts.role||opts.target)fail('--note, --kind, --role and --target are not valid for '+command+'.');if(command==='idea-update'&&opts.title===undefined&&!opts.dismiss&&!ideaFlags.some(k=>opts[k]!==undefined))fail('idea-update needs a field to change or --dismiss.');}
    else if(command==='remember'){if(!opts['request-file']||!opts.kind||!opts.title?.trim())fail('remember requires --request-file, --kind and --title.');if(opts.note)fail('--note is not valid for remember.');}
    else if(command==='artifact'){if(!opts['request-file']||!opts.role||!opts.target?.trim())fail('artifact requires --request-file, --role and --target.');if(opts.kind||opts.id)fail('--kind and --id are not valid for artifact.');}
    else if(command==='artifact-remove'){if(!opts['request-file']||!opts.id)fail('artifact-remove requires --request-file and --id.');if(opts.note||opts.kind||opts.role||opts.target)fail('Only --id is valid for artifact-remove.');}
    else if(command==='tags'){if(!opts['request-file']||(!list(opts.add).length&&!list(opts.remove).length))fail('tags requires --request-file and --add or --remove (comma-separated).');if(opts.note||opts.kind)fail('--note and --kind are not valid for tags.');}
    else if(command==='handover'){if(!opts['request-file']||!list(opts.files).length)fail('handover requires --request-file and --files (comma-separated).');if(opts.notes!==undefined&&opts['notes-file']!==undefined)fail('--notes and --notes-file cannot be combined; use one.');if(opts.note||opts.kind)fail('--note and --kind are not valid for handover; use --notes.');}
    else if(command==='integrate'){if(!opts['request-file'])fail('integrate requires --request-file.');if(opts.note||opts.kind)fail('--note and --kind are not valid for integrate.');}
    else if(command==='set-type'){if(!opts['request-file'])fail('set-type requires --request-file.');if(opts.note||opts.kind)fail('--note and --kind are not valid for set-type.');}
    else if(command==='next-moves'){if(!opts['request-file']||!opts.moves)fail('next-moves requires --request-file and --moves (a JSON array).');if(opts.note||opts.kind)fail('--note and --kind are not valid for next-moves.');}
    else if(command==='workpad'){if(!opts['request-file']||opts['workpad-revision']===undefined||(opts.workpad===undefined)===(opts['workpad-file']===undefined))fail('workpad requires --request-file, --workpad-revision and one of --workpad or --workpad-file.');if(!/^(0|[1-9][0-9]*)$/.test(opts['workpad-revision']))fail('--workpad-revision must be a number (0 when the card has no workpad).');if(opts.note||opts.kind)fail('--note and --kind are not valid for workpad.');}
    else if(!opts['request-file']||!opts.note?.trim())fail('Writes require --request-file and a nonempty --note.');
    const snapshot=JSON.parse(await readFile(opts['request-file'],'utf8'));
    if(snapshot.identity?.agentId!==context.identity.agentId||snapshot.identity?.taskId!==context.identity.taskId)fail('Snapshot belongs to another session/card.');
    if(!snapshot.request||!snapshot.revision)fail('Invalid request snapshot. Run current --save-request first.');
    for(const [key,part] of [['task-revision','task'],['project-revision','project']])if(opts[key]!==undefined&&(!/^[1-9][0-9]*$/.test(opts[key])||Number(opts[key])!==snapshot.revision[part]))fail('Explicit revision does not match the snapshot.');
    input={expectedRevision:snapshot.revision,request:snapshot.request,note:opts.note};
    let carried;
    if(['status','note'].includes(command)){
      if(opts['no-moves'])carried=[];
      else if(opts.moves!==undefined){try{carried=JSON.parse(opts.moves);}catch{carried=undefined;}if(!Array.isArray(carried))fail('--moves must be a JSON array of {label, prompt} or {label, moveTo:"done"}; use --no-moves when nothing needs the user.');}
    }
    if(command==='idea'){action='idea';input={expectedRevision:snapshot.revision,request:snapshot.request,title:opts.title};for(const k of ideaFlags)if(opts[k]!==undefined)input[k]=k==='tags'?list(opts[k]):opts[k];}
    else if(command==='idea-update'){action='idea_update';input={expectedRevision:snapshot.revision,request:snapshot.request,id:opts.id};for(const k of ['title',...ideaFlags])if(opts[k]!==undefined)input[k]=k==='tags'?list(opts[k]):opts[k];if(opts.dismiss)input.status='dismissed';}
    else if(command==='idea-remove'){action='idea_remove';input={expectedRevision:snapshot.revision,request:snapshot.request,id:opts.id};}
    else if(command==='remember'){action='remember';input={expectedRevision:snapshot.revision,request:snapshot.request,kind:opts.kind,title:opts.title,body:opts.body||'',tags:list(opts.tags),keywords:list(opts.keywords)};if(opts.supersedes)input.supersedes=opts.supersedes;}
    else if(command==='tags'){action='tags';input={expectedRevision:snapshot.revision,request:snapshot.request,add:list(opts.add),remove:list(opts.remove)};}
    else if(command==='next-moves'){let moves;try{moves=JSON.parse(opts.moves);}catch{fail('--moves must be a JSON array of {label, prompt}.');}action='next_moves';input={expectedRevision:snapshot.revision,request:snapshot.request,moves};}
    else if(command==='workpad'){let pad;try{pad=JSON.parse(opts.workpad!==undefined?opts.workpad:await readFile(opts['workpad-file'],'utf8'));}catch{fail('The workpad must be a JSON object {acceptance}.');}if(!pad||typeof pad!=='object'||Array.isArray(pad))fail('The workpad must be a JSON object {acceptance}.');const extra=Object.keys(pad).filter(k=>k!=='acceptance');if(extra.length)fail('The workpad takes only {acceptance}; remove '+extra.join(', ')+'. Flowly\'s auto review runs the checks when you deliver.');action='workpad';input={expectedRevision:snapshot.revision,request:snapshot.request,workpadRevision:Number(opts['workpad-revision']),acceptance:pad.acceptance};}
    else if(command==='handover'){action='handover';input={expectedRevision:snapshot.revision,request:snapshot.request,files:list(opts.files),notes:opts['notes-file']!==undefined?await readFile(opts['notes-file'],'utf8'):opts.notes||''};}
    else if(command==='integrate'){action='integrate';input={expectedRevision:snapshot.revision,request:snapshot.request};if(opts.ref)input.ref=opts.ref;}
    else if(command==='set-type'){action='type';input={expectedRevision:snapshot.revision,request:snapshot.request,type:positional[1]};}
    else if(command==='artifact'){action='artifact';input={expectedRevision:snapshot.revision,request:snapshot.request,role:opts.role,target:opts.target};for(const k of ['title','note'])if(opts[k]!==undefined)input[k]=opts[k];}
    else if(command==='artifact-remove'){action='artifact_remove';input={expectedRevision:snapshot.revision,request:snapshot.request,id:opts.id};}
    else if(command==='status'){if(opts.kind)fail('--kind is only valid for note.');action='status';input.status=positional[1];if(opts['acknowledge-open'])input.acknowledgeOpen=true;if(opts.disputes!==undefined){let disputes;try{disputes=JSON.parse(opts.disputes);}catch{disputes=undefined;}if(!Array.isArray(disputes))fail('--disputes must be a JSON array of {id, reason}.');input.disputes=disputes;}}
    else {action='progress';input.kind=opts.kind||'progress';}
    if(carried!==undefined)input.nextMoves=carried;
    if(opts['no-outputs'])input.outputs=[];
    else if(opts.outputs!==undefined){let outputs;try{outputs=JSON.parse(opts.outputs);}catch{fail('--outputs must be a JSON array of {target,title?,note?}; use --no-outputs when there are none.');}if(!Array.isArray(outputs))fail('--outputs must be a JSON array of {target,title?,note?}.');input.outputs=outputs;}
  }
  const response=await fetch(new URL('api',url),{method:'POST',headers:{Authorization:'Bearer '+context.credential,'Content-Type':'application/json'},body:JSON.stringify({action,input}),signal:AbortSignal.timeout(20000)});
  const body=await response.json();if(!response.ok||!body.ok){process.stderr.write(JSON.stringify(body.error||{code:'HTTP_ERROR',message:'HTTP '+response.status})+'\n');process.exitCode=1;}
  else {
    if(opts['save-request'])await writeFile(opts['save-request'],JSON.stringify({identity:body.result.identity,revision:body.result.revision,request:body.result.request},null,2),{mode:0o600});
    process.stdout.write(JSON.stringify(body.result,null,2)+'\n');
  }
}catch(error){process.stderr.write(JSON.stringify({code:'CLI_FAILURE',message:error instanceof Error?error.message:String(error),hint:'For a timeout, keep the request snapshot and retry the same parameters; do not assume whether it committed.'})+'\n');process.exitCode=1;}
`;
