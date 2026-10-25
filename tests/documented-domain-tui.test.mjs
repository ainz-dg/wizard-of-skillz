import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {createLocalScan} from '../src/local-scan.mjs';
import {runReviewTui,renderReviewTui,initialTuiState} from '../src/review-tui.mjs';
import {buildReviewCatalog} from '../src/review-selection.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(t,{rows=27,columns=92}={}){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-domain-tui-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const root=path.join(temp,'case');
  fs.mkdirSync(path.join(root,'resources'),{recursive:true});
  const content='# Orders\nBefore reopening an order, check its recorded status.\nOnly authorized operators approve a reopening after recording a reason.\n';
  fs.writeFileSync(path.join(root,'resources','orders.md'),content);
  const audit=path.join(temp,'scan');
  createLocalScan(root,{out:audit});
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
  let screen='';
  const output={isTTY:true,rows,columns,write(s){screen=s;}};
  const key=(name,ch)=>input.emit('keypress',ch??(name==='return'?'\r':name),{name});
  return {temp,root,audit,input,output,key,screen:()=>screen,content};
}
async function until(fn,predicate){
  for(let i=0;i<60;i++){if(predicate(fn()))return;await tick();}
  assert.fail('Timed out waiting for domain screen: '+fn().slice(-1000));
}
test('from an empty-skills TUI: D collects resources, explicit M then Y sends to selected provider',async t=>{
  const x=setup(t);let providerFactoryCalls=0,modelRequests=0,received;
  const task=runReviewTui(x.audit,{consumerRoot:x.root,input:x.input,output:x.output,
    providerFactory:opts=>{
      providerFactoryCalls++;assert.equal(opts.provider,'copilot');
      return {async completeJson(payload){
        modelRequests++;received=payload;const docs=JSON.parse(payload.user).documents;
        assert.equal(docs.length,1);
        return {candidates:[{
          name:'review-order-reopening',description:'Review documented order reopening',
          purpose:'Guide authorized review',audience:'Order operator',
          steps:[
            {instruction:'Check the recorded status',evidence:[{source_id:docs[0].id,
              quote:'Before reopening an order, check its recorded status.'}]},
            {instruction:'Request approval',evidence:[{source_id:docs[0].id,
              quote:'Only authorized operators approve a reopening after recording a reason.'}]}
          ],
          communication:{terminology:['order status'],include:['approval status'],avoid:['unverified approval']}
        }]};
      },async close(){}};
    }});
  try{
    assert.match(x.screen(),/D Dominio/);
    x.key('d');
    assert.match(x.screen(),/Dove sono le resources/);
    x.key('return');
    assert.match(x.screen(),/Dove si trovano le skills/);
    x.key('return');
    await until(x.screen,s=>s.includes('Documenti individuati: 1'));
    assert.match(x.screen(),/Skill esistenti: 0/);
    assert.equal(providerFactoryCalls,0);
    assert.equal(modelRequests,0);
    x.key('m');
    assert.match(x.screen(),/ATTENZIONE: il modello riceverà/);
    assert.equal(providerFactoryCalls,0);
    x.key('y');
    await until(x.screen,s=>s.includes('Bozze proposte: 1'));
    assert.equal(providerFactoryCalls,1);
    assert.equal(modelRequests,1);
    assert.match(received.system,/Do not invent tools/);
    x.key('return');
    assert.match(x.screen(),/BOZZA: review-order-reopening/);
    assert.match(x.screen(),/Check the recorded status/);
    x.key('escape');x.key('escape');
    assert.match(x.screen(),/COSA VUOI FARE/);
    assert.equal(fs.existsSync(path.join(x.root,'skills')),false);
    assert.equal(fs.readFileSync(path.join(x.root,'resources','orders.md'),'utf8'),x.content);
  }finally{x.key('q');await task;}
});
test('escape from explicit model consent does not invoke any provider',async t=>{
  const x=setup(t);let providers=0;
  const task=runReviewTui(x.audit,{consumerRoot:x.root,input:x.input,output:x.output,
    providerFactory:()=>{providers++;return {completeJson:async()=>({})};}});
  try{
    x.key('d');x.key('return');x.key('return');
    await until(x.screen,s=>s.includes('Documenti individuati: 1'));
    x.key('m');assert.match(x.screen(),/Y Conferma invio/);
    x.key('escape');
    assert.match(x.screen(),/Nessuna chiamata al modello/);
    assert.equal(providers,0);
  }finally{x.key('q');await task;}
});
test('documented-domain onboarding keeps a compact 60x12 terminal usable',()=>{
  const catalog=buildReviewCatalog({consumer_repo:'local/example',proposals:[]});
  const s=initialTuiState({guided:true});
  for(const wizard of [
    {step:'resources',text:'',notice:''},
    {step:'skills',text:'',notice:''},
    {step:'review',resources:'resources',skills:'skills',
      inventory:{resources_count:3,existing_skill_count:0},notice:''},
    {step:'confirm',resources:'resources',skills:'skills',
      inventory:{resources_count:3,existing_skill_count:0},notice:''},
    {step:'result',result:{resources_count:3,draft_skills:[{name:'test-skill',path:'x'}],
      output_directory:'/tmp/example'},cursor:0,notice:''},
    {step:'draft',result:{draft_skills:[{name:'test-skill'}]},cursor:0,
      draftText:'# Test Skill\nFirst step\nSecond step',scroll:0,notice:''}
  ]){
    const frame=renderReviewTui(catalog,s,{columns:60,rows:12,colors:false,
      domainWizard:wizard,providerSelection:{provider:'copilot',model:'auto'}});
    assert.equal(frame.split('\n').length,12,wizard.step);
    assert.ok(frame.split('\n').every(x=>x.length<=60),wizard.step);
    assert.match(frame,/DOCUMENTED DOMAIN/);
  }
});
