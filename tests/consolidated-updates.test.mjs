import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stageUpdateText,loadReviewPreviews} from '../src/review-candidates.mjs';
import {generateUpdateDraft} from '../src/update-drafting.mjs';
import {buildReviewCatalog,planHumanSelection} from '../src/review-selection.mjs';
import {prepareReviewedApply,commitReviewedApply} from '../src/guarded-apply.mjs';

function fixture(){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-group-test-'));
  const consumerRoot=path.join(home,'source'),auditFolder=path.join(home,'report');
  const relative='.agents/skills/demo/SKILL.md';
  const file=path.join(consumerRoot,relative);
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(auditFolder);
  const before='---\nname: demo\ndescription: instructions\n---\nRule one is old.\nRule two is old.\n';
  const after=before.replace('Rule one is old.','Rule one is new.').replace('Rule two is old.','Rule two is new.');
  fs.writeFileSync(file,before);
  const proposals={
    schema_version:1,consumer_repo:'demo/source',proposals:['p-one','p-two'].map((id,i)=>({
      id,action:'UPDATE',title:'Fix rule '+(i+1),
      source:{repo:'demo/source',path:relative},
      target:{repo:'demo/source',path:relative},
      reason:'Update rule '+(i+1),steps:['Update precisely rule '+(i+1)],
      evidence:[{repo:'demo/source',path:relative,sha256:null}]
    }))
  };
  fs.writeFileSync(path.join(auditFolder,'repair-proposals.json'),JSON.stringify(proposals));
  return {home,consumerRoot,auditFolder,relative,file,before,after,proposals};
}
const dispose=e=>fs.rmSync(e.home,{recursive:true,force:true});
function load(e){
  const previews=loadReviewPreviews(e.auditFolder,e.proposals);
  return {previews,catalog:buildReviewCatalog(e.proposals,{previews})};
}

test('combined two-proposal draft updates one SKILL.md with one user confirmation',async()=>{
  const e=fixture();let sent;
  try{
    const out=await generateUpdateDraft(e.auditFolder,{
      consumerRoot:e.consumerRoot,proposalIds:['p-one','p-two'],
      client:{completeJson:async arg=>{sent=JSON.parse(arg.user);
        return {status:'READY',content:e.after};}}
    });
    assert.equal(out.status,'STAGED');
    assert.deepEqual(out.proposal_ids,['p-one','p-two']);
    assert.equal(sent.proposals.length,2);
    assert.equal(fs.readFileSync(e.file,'utf8'),e.before);
    const {catalog,previews}=load(e);
    assert.deepEqual(catalog.items.map(p=>p.readiness),['PREVIEW_READY','PREVIEW_READY']);
    assert.deepEqual(previews.previews.map(x=>x.group_ids),
      [['p-one','p-two'],['p-one','p-two']]);
    const partial=planHumanSelection(catalog,{mode:'SUBSET',ids:['p-one']});
    assert.equal(partial.ready_for_final_confirmation,false);
    assert.ok(partial.blockers.some(b=>b.type==='INCOMPLETE_CONSOLIDATED_GROUP'));
    const full=planHumanSelection(catalog,{mode:'SUBSET',ids:['p-one','p-two']});
    assert.equal(full.ready_for_final_confirmation,true);
    assert.equal(full.blockers.length,0);
    const reviewed=prepareReviewedApply(catalog,['p-one','p-two'],previews,
      {consumerRoot:e.consumerRoot});
    assert.equal(reviewed.candidates.length,1);
    assert.deepEqual(reviewed.candidates[0].covered_proposal_ids,['p-one','p-two']);
    assert.throws(()=>commitReviewedApply(reviewed,{catalog,previews,
      consumerRoot:e.consumerRoot,auditFolder:e.auditFolder}),/Final explicit APPLY/);
    const applied=commitReviewedApply(reviewed,{catalog,previews,
      consumerRoot:e.consumerRoot,auditFolder:e.auditFolder,confirmation:'APPLY'});
    assert.equal(applied.selected_count,2);
    assert.equal(applied.file_count,1);
    assert.equal(applied.applied_count,1);
    assert.deepEqual(applied.selected_ids,['p-one','p-two']);
    assert.equal(fs.readFileSync(e.file,'utf8'),e.after);
    assert.equal(applied.files[0].covered_proposal_ids.length,2);
  }finally{dispose(e);}
});

test('separate staged revisions targeting the same file are rejected until consolidated',()=>{
  const e=fixture();
  try{
    const first=e.before.replace('Rule one is old.','Rule one is new.');
    stageUpdateText(e.auditFolder,{consumerRoot:e.consumerRoot,
      proposalId:'p-one',content:first});
    assert.throws(()=>stageUpdateText(e.auditFolder,{consumerRoot:e.consumerRoot,
      proposalId:'p-two',content:e.after}),/Consolidate its proposal IDs/);
    const {catalog}=load(e);
    const selection=planHumanSelection(catalog,{mode:'SUBSET',ids:['p-one','p-two']});
    assert.ok(selection.blockers.some(b=>b.type==='PATH_COLLISION'));
    assert.equal(fs.readFileSync(e.file,'utf8'),e.before);
  }finally{dispose(e);}
});

test('stale or tampered consolidated group blocks full Apply without writes',()=>{
  const e=fixture();
  try{
    stageUpdateText(e.auditFolder,{consumerRoot:e.consumerRoot,
      proposalIds:['p-one','p-two'],content:e.after});
    const file=path.join(e.auditFolder,'review-candidates.json');
    const staged=JSON.parse(fs.readFileSync(file,'utf8'));
    staged.candidates[1].candidate_sha256='0'.repeat(64);
    fs.writeFileSync(file,JSON.stringify(staged));
    assert.throws(()=>load(e),/Malformed|inconsistent/);
    assert.equal(fs.readFileSync(e.file,'utf8'),e.before);
  }finally{dispose(e);}
});


test('legacy single-proposal manifest without group_ids remains loadable',()=>{
  const e=fixture();
  try{
    stageUpdateText(e.auditFolder,{consumerRoot:e.consumerRoot,
      proposalId:'p-one',content:e.after});
    const filename=path.join(e.auditFolder,'review-candidates.json');
    const old=JSON.parse(fs.readFileSync(filename,'utf8'));
    delete old.candidates[0].group_ids;
    fs.writeFileSync(filename,JSON.stringify(old));
    const {catalog,previews}=load(e);
    assert.deepEqual(previews.previews[0].group_ids,['p-one']);
    assert.equal(catalog.items[0].readiness,'PREVIEW_READY');
  }finally{dispose(e);}
});
