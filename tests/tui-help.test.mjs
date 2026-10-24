import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {commandHints,HELP_LINES} from '../src/tui-help.mjs';
import {renderReviewTui,initialTuiState,runReviewTui}
  from '../src/review-tui.mjs';
import {buildReviewCatalog} from '../src/review-selection.mjs';
import {createLocalScan} from '../src/local-scan.mjs';

const empty=buildReviewCatalog({
  schema_version:1,consumer_repo:'local/demo',proposals:[]
});
function render(view,options={}){
  return renderReviewTui(empty,{
    ...initialTuiState({guided:true}),view,...options.state
  },{
    columns:options.columns??100,rows:options.rows??18,colors:false,
    editorConfigured:true,modelConfigured:true,providerPickerEnabled:true,
    providerSelection:{provider:'copilot',model:'auto'},
    ...options.props
  });
}
test('overview always tells the user how to start analysis and read help',()=>{
  const screen=render('overview',{rows:14});
  assert.match(screen,/Scansione strutturale completata/);
  assert.match(screen,/Esamina le proposte locali/);
  assert.match(screen,/Analizza le skill con l’AI/);
  assert.match(screen,/\? Aiuto/);
  assert.match(screen,/COSA VUOI FARE/);
  assert.ok(screen.split('\n').length<=14);
});
test('footer stays visible on long semantic results, on small terminal',()=>{
  const findings=Array.from({length:44},(_,i)=>({
    claim_id:'c'+i,skill:'some-skill/SKILL.md',skill_line:i+1,
    statement:'Synthetic test claim '+i,
    assessment:'SUSPECTED_CONTRADICTION'
  }));
  const screen=render('semantic-list',{
    columns:72,rows:14,
    props:{semanticAudit:{findings,claims_checked:44,proposed_updates:22}}
  });
  const lines=screen.split('\n');
  assert.ok(lines.length<=14);
  assert.match(lines.at(-2),/ESC Menu/);
  assert.match(lines.at(-1),/Esamina le proposte/);
  assert.ok(lines.some(s=>s.includes('SOSPETTA')));
});
test('model picker instructions cannot disappear below long model lists',()=>{
  const many=Array.from({length:35},(_,i)=>'some-long-model-'+i);
  const screen=render('overview',{rows:14,props:{
    providerWizard:{step:'models',draft:{provider:'ollama',
      baseUrl:'http://127.0.0.1:11434/v1'},
      models:many,modelCursor:17}
  }});
  const lines=screen.split('\n');
  assert.ok(lines.length<=14);
  assert.match(lines.at(-2),/INVIO Scegli modello/);
  assert.match(lines.at(-1),/ESC Torna/);
});
test('help advertises the safety boundary; confirmation keys not confused with staging',()=>{
  assert.ok(HELP_LINES.some(s=>s.includes('La selezione NON autorizza Apply')));
  const footer=commandHints('confirm-apply',{});
  assert.match(footer[0],/Y APPLICA TUTTO IL LOTTO/);
  assert.match(footer[0],/ESC ANNULLA/);
  const screen=render('confirm-apply',{state:{pendingApply:{
    candidates:[{operation:'UPDATE',repo:'demo',path:'skill/SKILL.md',
      before_sha256:'a'.repeat(64),after_sha256:'b'.repeat(64)}],
    selected_ids:['id']
  }}});
  assert.match(screen.split('\n').at(-2),/Y APPLICA TUTTO IL LOTTO/);
});
test('help opens with ?, scrolls, and ESC returns to the prior view',async t=>{
  const source=new URL('./fixtures/retrieval-typescript/',import.meta.url).pathname;
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-tui-help-'));
  t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const audit=path.join(tmp,'scan');
  createLocalScan(source,{out:audit});
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
  const output={isTTY:true,columns:100,rows:16,rendered:'',
    write(s){this.rendered=s;}};
  const session=runReviewTui(audit,{consumerRoot:source,input,output});
  assert.match(output.rendered,/COSA VUOI FARE/);
  input.emit('keypress','?',{name:'?'});
  assert.match(output.rendered,/AIUTO · COMANDI/);
  assert.match(output.rendered,/\? Torna/);
  input.emit('keypress','ArrowDown',{name:'down'});
  assert.match(output.rendered,/AIUTO · COMANDI/);
  input.emit('keypress','\u001b',{name:'escape'});
  assert.match(output.rendered,/COSA VUOI FARE/);
  input.emit('keypress','\r',{name:'return'});
  assert.match(output.rendered,/Filtro/);
  input.emit('keypress','?',{name:'?'});
  assert.match(output.rendered,/AIUTO · COMANDI/);
  input.emit('keypress','?',{name:'?'});
  assert.match(output.rendered,/Filtro/);
  input.emit('keypress','q',{name:'q'});
  await session;
});


