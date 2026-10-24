import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {buildReviewCatalog} from '../src/review-selection.mjs';
import {initialTuiState,updateTuiState,renderReviewTui,reviewSessionDraft,runReviewTui,visibleProposalIndices,diagnosticEntries} from '../src/review-tui.mjs';

const source={consumer_repo:'example/consumer',provider_repo:'example/provider',
  proposals:[
    {id:'a',action:'UPDATE',title:'Adjust type',priority:'P1',
      source:{repo:'example/consumer',path:'.agents/skills/a/SKILL.md'},
      target:{repo:'example/consumer',path:'.agents/skills/a/SKILL.md'},
      reason:'Types differ',steps:['Check sources'],limits:['No automatic writes']},
    {id:'b',action:'UPDATE',title:'Review fixture setup',priority:'P2',
      source:{repo:'example/consumer',path:'.agents/skills/b/SKILL.md'},
      target:{repo:'example/consumer',path:'.agents/skills/b/SKILL.md'},
      reason:'Alternative lifecycle'},
    {id:'c',action:'MOVE',title:'Manual relocation',priority:'P3',
      source:{repo:'example/consumer',path:'.agents/skills/c/SKILL.md'},
      target:{repo:'example/provider',path:'.agents/skills/c/SKILL.md'},
      reason:'Ownership must be reviewed'}
  ]};
const catalog=buildReviewCatalog(source);
test('keyboard navigation, multiple selection and discard are independent of repository writes',()=>{
  let s=initialTuiState();
  assert.deepEqual(s.selected,[]);
  s=updateTuiState(s,'space',3);
  s=updateTuiState(s,'down',3);
  s=updateTuiState(s,'space',3);
  assert.deepEqual(s.selected,[0,1]);
  s=updateTuiState(s,'d',3);
  assert.deepEqual(s.selected,[0]);
  assert.deepEqual(s.discarded,[1]);
  s=updateTuiState(s,'a',3);
  assert.deepEqual(s.selected,[0,2]);
  s=updateTuiState(s,'u',3);
  s=updateTuiState(s,'a',3);
  assert.deepEqual(s.selected,[0,1,2]);
  s=updateTuiState(s,'n',3);
  assert.deepEqual(s.selected,[]);
  const draft=reviewSessionDraft(catalog,s);
  assert.equal(draft.selection.mode,'NONE');
  assert.equal(draft.applied_count,0);
  assert.equal(draft.write_authorized,false);
});

test('draft selection is a review plan, never a final approval or apply instruction',()=>{
  let s=updateTuiState(initialTuiState(),'a',3);
  const draft=reviewSessionDraft(catalog,s);
  assert.deepEqual(draft.selected_ids,['a','b','c']);
  assert.equal(draft.selection.mode,'SUBSET');
  assert.equal(draft.selection.selected_count,3);
  assert.equal(draft.selection.confirmation_required,true);
  assert.equal(draft.selection.write_authorized,false);
  assert.equal(draft.write_authorized,false);
  assert.equal(draft.applied_count,0);
});

