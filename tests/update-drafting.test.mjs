import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createLocalScan} from '../src/local-scan.mjs';
import {generateUpdateDraft,editUpdateDraft} from '../src/update-drafting.mjs';
import {loadReviewPreviews} from '../src/review-candidates.mjs';
import {buildReviewCatalog} from '../src/review-selection.mjs';
import {prepareReviewedApply,commitReviewedApply} from '../src/guarded-apply.mjs';

function fixture(){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-drafting-test-'));
  const root=path.join(home,'source');
  const report=path.join(home,'audit');
  const relative='.agents/skills/demo/SKILL.md';
  const source=path.join(root,relative);
  fs.mkdirSync(path.dirname(source),{recursive:true});
  const original='---\nname: demo\ndescription: sample skill\n---\nRead [missing doc](references/missing.md).\n';
  const updated=original.replace('Read [missing doc](references/missing.md).',
    'Use the inline instructions here.');
  fs.writeFileSync(source,original);
  createLocalScan(root,{out:report});
  const proposals=JSON.parse(fs.readFileSync(path.join(report,'repair-proposals.json'),'utf8'));
  return {home,root,report,source,original,updated,proposals,id:proposals.proposals[0].id};
}
const cleanup=e=>fs.rmSync(e.home,{recursive:true,force:true});

test('model-generated candidate is staged without source writes; explicit separate Apply writes it',async()=>{
  const e=fixture();let payload=null;
  try{
    const client={completeJson:async(input)=>{payload=input;return {status:'READY',content:e.updated};}};
    const result=await generateUpdateDraft(e.report,{consumerRoot:e.root,proposalId:e.id,client});
    assert.equal(result.status,'STAGED');
    assert.equal(result.write_authorized,false);
    assert.match(payload.system,/NEEDS_HUMAN_INPUT/);
    const sent=JSON.parse(payload.user);
    assert.equal(sent.proposals[0].id,e.id);
    assert.equal(sent.skill_text,e.original);
    assert.equal(fs.readFileSync(e.source,'utf8'),e.original);
    const previews=loadReviewPreviews(e.report,e.proposals);
    const catalog=buildReviewCatalog(e.proposals,{previews});
    assert.equal(catalog.items[0].readiness,'PREVIEW_READY');
    const prepared=prepareReviewedApply(catalog,[e.id],previews,{consumerRoot:e.root});
    assert.equal(prepared.candidates[0].after,e.updated);
    const applied=commitReviewedApply(prepared,{catalog,previews,consumerRoot:e.root,
      auditFolder:e.report,confirmation:'APPLY'});
    assert.equal(applied.applied_count,1);
    assert.equal(fs.readFileSync(e.source,'utf8'),e.updated);
  }finally{cleanup(e);}
});

test('model refusal does not fabricate any preview or update sources',async()=>{
  const e=fixture();
  try{
    const out=await generateUpdateDraft(e.report,{consumerRoot:e.root,proposalId:e.id,
      client:{completeJson:async()=>({status:'NEEDS_HUMAN_INPUT',reason:'Unknown intended replacement'})}});
    assert.equal(out.status,'NEEDS_HUMAN_INPUT');
    assert.equal(out.write_authorized,false);
    assert.equal(fs.existsSync(path.join(e.report,'review-candidates.json')),false);
    assert.equal(fs.readFileSync(e.source,'utf8'),e.original);
  }finally{cleanup(e);}
});

test('stale audit, invalid model response, unchanged draft and foreign target never stage',async()=>{
  const e=fixture();
  try{
    const client={completeJson:async()=>({status:'READY',content:e.updated})};
    fs.appendFileSync(e.source,'# newer local edit\n');
    await assert.rejects(()=>generateUpdateDraft(e.report,{consumerRoot:e.root,proposalId:e.id,client}),
      /differs from the audited/);
    assert.equal(fs.existsSync(path.join(e.report,'review-candidates.json')),false);
  }finally{cleanup(e);}
  const f=fixture();
  try{
    await assert.rejects(()=>generateUpdateDraft(f.report,{consumerRoot:f.root,proposalId:f.id,
      client:{completeJson:async()=>({status:'READY',content:f.original})}}),
      /empty or unchanged/);
    await assert.rejects(()=>generateUpdateDraft(f.report,{consumerRoot:f.root,proposalId:f.id,
      client:{completeJson:async()=>({content:f.updated})}}),/Invalid model draft response/);
    assert.equal(fs.existsSync(path.join(f.report,'review-candidates.json')),false);
  }finally{cleanup(f);}
});

test('editor prepares corrected skill inside temp workspace, leaves source untouched',()=>{
  const e=fixture();
  try{
    const editor=path.join(e.home,'fake-editor.mjs');
    fs.writeFileSync(editor,
      '#!/usr/bin/env node\n'+
      'import fs from "node:fs";\n'+
      'const p=process.argv[2];\n'+
      'fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace('+
      '"Read [missing doc](references/missing.md).","Use the inline instructions here."));\n');
    fs.chmodSync(editor,0o700);
    const result=editUpdateDraft(e.report,{consumerRoot:e.root,proposalId:e.id,
      editor:process.execPath+' '+editor});
    assert.equal(result.status,'STAGED');
    assert.equal(fs.readFileSync(e.source,'utf8'),e.original);
    assert.equal(loadReviewPreviews(e.report,e.proposals).previews[0].content,e.updated);
  }finally{cleanup(e);}
});

test('CLI model option is explicitly required and provider is never implicitly called',()=>{
  const e=fixture();
  try{
    const cmd=new URL('../bin/wizard.mjs',import.meta.url).pathname;
    const result=spawnSync(process.execPath,[cmd,'prepare-update',e.report,'--proposal',e.id,
      '--consumer-root',e.root],{encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/exactly one of --llm or --editor/);
    assert.equal(fs.existsSync(path.join(e.report,'review-candidates.json')),false);
  }finally{cleanup(e);}
});