test('long terminal: footer occupies the final rows, never floats after content',()=>{
  const tall=render('semantic-list',{rows:36,columns:110,
    props:{semanticAudit:{claims_checked:2,proposed_updates:1,
      findings:[{skill:'.agents/skills/a/SKILL.md',skill_line:5,
        statement:'An instruction that might be wrong',
        assessment:'SUSPECTED_CONTRADICTION'}]}}
  });
  const lines=tall.split('\n');
  assert.equal(lines.length,36);
  assert.ok(lines.some(line=>line.includes('SOSPETTA')));
  assert.match(lines[33],/^─+$/);
  assert.match(lines[34],/INVIO Leggi prove/);
  assert.match(lines[35],/Per preparare una bozza/);
  assert.equal(lines.slice(9,33).filter(line=>/↑↓ Naviga|INVIO Dettagli|ESC Torna/.test(line)).length,0);
  assert.ok(lines.slice(8,33).some(line=>line===''));
});

test('long terminal: help scrolls while staying inside a fixed 36-row viewport',()=>{
  const first=render('help',{rows:36,columns:110});
  const end=render('help',{rows:36,columns:110,state:{scroll:9}});
  for(const screen of [first,end]){
    const lines=screen.split('\n');
    assert.equal(lines.length,36);
    assert.match(lines[33],/^─+$/);
    assert.match(lines[34],/ESC \/ INVIO \/ \? Torna/);
  }
  assert.match(first,/COME FUNZIONA/);
  assert.match(end,/SCORCIATOIE AVANZATE/);
  assert.match(end,/Sezione 10/);
  assert.equal(first.split('\n').filter(line=>line.includes('↑↓ Scorri')).length,1);
});

test('provider picker keeps exactly one shortcut legend, fixed at the bottom',()=>{
  const screen=render('overview',{rows:35,columns:110,
    props:{providerWizard:{step:'model',draft:{provider:'ollama',
      baseUrl:'http://127.0.0.1:11434/v1'},text:'example-model'}}});
  const lines=screen.split('\n');
  assert.equal(lines.length,35);
  assert.match(lines.at(-2),/TAB Elenca modelli/);
  assert.equal(lines.filter(line=>line.includes('TAB Elenca modelli')).length,1);
});

test('TUI screen redraw does not append a newline that scrolls a full viewport',async t=>{
  const source=new URL('./fixtures/retrieval-typescript/',import.meta.url).pathname;
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-tui-no-scroll-'));
  t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const audit=path.join(tmp,'scan');
  createLocalScan(source,{out:audit});
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
  const frames=[];
  const output={isTTY:true,columns:110,rows:28,write:s=>{frames.push(s);}};
  const task=runReviewTui(audit,{consumerRoot:source,input,output});
  let redraws=frames.filter(frame=>frame.startsWith('\x1b[2J\x1b[H'));
  assert.equal(redraws.length,1);
  assert.ok(!redraws[0].endsWith('\n'));
  input.emit('keypress','?',{name:'?'});
  redraws=frames.filter(frame=>frame.startsWith('\x1b[2J\x1b[H'));
  assert.equal(redraws.length,2);
  assert.ok(!redraws[1].endsWith('\n'));
  input.emit('keypress','q',{name:'q'}); // help: q should not close
  input.emit('keypress','\u001b',{name:'escape'});
  input.emit('keypress','q',{name:'q'});
  await task;
});


test('empty structural result points to K rather than presenting zero suggestions as complete',()=>{
  const text=render('overview',{
    rows:35,
    props:{localScan:{skill_count:2},providerSelection:{
      provider:'ollama',model:'deepseek-v4.1-flash:cloud',
      baseUrl:'http://127.0.0.1:11434/v1'}}
  });
  assert.match(text,/Scansione strutturale completata/);
  assert.match(text,/Audit semantico: non ancora eseguito/);
  assert.match(text,/❯ Analizza le skill con l’AI/);
  assert.match(text,/Esamina le proposte locali \(0\)/);
  assert.doesNotMatch(text,/CREATE 0  UPDATE 0  MOVE 0  REMOVE 0/);
  assert.equal(text.split('\n').filter(x=>x.includes('❯ ')).length,1);
});

test('after semantic triage, next action becomes J, with visible hypothesis count',()=>{
  const text=render('overview',{rows:35,props:{
    semanticAudit:{claims_checked:2,proposed_updates:1,findings:[]},
    localScan:{skill_count:2}
  }});
  assert.match(text,/Audit LLM: 2 claim/);
  assert.match(text,/1 ipotesi UPDATE/);
  assert.match(text,/❯ Esamina i risultati dell’analisi/);
  assert.doesNotMatch(text,/❯ Analizza le skill con l’AI/);
  assert.match(text,/J Risultati/);
});

test('help is contextual rather than dumping every command in the initial overview',()=>{
  const screen=render('help',{rows:35,state:{helpReturnView:'overview'}});
  assert.match(screen,/IN QUESTA SCHERMATA/);
  assert.match(screen,/QUI: ↑↓ sceglie fra analizzare/);
  assert.match(screen,/SCORCIATOIE AVANZATE/);
  assert.ok(!screen.includes('ALTRE AZIONI: B scarta visibili'));
  const list=render('help',{rows:35,state:{helpReturnView:'list'}});
  assert.match(list,/QUI: nella vista larga TAB cambia pannello/);
});


test('offline review without client does not advertise an unavailable semantic model',()=>{
  const screen=render('overview',{rows:35,props:{
    modelConfigured:false,providerPickerEnabled:false
  }});
  assert.match(screen,/Esamina le proposte locali/);
  assert.doesNotMatch(screen,/Analizza le skill con l’AI/);
  assert.match(screen,/↑↓ Scegli/);
});
