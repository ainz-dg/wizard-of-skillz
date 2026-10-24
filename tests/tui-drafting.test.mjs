import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {runReviewTui} from '../src/review-tui.mjs';
import {stageUpdateText} from '../src/review-candidates.mjs';

function project({multiple=false}={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-tui-draft-'));
  const source=path.join(home,'project'),audit=path.join(home,'audit');
  const rel='.agents/skills/demo/SKILL.md';
  const file=path.join(source,rel);
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(audit);
  const before='---\nname: demo\ndescription: sample skill\n---\nOld step one.\nOld step two.\n';
  const after=before.replace('Old step one.','New step one.').replace('Old step two.','New step two.');
  fs.writeFileSync(file,before);
  const ids=multiple?['fix-one','fix-two']:['fix-one'];
  const proposals={consumer_repo:'demo/project',proposals:ids.map(id=>({
    id,action:'UPDATE',title:'Review '+id,
    source:{repo:'demo/project',path:rel},
    target:{repo:'demo/project',path:rel},reason:'Update instruction '+id,
    steps:['Review instruction'],evidence:[]
  }))};
  fs.writeFileSync(path.join(audit,'repair-proposals.json'),JSON.stringify(proposals));
  return {home,source,audit,file,ids,before,after};
}
function terminal(){
  const input=new PassThrough();
  input.isTTY=true;
  const raw=[];
  input.setRawMode=value=>raw.push(value);
  const output={isTTY:true,columns:112,rows:28,text:'',
    write(value){this.text+=value;}};
  const key=name=>input.emit('keypress',name==='return'?'\r':name,{name});
  return {input,output,raw,key};
}
const cleanup=p=>fs.rmSync(p.home,{recursive:true,force:true});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('E edits in external temporary copy, P refreshes, then G/Y applies only after approval',async()=>{
  const p=project(),t=terminal();
  try{
    const editor=path.join(p.home,'editor.mjs');
    fs.writeFileSync(editor,
      '#!/usr/bin/env node\nimport fs from "node:fs";\n'+
      'const file=process.argv[2];\n'+
      'fs.writeFileSync(file,fs.readFileSync(file,"utf8").replace("Old step one.","New step one."));\n');
    fs.chmodSync(editor,0o700);
    const session=runReviewTui(p.audit,{consumerRoot:p.source,
      editor:process.execPath+' '+editor,input:t.input,output:t.output});
    t.key('return'); // overview -> inbox
    t.key('e'); // edit temporary snapshot
    assert.match(t.output.text,/CANDIDATO UTENTE/);
    assert.match(t.output.text,/\+New step one\./);
    assert.equal(fs.readFileSync(p.file,'utf8'),p.before);
    assert.deepEqual(t.raw,[true,false,true]);
    t.key('escape'); // preview -> inbox
    t.key('space');
    t.key('g');
    assert.match(t.output.text,/CONFERMA UNICA.*1 FILE/);
    assert.equal(fs.readFileSync(p.file,'utf8'),p.before);
    t.key('y');
    t.key('q');
    await session;
    assert.match(fs.readFileSync(p.file,'utf8'),/New step one\./);
    assert.deepEqual(t.raw,[true,false,true,false]);
    assert.equal(fs.readdirSync(p.audit).filter(x=>x.startsWith('apply-result-')).length,1);
    assert.equal(fs.readdirSync(p.audit).filter(x=>x.startsWith('.wizard-draft-')).length,0);
  }finally{cleanup(p);}
});

test('M disabled by default, enabled model drafts selected same-file proposals as one candidate',async()=>{
  const p=project({multiple:true}),t=terminal();
  try{
    let calls=0,closed=0,proposals=[];
    const session=runReviewTui(p.audit,{consumerRoot:p.source,input:t.input,
      output:t.output,clientFactory:()=>({
        completeJson:async({user})=>{
          calls++;proposals=JSON.parse(user).proposals.map(x=>x.id);
          return {status:'READY',content:p.after};
        },close:async()=>{closed++;}
      })});
    t.key('down');t.key('return');t.key('a');t.key('m');
    await tick();await tick();
    assert.equal(calls,1);
    assert.deepEqual(proposals,['fix-one','fix-two']);
    assert.equal(closed,1);
    assert.match(t.output.text,/CANDIDATO UTENTE/);
    assert.equal(fs.readFileSync(p.file,'utf8'),p.before);
    t.key('escape');t.key('g');
    assert.match(t.output.text,/SCRITTURA REALE SU 1 FILE/);
    assert.match(t.output.text,/Proposte confermate: 2/);
    t.key('y');t.key('q');
    await session;
    assert.equal(fs.readFileSync(p.file,'utf8'),p.after);
    const report=JSON.parse(fs.readFileSync(path.join(p.audit,
      fs.readdirSync(p.audit).find(x=>x.startsWith('apply-result-'))),'utf8'));
    assert.equal(report.selected_count,2);
    assert.equal(report.file_count,1);
  }finally{cleanup(p);}
});

test('M without explicit client opt-in never calls provider nor stages a candidate',async()=>{
  const p=project(),t=terminal();
  try{
    const session=runReviewTui(p.audit,{consumerRoot:p.source,input:t.input,
      output:t.output});
    t.key('return');t.key('m');
    assert.match(t.output.text,/configura prima un modello con L/);
    assert.equal(fs.existsSync(path.join(p.audit,'review-candidates.json')),false);
    assert.equal(fs.readFileSync(p.file,'utf8'),p.before);
    t.key('q');await session;
  }finally{cleanup(p);}
});

test('editor reopens the staged draft rather than erasing previous changes',async()=>{
  const p=project(),t=terminal();
  try{
    const first=p.before.replace('Old step one.','New step one.');
    stageUpdateText(p.audit,{consumerRoot:p.source,proposalId:p.ids[0],content:first});
    const editor=path.join(p.home,'second-pass.mjs');
    fs.writeFileSync(editor,
      '#!/usr/bin/env node\nimport fs from "node:fs";\n'+
      'const file=process.argv[2];\n'+
      'fs.writeFileSync(file,fs.readFileSync(file,"utf8").replace("Old step two.","New step two."));\n');
    const session=runReviewTui(p.audit,{consumerRoot:p.source,input:t.input,
      output:t.output,editor:process.execPath+' '+editor});
    t.key('return');t.key('e');
    assert.equal(fs.readFileSync(p.file,'utf8'),p.before);
    const manifest=JSON.parse(fs.readFileSync(path.join(p.audit,'review-candidates.json'),'utf8'));
    assert.equal(manifest.candidates[0].content,p.after);
    t.key('q');await session;
  }finally{cleanup(p);}
});
