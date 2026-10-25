import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {createLocalScan} from '../src/local-scan.mjs';
import {runReviewTui,renderReviewTui,initialTuiState} from '../src/review-tui.mjs';
import {buildReviewCatalog} from '../src/review-selection.mjs';
import {overviewActions} from '../src/tui-menu.mjs';

function setup(t,rows=24,columns=88){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-project-menu-'));
  t.after(()=>fs.rmSync(home,{force:true,recursive:true}));
  const first=path.join(home,'first'),second=path.join(home,'second');
  fs.mkdirSync(first);fs.mkdirSync(path.join(second,'resources'),{recursive:true});
  fs.writeFileSync(path.join(second,'resources','rules.md'),
    '# Orders\nBefore approval, the operator must check the documented order status.\n');
  const audit=path.join(home,'audit');createLocalScan(first,{out:audit});
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
  let screen='';
  const output={isTTY:true,rows,columns,write(s){screen=s;}};
  const key=name=>input.emit('keypress',name==='return'?'\r':name,{name});
  const type=value=>{for(const ch of value)input.emit('keypress',ch,{name:ch});};
  return {home,first,second,audit,input,output,key,type,screen:()=>screen};
}

test('guided menu offers project choice and documented resources without a CLI flag',()=>{
  const options=overviewActions({canChooseProject:true,canUseDomain:true,
    modelConfigured:true,providerPickerEnabled:true,proposalCount:0,
    projectLabel:'/tmp/example'});
  assert.deepEqual(options.map(o=>o.id),['audit','proposals','provider','domain','project']);
  assert.match(options.find(o=>o.id==='domain').title,/risorse documentali/);
  assert.match(options.find(o=>o.id==='project').description,/tmp\/example/);
});
test('TUI switches to a different repository without calling an LLM or modifying either source',async t=>{
  const x=setup(t);let calls=0;
  const task=runReviewTui(x.audit,{consumerRoot:x.first,input:x.input,output:x.output,
    providerFactory:()=>{calls++;return {completeJson:async()=>({})};}});
  try{
    assert.match(x.screen(),/Crea e verifica skill dalle risorse documentali/);
    assert.match(x.screen(),/Scegli il progetto da analizzare/);
    for(let i=0;i<4;i++)x.key('down');
    x.key('return');
    assert.match(x.screen(),/SCEGLI PROGETTO/);
    x.type('/no/such/directory');
    x.key('return');
    assert.match(x.screen(),/Impossibile aprire il progetto/);
    x.key('escape');
    assert.match(x.screen(),/COSA VUOI FARE/);
    x.key('return');
    assert.match(x.screen(),/SCEGLI PROGETTO/);
    x.type(x.second);
    x.key('return');
    assert.match(x.screen(),/Progetto selezionato/);
    assert.match(x.screen(),/Repository: /);
    assert.match(x.screen(),/second/);
    assert.equal(calls,0);
    assert.equal(fs.existsSync(path.join(x.first,'skills')),false);
    assert.equal(fs.existsSync(path.join(x.second,'skills')),false);
    for(let i=0;i<3;i++)x.key('down');
    x.key('return');
    assert.match(x.screen(),/Dove sono le resources/);
    x.key('escape');
    assert.equal(calls,0);
  }finally{x.key('q');await task;}
});
test('tiny 60x12 viewport shows project and domain choices without scrolling',()=>{
  const catalog=buildReviewCatalog({consumer_repo:'local/example',proposals:[]});
  const screen=renderReviewTui(catalog,initialTuiState({guided:true}),{
    columns:60,rows:12,colors:false,canChooseProject:true,canUseDomain:true,
    projectRoot:'/tmp/example',modelConfigured:true,providerPickerEnabled:true,
    providerSelection:{provider:'copilot',model:'auto'},localScan:{skill_count:0}
  });
  assert.equal(screen.split('\n').length,12);
  assert.match(screen,/Crea e verifica skill dalle risorse documentali/);
  assert.match(screen,/Scegli il progetto da analizzare/);
});
