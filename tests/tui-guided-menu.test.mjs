import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {createLocalScan} from '../src/local-scan.mjs';
import {runReviewTui,renderReviewTui,initialTuiState} from '../src/review-tui.mjs';
import {overviewActions,activeOverviewChoice,moveOverviewChoice} from '../src/tui-menu.mjs';
import {buildReviewCatalog} from '../src/review-selection.mjs';

const fixture=new URL('./fixtures/retrieval-typescript/',import.meta.url).pathname;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function env(t){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-guided-overview-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const audit=path.join(temp,'audit');
  createLocalScan(fixture,{out:audit});
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
  const screens=[];
  const output={isTTY:true,rows:28,columns:110,write(s){screens.push(s);}};
  const key=name=>input.emit('keypress',name==='return'?'\r':name,{name});
  const screen=()=>screens.at(-1)??'';
  return {audit,input,output,key,screen};
}
test('pure menu picks next valid action as audit becomes available or report exists',()=>{
  const a=overviewActions({modelConfigured:true,providerPickerEnabled:true,proposalCount:0,
    modelLabel:'Copilot · auto'});
  assert.deepEqual(a.map(x=>x.id),['audit','proposals','provider']);
  assert.match(a[0].description,/Copilot/);
  assert.equal(activeOverviewChoice(a).id,'audit');
  assert.equal(moveOverviewChoice(a,null,1),'proposals');
  assert.equal(moveOverviewChoice(a,'proposals',1),'provider');
  assert.equal(moveOverviewChoice(a,'provider',1),'provider');
  assert.equal(moveOverviewChoice(a,'audit',-1),'audit');
  const report=overviewActions({hasSemanticReport:true,modelConfigured:true,
    providerPickerEnabled:true,proposalCount:1});
  assert.deepEqual(report.map(x=>x.id),['results','proposals','provider']);
  assert.equal(activeOverviewChoice(report,'audit').id,'results');
  assert.deepEqual(overviewActions({modelConfigured:false,proposalCount:2})
    .map(x=>x.id),['proposals']);
});
test('guided overview is readable, not a wall of state counters; small terminal retains choices',()=>{
  const empty=buildReviewCatalog({consumer_repo:'local/example',proposals:[]});
  const screen=renderReviewTui(empty,initialTuiState({guided:true}),{
    columns:74,rows:14,colors:false,modelConfigured:true,
    providerPickerEnabled:true,providerSelection:{provider:'copilot',model:'auto'},
    localScan:{skill_count:2}
  });
  assert.match(screen,/2 skill individuate/);
  assert.match(screen,/Scansione strutturale completata/);
  assert.match(screen,/COSA VUOI FARE/);
  assert.match(screen,/❯ Analizza le skill con l’AI/);
  assert.match(screen,/Esamina le proposte locali \(0\)/);
  assert.match(screen,/Cambia modello/);
  assert.match(screen,/↑↓ Scegli/);
  assert.ok(screen.split('\n').length<=14);
  assert.doesNotMatch(screen,/Selezionate 0   Scartate/);
});
test('arrows and Enter open proposals or provider without contacting a model',async t=>{
  const x=env(t);let calls=0;
  const task=runReviewTui(x.audit,{consumerRoot:fixture,input:x.input,output:x.output,
    providerFactory:()=>{calls++;return {completeJson:async()=>({})};}});
  assert.match(x.screen(),/❯ Analizza le skill/);
  x.key('down');
  assert.match(x.screen(),/❯ Esamina le proposte locali/);
  x.key('return');
  assert.match(x.screen(),/Filtro/);
  x.key('escape');
  x.key('down');
  assert.match(x.screen(),/❯ Cambia modello/);
  x.key('return');
  assert.match(x.screen(),/1  GitHub Copilot/);
  x.key('escape');
  assert.match(x.screen(),/COSA VUOI FARE/);
  assert.equal(calls,0);
  x.key('q');await task;
  assert.equal(fs.existsSync(path.join(x.audit,'apply-result.json')),false);
});
test('Enter on the recommended action runs a model only after explicit keypress, then opens results',async t=>{
  const x=env(t);let calls=0;
  const source=fs.readFileSync(path.join(fixture,'src/parse-result.ts'));
  const client={
    provider:'fixture-mock',model:'fake',
    async completeJson(){
      calls++;
      return {verdict:'INSUFFICIENT_EVIDENCE',reason:'Not enough evidence',citation:null};
    }
  };
  const task=runReviewTui(x.audit,{consumerRoot:fixture,input:x.input,output:x.output,
    providerFactory:()=>client});
  assert.equal(calls,0);
  assert.match(x.screen(),/❯ Analizza le skill/);
  x.key('return');
  for(let i=0;i<50&&!x.screen().includes('DIAGNOSI SEMANTICA');i++)await tick();
  assert.equal(calls,2);
  assert.match(x.screen(),/DIAGNOSI SEMANTICA/);
  x.key('escape');
  assert.match(x.screen(),/❯ Esamina i risultati dell’analisi/);
  x.key('return');
  assert.match(x.screen(),/DIAGNOSI SEMANTICA/);
  assert.equal(calls,2);
  assert.deepEqual(fs.readFileSync(path.join(fixture,'src/parse-result.ts')),source);
  assert.equal(fs.existsSync(path.join(x.audit,'review-candidates.json')),false);
  x.key('q');await task;
  assert.equal(fs.existsSync(path.join(x.audit,'apply-result.json')),false);
});