test('list and detail show summary, risk and read-only status; remain usable without colors',()=>{
  const s=initialTuiState();
  const plain=renderReviewTui(catalog,s,{columns:94,rows:25,colors:false,
    scopeHints:{hints:[{},{}]},sourceChecks:{observations:[{}]}});
  assert.match(plain,/WIZARD OF SKILLZ/);
  assert.match(plain,/Proposte 3/);
  assert.doesNotMatch(plain,/Scope 2.*Coerenza 1/); // uncluttered summary
  assert.match(plain,/SPAZIO Seleziona/);
  assert.match(plain,/G DISABILITATO/);
  assert.doesNotMatch(plain,/\x1b\[/);
  const detail=renderReviewTui(catalog,updateTuiState(s,'enter',3),{colors:false});
  assert.match(detail,/DESTINAZIONE/);
  assert.match(detail,/MOTIVO DELLA PROPOSTA|Righe /);
  // Risk notes remain present below the fold, not silently discarded.
  const pages=Array.from({length:40},(_,i)=>renderReviewTui(catalog,{
    ...updateTuiState(s,'enter',3),scroll:i
  },{colors:false,rows:28})).join('\n');
  assert.match(pages,/PASSAGGI PROPOSTI/);
  assert.match(pages,/No automatic writes/);
});

test('preview displays only real diff or explains unavailable preview',()=>{
  const s=updateTuiState(initialTuiState(),'p',3);
  const missing=renderReviewTui(catalog,s,{colors:false});
  assert.match(missing,/Nessun diff verificabile/);
  const actual=renderReviewTui(catalog,s,{colors:false,previews:{
    previews:[{proposal_id:'a',status:'PREVIEW_READY',diff:'-original\n+changed'}]
  }});
  assert.match(actual,/\+changed/);
});

test('sanitize terminal escape sequences and require TTY for interactive use',async()=>{
  const hostile=buildReviewCatalog({consumer_repo:'example/consumer',proposals:[{
    id:'u',action:'UPDATE',title:'Untrusted\x1b[2Jcontrol',
    source:{repo:'example/consumer',path:'u/SKILL.md'},
    target:{repo:'example/consumer',path:'u/SKILL.md'}
  }]});
  const rendered=renderReviewTui(hostile,initialTuiState(),{colors:false});
  assert.doesNotMatch(rendered,/\x1b\[/);
  await assert.rejects(()=>runReviewTui('/unused',{input:{isTTY:false},
    output:{isTTY:false}}),/TTY/);
});

test('guided overview starts read-only, preserves selection and returns from list with Escape',()=>{
  let state=initialTuiState({guided:true});
  assert.equal(state.view,'overview');
  const summary=renderReviewTui(catalog,state,{columns:80,rows:14,colors:false,
    scopeHints:{hints:[{}]},sourceChecks:{observations:[{},{}]}});
  assert.match(summary,/COSA VUOI FARE/);
  assert.match(summary,/Esamina le proposte locali \(3\)/);
  assert.match(summary,/verifica semantica non inclusa/);
  assert.match(summary,/↑↓ Scegli/);
  assert.equal(summary.includes(String.fromCharCode(27)),false);
  state=updateTuiState(state,'space',3);
  assert.deepEqual(state.selected,[]);
  state=updateTuiState(state,'enter',3);
  assert.equal(state.view,'list');
  state=updateTuiState(state,'space',3);
  assert.deepEqual(state.selected,[0]);
  state=updateTuiState(state,'escape',3);
  assert.equal(state.view,'overview');
  state=updateTuiState(state,'v',3);
  assert.equal(state.view,'list');
  assert.deepEqual(state.selected,[0]);
  state=updateTuiState(state,'v',3);
  assert.equal(state.view,'detail');
  state=updateTuiState(state,'escape',3);
  assert.equal(state.view,'list');
  const draft=reviewSessionDraft(catalog,state);
  assert.equal(draft.write_authorized,false);
  assert.equal(draft.applied_count,0);
});

test('TTY starts on overview and exits without writing any reviewed repository',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-review-'));
  try{
    fs.writeFileSync(path.join(folder,'repair-proposals.json'),JSON.stringify(source));
    const input=new PassThrough();
    input.isTTY=true;
    input.setRawMode=()=>{};
    let terminal='';
    const output={isTTY:true,columns:90,rows:20,write:s=>{terminal+=s;}};
    const session=runReviewTui(folder,{input,output});
    assert.match(terminal,/COSA VUOI FARE/);
    input.emit('keypress',String.fromCharCode(13),{name:'return'});
    assert.ok(terminal.includes('REVISIONE'));
    input.emit('keypress','q',{name:'q'});
    const draft=await session;
    assert.deepEqual(draft.selected_ids,[]);
    assert.equal(draft.write_authorized,false);
    assert.equal(draft.applied_count,0);
    assert.equal(fs.existsSync(path.join(folder,'review-session.json')),false);
  }finally{
    fs.rmSync(folder,{recursive:true,force:true});
  }
});


test('proposal filters and search preserve original review IDs and never select hidden entries',()=>{
  const context={items:catalog.items};
  let state=initialTuiState({guided:true});
  state=updateTuiState(state,'enter',3,context);
  state=updateTuiState(state,'f',3,context);
  assert.equal(state.filter,'UPDATE');
  assert.deepEqual(visibleProposalIndices(catalog.items,state),[0,1]);
  state=updateTuiState(state,'down',3,context);
  assert.equal(state.cursor,1);
  state=updateTuiState(state,'space',3,context);
  assert.deepEqual(state.selected,[1]);
  state=updateTuiState(state,'f',3,context);
  assert.equal(state.filter,'CREATE');
  assert.deepEqual(visibleProposalIndices(catalog.items,state),[]);
  state=updateTuiState(state,'a',3,context);
  state=updateTuiState(state,'space',3,context);
  assert.deepEqual(state.selected,[1]);
  state=updateTuiState(state,'f',3,context);
  assert.equal(state.filter,'MOVE');
  assert.deepEqual(visibleProposalIndices(catalog.items,state),[2]);
  state=updateTuiState(state,'space',3,context);
  assert.deepEqual(state.selected,[1,2]);
  state=updateTuiState(state,'/',3,context);
  assert.equal(state.searching,true);
  for(const ch of 'RELOCATION')state=updateTuiState(state,'text',3,{...context,text:ch});
  state=updateTuiState(state,'enter',3,context);
  assert.equal(state.search,'RELOCATION');
  assert.deepEqual(visibleProposalIndices(catalog.items,state),[2]);
  state=updateTuiState(state,'x',3,context);
  assert.equal(state.search,'');
  assert.deepEqual(state.selected,[1,2]);
  const selected=reviewSessionDraft(catalog,state);
  assert.deepEqual(selected.selected_ids,['b','c']);
  assert.equal(selected.write_authorized,false);
  assert.equal(selected.applied_count,0);
  const text=renderReviewTui(catalog,state,{colors:false,rows:24,columns:86});
  assert.match(text,/Filtro MOVE/);
  assert.match(text,/1\/3 visibili/);
});

test('search supports literal punctuation, cancellation, backspace and no-match states safely',()=>{
  const context={items:catalog.items};
  let state=initialTuiState();
  state=updateTuiState(state,'/',3,context);
  for(const ch of 'nonexistent')state=updateTuiState(state,'text',3,{...context,text:ch});
  state=updateTuiState(state,'backspace',3,context);
  assert.equal(state.searchDraft,'nonexisten');
  state=updateTuiState(state,'escape',3,context);
  assert.equal(state.searching,false);
  assert.equal(state.search,'');
  state=updateTuiState(state,'/',3,context);
  for(const ch of '[none]?')state=updateTuiState(state,'text',3,{...context,text:ch});
  state=updateTuiState(state,'enter',3,context);
  assert.deepEqual(visibleProposalIndices(catalog.items,state),[]);
  state=updateTuiState(state,'a',3,context);
  assert.deepEqual(state.selected,[]);
  const page=renderReviewTui(catalog,state,{colors:false,rows:20});
  assert.match(page,/Nessuna proposta con il filtro attuale/);
  state=updateTuiState(state,'x',3,context);
  assert.deepEqual(visibleProposalIndices(catalog.items,state),[0,1,2]);
  state=updateTuiState(state,'/',3,context);
  for(let i=0;i<90;i++)state=updateTuiState(state,'text',3,{...context,text:'a'});
  assert.equal(state.searchDraft.length,80);
});

test('scope hints, abstentions and structural observations have separate read-only drill-down',()=>{
  const scopeHints={hints:[{kind:'SPLIT_SCOPE_CANDIDATE',skill:'first',
    current:{path:'.agents/skills/a/SKILL.md',sha256:'a'.repeat(64)},
    reason:'Mixed ownership',target:null,confidence:'TENTATIVE',
    directions:['BROADER_FOR_PROVIDER_CLAIMS'],
    provider_claims:[{id:'one'}],local_claims:[],unresolved_claim_count:1,
    limits:['Do not infer a MOVE.']}],
    abstentions:[{skill:'other',path:'other/SKILL.md',reason:'INSUFFICIENT_SCOPE_EVIDENCE'}]};
  const sourceChecks={observations:[{kind:'ALTERNATIVE_TEST_SETUP',skill:'tester',
    skill_path:'skills/test/SKILL.md',skill_line:10,
    source:{path:'src/test.java',line:15,sha256:'b'.repeat(64)},
    confidence:'ALTERNATIVE_PRACTICE_ONLY',suggested_action:'CHECK_USAGE',
    detail:'Alternative testing fixture; not a patch'}]};
  assert.equal(diagnosticEntries('scope',{scopeHints}).length,2);
  assert.equal(diagnosticEntries('consistency',{sourceChecks}).length,1);
  const context={items:catalog.items,scopeCount:2,consistencyCount:1};
  let state=initialTuiState({guided:true});
  state=updateTuiState(state,'h',3,context);
  assert.equal(state.view,'diagnostics');
  assert.match(renderReviewTui(catalog,state,{scopeHints,sourceChecks,colors:false}),
    /NON SELEZIONABILI/);
  state=updateTuiState(state,'space',3,context);
  state=updateTuiState(state,'a',3,context);
  state=updateTuiState(state,'d',3,context);
  assert.deepEqual(state.selected,[]);
  assert.deepEqual(state.discarded,[]);
  state=updateTuiState(state,'enter',3,context);
  assert.equal(state.view,'diagnostic-detail');
  assert.match(renderReviewTui(catalog,state,{scopeHints,sourceChecks,colors:false}),
    /Mixed ownership/);
  state=updateTuiState(state,'escape',3,context);
  state=updateTuiState(state,'down',3,context);
  assert.equal(state.diagnosticCursor,1);
  state=updateTuiState(state,'enter',3,context);
  assert.match(renderReviewTui(catalog,state,{scopeHints,sourceChecks,colors:false}),
    /INSUFFICIENT_SCOPE_EVIDENCE/);
  state=updateTuiState(state,'c',3,context);
  assert.equal(state.diagnosticKind,'consistency');
  state=updateTuiState(state,'enter',3,context);
  const detail=renderReviewTui(catalog,state,{scopeHints,sourceChecks,colors:false,
    columns:110,rows:28});
  assert.match(detail,/CHECK_USAGE/);
  assert.match(detail,/src\/test.java:15/);
  state=updateTuiState(state,'escape',3,context);
  state=updateTuiState(state,'escape',3,context);
  assert.equal(state.view,'overview');
  assert.equal(reviewSessionDraft(catalog,state).write_authorized,false);
});

test('local-only scope is marked not evaluated, not falsely declared clean',()=>{
  const state=updateTuiState(initialTuiState({guided:true}),'h',3,{scopeCount:0});
  const text=renderReviewTui(catalog,state,{colors:false,rows:22,
    localScan:{skill_count:1},scopeHints:null});
  assert.match(text,/Scope non valutato/);
  assert.match(text,/Nessuna diagnosi disponibile/);
});

test('compact terminal keeps Apply disabled warning visible',()=>{
  const plain=renderReviewTui(catalog,initialTuiState(),{
    colors:false,columns:40,rows:14});
  assert.match(plain,/G DISABILITATO/);
  assert.ok(plain.split('\n').length<=14);
});

test('search typing q and s is not interpreted as quit or saving a draft',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-input-'));
  try{
    fs.writeFileSync(path.join(folder,'repair-proposals.json'),JSON.stringify(source));
    const input=new PassThrough();
    input.isTTY=true;
    input.setRawMode=()=>{};
    let terminal='';
    const output={isTTY:true,columns:100,rows:25,write:x=>{terminal+=x;}};
    const session=runReviewTui(folder,{input,output});
    input.emit('keypress','\r',{name:'return'});
    input.emit('keypress','/',{name:'/'});
    input.emit('keypress','q',{name:'q'});
    input.emit('keypress','s',{name:'s'});
    assert.match(terminal,/Ricerca qs \[scrivi e premi INVIO\]/);
    assert.equal(fs.existsSync(path.join(folder,'review-session.json')),false);
    input.emit('keypress','\r',{name:'return'});
    assert.match(terminal,/Ricerca qs/);
    input.emit('keypress','q',{name:'q'});
    const draft=await session;
    assert.equal(draft.write_authorized,false);
    assert.deepEqual(draft.selected_ids,[]);
    assert.equal(fs.existsSync(path.join(folder,'review-session.json')),false);
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
});


test('batch actions affect visible proposals only, preserving hidden selections and stable IDs',()=>{
  const context={items:catalog.items};
  let state=initialTuiState({guided:true});
  state=updateTuiState(state,'enter',3,context);
  state=updateTuiState(state,'a',3,context);
  assert.deepEqual(state.selected,[0,1,2]);
  state=updateTuiState(state,'f',3,context); // UPDATE [0,1]
  state=updateTuiState(state,'b',3,context); // discard only UPDATE
  assert.deepEqual(state.selected,[2]);
  assert.deepEqual(state.discarded,[0,1]);
  state=updateTuiState(state,'a',3,context);
  assert.deepEqual(state.selected,[2]); // no selecting discarded entries
  state=updateTuiState(state,'t',3,context);
  assert.deepEqual(state.discarded,[]);
  assert.deepEqual(state.selected,[2]); // restore never implicitly selects
  state=updateTuiState(state,'i',3,context);
  assert.deepEqual(state.selected,[0,1,2]);
  state=updateTuiState(state,'f',3,context); // CREATE: no matches
  state=updateTuiState(state,'b',3,context);
  state=updateTuiState(state,'i',3,context);
  assert.deepEqual(state.selected,[0,1,2]);
  assert.deepEqual(state.discarded,[]);
  state=updateTuiState(state,'f',3,context); // MOVE
  state=updateTuiState(state,'i',3,context);
  assert.deepEqual(state.selected,[0,1]);
  state=updateTuiState(state,'n',3,context);
  assert.deepEqual(state.selected,[]);
  const result=reviewSessionDraft(catalog,state);
  assert.equal(result.write_authorized,false);
  assert.equal(result.applied_count,0);
});

test('TUI resumes exact matching selection draft, then saves revised state',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-resume-tui-'));
  try{
    fs.writeFileSync(path.join(folder,'repair-proposals.json'),JSON.stringify(source));
    const previous=reviewSessionDraft(catalog,{...initialTuiState(),selected:[2],discarded:[0]});
    fs.writeFileSync(path.join(folder,'review-session.json'),JSON.stringify(previous));
    const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
    let terminal='';
    const output={isTTY:true,columns:100,rows:22,write:s=>{terminal+=s;}};
    const done=runReviewTui(folder,{input,output});
    assert.match(terminal,/Bozza ripresa: 1 selezionate, 1 scartate/);
    assert.match(terminal,/Esamina le proposte locali \(3\)/);
    input.emit('keypress','\r',{name:'return'});
    input.emit('keypress','t',{name:'t'}); // restore visible previously discarded
    input.emit('keypress','s',{name:'s'});
    assert.match(terminal,/Bozza salvata/);
    input.emit('keypress','q',{name:'q'});
    const result=await done;
    assert.deepEqual(result.selected_ids,['c']);
    assert.deepEqual(result.discarded_ids,[]);
    assert.equal(result.write_authorized,false);
    const saved=JSON.parse(fs.readFileSync(path.join(folder,'review-session.json'),'utf8'));
    assert.deepEqual(saved.selected_ids,['c']);
    assert.deepEqual(saved.discarded_ids,[]);
    assert.equal(saved.write_authorized,false);
    assert.equal(saved.applied_count,0);
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
});

test('stale catalog draft is rejected with visible warning and no partial restoration',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-stale-tui-'));
  try{
    fs.writeFileSync(path.join(folder,'repair-proposals.json'),JSON.stringify(source));
    const previous=reviewSessionDraft(catalog,{...initialTuiState(),selected:[0]});
    fs.writeFileSync(path.join(folder,'review-session.json'),JSON.stringify({
      ...previous,catalog_sha256:'0'.repeat(64)}));
    const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
    let terminal='';
    const output={isTTY:true,columns:108,rows:23,write:s=>{terminal+=s;}};
    const done=runReviewTui(folder,{input,output});
    assert.match(terminal,/Ripresa rifiutata:.*audit cambiato/);
    assert.match(terminal,/Esamina le proposte locali \(3\)/);
    input.emit('keypress','q',{name:'q'});
    const result=await done;
    assert.deepEqual(result.selected_ids,[]);
    assert.equal(result.write_authorized,false);
    // Malformed draft remains untouched unless user explicitly saves.
    assert.match(fs.readFileSync(path.join(folder,'review-session.json'),'utf8'),/00000000000000/);
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
});

test('TUI does not follow symlinked draft on save',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-symlink-tui-'));
  try{
    fs.writeFileSync(path.join(folder,'repair-proposals.json'),JSON.stringify(source));
    const outside=path.join(folder,'outside.txt');
    fs.writeFileSync(outside,'preserve me');
    fs.symlinkSync(outside,path.join(folder,'review-session.json'));
    const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
    let terminal='';
    const output={isTTY:true,columns:110,rows:24,write:s=>{terminal+=s;}};
    const done=runReviewTui(folder,{input,output});
    assert.match(terminal,/Ripresa rifiutata/);
    input.emit('keypress','s',{name:'s'});
    assert.match(terminal,/Salvataggio non riuscito/);
    input.emit('keypress','q',{name:'q'});
    await done;
    assert.equal(fs.readFileSync(outside,'utf8'),'preserve me');
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
});


test('batch confirmation lists every selected destination with scroll, one Y for entire lot',()=>{
  const fakeCandidates=Array.from({length:12},(_,i)=>({
    proposal_id:'p-'+i,repo:'example/repo',path:'skills/skill-'+i+'/SKILL.md',
    before_sha256:'a'.repeat(64),after_sha256:'b'.repeat(64)
  }));
  const state={...initialTuiState({guided:true}),view:'confirm-apply',
    pendingApply:{candidates:fakeCandidates},scroll:0};
  const top=renderReviewTui(catalog,state,{colors:false,columns:88,rows:14});
  assert.match(top,/CONFERMA UNICA/);
  assert.match(top,/12 FILE/);
  assert.match(top,/Righe 1–\d+\/36/);
  assert.match(top,/Y APPLICA TUTTO IL LOTTO/);
  assert.match(top,/skills\/skill-0\/SKILL.md/);
  const tail=renderReviewTui(catalog,{...state,scroll:999},
    {colors:false,columns:88,rows:14});
  assert.match(tail,/Righe \d+–36\/36/);
  assert.match(tail,/skills\/skill-11\/SKILL.md/);
  assert.doesNotMatch(tail,/skills\/skill-0\/SKILL.md/);
});
