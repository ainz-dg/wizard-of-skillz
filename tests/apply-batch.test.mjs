import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {commitApprovedBatch} from '../src/apply-batch.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
function sandbox(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-apply-batch-'));
  const consumerRoot=path.join(root,'consumer'),providerRoot=path.join(root,'provider');
  const auditFolder=path.join(root,'review');
  fs.mkdirSync(consumerRoot);fs.mkdirSync(providerRoot);fs.mkdirSync(auditFolder);
  const candidates=[1,2,3].map(i=>{
    const rel='skills/skill-'+i+'/SKILL.md';
    const target=path.join(consumerRoot,rel);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    const before='# Skill '+i+'\nOld instruction '+i+'\n';
    const after='# Skill '+i+'\nNew approved instruction '+i+'\n';
    fs.writeFileSync(target,before);
    return {proposal_id:'proposal-'+i,repo:'demo/consumer',path:rel,
      before,after,before_sha256:hash(before),after_sha256:hash(after)};
  });
  return {root,consumerRoot,providerRoot,auditFolder,candidates};
}
const dispose=e=>fs.rmSync(e.root,{recursive:true,force:true});
const opts=e=>({consumerRoot:e.consumerRoot,providerRoot:e.providerRoot,auditFolder:e.auditFolder,confirmation:'APPLY'});
const contents=(e,i)=>fs.readFileSync(path.join(e.consumerRoot,e.candidates[i].path),'utf8');

test('one explicit confirmation writes all selected files, with one receipt and all backups',()=>{
  const e=sandbox();
  try{
    const result=commitApprovedBatch(e.candidates,opts(e));
    assert.equal(result.status,'APPLIED');
    assert.equal(result.selected_count,3);
    assert.equal(result.applied_count,3);
    assert.deepEqual(result.selected_ids,['proposal-1','proposal-2','proposal-3']);
    assert.deepEqual(e.candidates.map((_,i)=>contents(e,i)),
      e.candidates.map(x=>x.after));
    assert.equal(result.files.length,3);
    assert.ok(fs.existsSync(result.receipt));
    assert.deepEqual([0,1,2].map(i=>fs.readFileSync(path.join(result.backup_directory,
      i+'.before'),'utf8')),e.candidates.map(x=>x.before));
    assert.equal(fs.readdirSync(e.auditFolder).filter(x=>x.startsWith('apply-result-')).length,1);
  }finally{dispose(e);}
});

test('one unready/stale item rejects entire batch without any source writes',()=>{
  const e=sandbox();
  try{
    fs.appendFileSync(path.join(e.consumerRoot,e.candidates[2].path),'external edit\n');
    assert.throws(()=>commitApprovedBatch(e.candidates,opts(e)),/changed source/);
    assert.equal(contents(e,0),e.candidates[0].before);
    assert.equal(contents(e,1),e.candidates[1].before);
    assert.ok(contents(e,2).includes('external edit'));
    assert.deepEqual(fs.readdirSync(e.auditFolder),[]);
  }finally{dispose(e);}
});

test('a duplicate destination or proposal ID blocks whole batch before writing',()=>{
  const e=sandbox();
  try{
    assert.throws(()=>commitApprovedBatch([...e.candidates,
      {...e.candidates[1],proposal_id:'other'}],opts(e)),/duplicate/);
    assert.throws(()=>commitApprovedBatch([...e.candidates,
      {...e.candidates[1],path:e.candidates[2].path}],opts(e)),/duplicate/);
    assert.deepEqual(e.candidates.map((_,i)=>contents(e,i)),e.candidates.map(x=>x.before));
    assert.deepEqual(fs.readdirSync(e.auditFolder),[]);
  }finally{dispose(e);}
});

test('confirmation is required for the entire batch, not per-file',()=>{
  const e=sandbox();
  try{
    assert.throws(()=>commitApprovedBatch(e.candidates,{...opts(e),confirmation:'YES'}),
      /Final explicit APPLY/);
    assert.deepEqual(e.candidates.map((_,i)=>contents(e,i)),e.candidates.map(x=>x.before));
    assert.deepEqual(fs.readdirSync(e.auditFolder),[]);
  }finally{dispose(e);}
});

test('failure during second replacement restores first and records ROLLED_BACK',()=>{
  const e=sandbox();
  try{
    let n=0;
    const rename=(a,b)=>{
      if(++n===2)throw Error('simulated second replacement failure');
      fs.renameSync(a,b);
    };
    let error;
    try{commitApprovedBatch(e.candidates,{...opts(e),rename});}
    catch(ex){error=ex;}
    assert.ok(error);
    assert.match(error.message,/ROLLED_BACK/);
    assert.equal(error.report.status,'ROLLED_BACK');
    assert.equal(error.report.applied_count,0);
    assert.equal(error.report.restored_count,1);
    assert.deepEqual(error.report.files.map(x=>x.status),
      ['RESTORED','NOT_APPLIED','NOT_APPLIED']);
    assert.deepEqual(e.candidates.map((_,i)=>contents(e,i)),e.candidates.map(x=>x.before));
    assert.ok(fs.existsSync(error.report.receipt));
    assert.ok(fs.existsSync(path.join(error.report.backup_directory,'0.before')));
  }finally{dispose(e);}
});

test('rollback failure is reported as PARTIAL, never falsely declared success',()=>{
  const e=sandbox();
  try{
    let n=0;
    const rename=(a,b)=>{
      n++;
      if(n>=2)throw Error('simulated replacement and rollback failure');
      fs.renameSync(a,b);
    };
    let error;
    try{commitApprovedBatch(e.candidates,{...opts(e),rename});}
    catch(ex){error=ex;}
    assert.ok(error);
    assert.match(error.message,/PARTIAL/);
    assert.deepEqual(error.report.unresolved.map(x=>x.proposal_id),['proposal-1']);
    assert.equal(error.report.files[0].status,'UNRESOLVED');
    assert.equal(contents(e,0),e.candidates[0].after);
    assert.equal(contents(e,1),e.candidates[1].before);
    assert.equal(contents(e,2),e.candidates[2].before);
    assert.ok(fs.existsSync(error.report.receipt));
    assert.equal(fs.readFileSync(path.join(error.report.backup_directory,'0.before'),'utf8'),
      e.candidates[0].before);
  }finally{dispose(e);}
});

test('refuse output folder inside inspected repository and symlinked target',()=>{
  const e=sandbox();
  try{
    const inside=path.join(e.consumerRoot,'review');
    fs.mkdirSync(inside);
    assert.throws(()=>commitApprovedBatch(e.candidates,
      {...opts(e),auditFolder:inside}),/outside inspected/);
    const target=path.join(e.consumerRoot,e.candidates[0].path);
    const copy=path.join(e.root,'outside.md');
    fs.copyFileSync(target,copy);
    fs.unlinkSync(target);
    fs.symlinkSync(copy,target);
    assert.throws(()=>commitApprovedBatch(e.candidates,opts(e)),/symlink/);
    assert.equal(fs.readFileSync(copy,'utf8'),e.candidates[0].before);
    assert.deepEqual(fs.readdirSync(e.auditFolder),[]);
  }finally{dispose(e);}
});

test('invalid candidate digest prevents all writes',()=>{
  const e=sandbox();
  try{
    const forged=[...e.candidates];
    forged[2]={...forged[2],after:'not the approved contents'};
    assert.throws(()=>commitApprovedBatch(forged,opts(e)),/hashes/);
    assert.deepEqual(e.candidates.map((_,i)=>contents(e,i)),e.candidates.map(x=>x.before));
  }finally{dispose(e);}
});