test('selecting a model returns focus to the recommended audit, without inference',async t=>{
  const x=env(t);let factories=0;
  const task=runReviewTui(x.audit,{consumerRoot:fixture,input:x.input,output:x.output,
    providerFactory:()=>{factories++;return {};}});
  x.key('down');x.key('down');
  assert.match(x.screen(),/❯ Cambia modello/);
  x.key('return');
  assert.match(x.screen(),/1  GitHub Copilot/);
  x.key('1');x.key('return');
  assert.match(x.screen(),/❯ Analizza le skill con l’AI/);
  assert.equal(factories,0);
  x.key('q');await task;
});

test('shortcut K resets a previous menu selection to the results recommendation',async t=>{
  const x=env(t);
  const client={provider:'simulated',model:'fixture',async completeJson(){
    return {verdict:'INSUFFICIENT_EVIDENCE',reason:'Unverified',citation:null};
  }};
  const task=runReviewTui(x.audit,{consumerRoot:fixture,input:x.input,output:x.output,
    providerFactory:()=>client});
  x.key('down');
  assert.match(x.screen(),/❯ Esamina le proposte locali/);
  x.key('k');
  for(let n=0;n<60&&!x.screen().includes('DIAGNOSI SEMANTICA');n++)await tick();
  assert.match(x.screen(),/DIAGNOSI SEMANTICA/);
  x.key('escape');
  assert.match(x.screen(),/❯ Esamina i risultati dell’analisi/);
  x.key('q');await task;
});


test('60x12 terminal never renders more than 12 frame rows, including blank padding',()=>{
  const proposals=[{
    id:'small-terminal-review',action:'UPDATE',title:'Inspect a proposed change',
    source:{repo:'local/example',path:'.agents/skills/example/SKILL.md'},
    target:{repo:'local/example',path:'.agents/skills/example/SKILL.md'},
    reason:'A synthetic source reference requires review'
  }];
  const previews={consumer_repo:'local/example',previews:[{
    proposal_id:'small-terminal-review',status:'PREVIEW_READY',
    diff:'--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1,3 +1,3 @@\n-old\n+new\n'+
      Array.from({length:12},(_,i)=>' line '+i).join('\n')
  }]};
  const catalog=buildReviewCatalog({consumer_repo:'local/example',proposals},{previews});
  const base=initialTuiState({guided:true});
  const opts={columns:60,rows:12,colors:false,previews,localScan:{skill_count:1},
    modelConfigured:true,providerPickerEnabled:true,
    providerSelection:{provider:'copilot',model:'auto'}};
  const states=[
    {name:'overview',state:base},
    {name:'list',state:{...base,view:'list'}},
    {name:'detail',state:{...base,view:'detail'}},
    {name:'preview',state:{...base,view:'preview'}},
    {name:'scrolled preview',state:{...base,view:'preview',scroll:12}},
    {name:'help',state:{...base,view:'help',helpReturnView:'list'}},
    {name:'provider picker',state:base,
      opts:{providerWizard:{step:'menu',returnView:'overview',text:'',draft:null}}},
    {name:'confirmation',state:{...base,view:'confirm-apply',
      pendingApply:{candidates:[],selected_ids:[]}}}
  ];
  for(const {name,state,opts:more={}} of states){
    const frame=renderReviewTui(catalog,state,{...opts,...more});
    const lines=frame.split('\n');
    assert.equal(lines.length,12,name+': emitted '+lines.length+' rows');
    assert.ok(lines.every(line=>line.length<=60),name+': exceeded 60 columns');
    assert.ok(lines.at(-1).length>0,name+': missing last footer hint');
  }
  const overview=renderReviewTui(catalog,base,opts);
  assert.match(overview,/Analizza le skill con l’AI/);
  assert.match(overview,/Esamina le proposte locali/);
  assert.match(overview,/Cambia modello/);
  assert.match(overview,/COSA VUOI FARE/);
});

test('live 60x12 TTY navigates list and preview without model or Apply',async t=>{
  const x=env(t);
  x.output.rows=12;
  x.output.columns=60;
  const task=runReviewTui(x.audit,{consumerRoot:fixture,input:x.input,output:x.output});
  function assertViewport(label){
    const screen=x.screen().replace(/^\x1b\[2J\x1b\[H/,'');
    assert.equal(screen.split('\n').length,12,label+': frame rows');
  }
  try{
    assertViewport('overview');
    x.key('return');
    assertViewport('list');
    x.key('p');
    assertViewport('preview');
    x.key('escape');
    assertViewport('back-to-list');
    assert.equal(fs.existsSync(path.join(x.audit,'apply-result.json')),false);
  }finally{x.key('q');await task;}
});

test('60x12 preview exposes its final line within 24 down keys without Apply',()=>{
  const proposal={id:'p',action:'UPDATE',title:'Review broken references',
    source:{repo:'local/demo',path:'.agents/skills/demo/SKILL.md'},
    target:{repo:'local/demo',path:'.agents/skills/demo/SKILL.md'}};
  const diff=Array.from({length:23},(_,i)=>' line '+String(i).padStart(2,'0')).join('\n')+
    '\n+PREVIEW-END-12 — final candidate line, still a fixture.';
  const previews={consumer_repo:'local/demo',previews:[{
    proposal_id:'p',status:'PREVIEW_READY',diff
  }]};
  const catalog=buildReviewCatalog({consumer_repo:'local/demo',proposals:[proposal]},{previews});
  const options={columns:60,rows:12,colors:false,previews,
    providerPickerEnabled:true,providerSelection:{provider:'copilot',model:'auto'}};
  const state={...initialTuiState({guided:true}),view:'preview',cursor:0,
    notice:'Staged synthetic candidate, not approved',scroll:24};
  const frame=renderReviewTui(catalog,state,options);
  assert.equal(frame.split('\n').length,12);
  assert.match(frame,/PREVIEW-END-12/,'Final candidate line should be visible after 24 down keys');
  assert.match(frame,/G → Y/,'Human confirmation remains separate');
});
