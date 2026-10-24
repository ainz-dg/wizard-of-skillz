import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest } from '../src/paired-agent-eval.mjs';
import { gradeFictionalPilotOutputSurface } from '../src/pilot-output-surface.mjs';

const dir=new URL('./fixtures/copilot-pilot-v1/',import.meta.url);
const manifestBytes=fs.readFileSync(new URL('tasks.json',dir),'utf8');
const manifest=JSON.parse(manifestBytes);
const originalSkillBytes=fs.readFileSync(new URL('SKILL.original.md',dir),'utf8');
const candidateSkillBytes=fs.readFileSync(new URL('SKILL.candidate.md',dir),'utf8');
function make(){
  const runs=[];
  for(const task of manifest.tasks)for(let trial=1;trial<=3;trial++)for(const variant of ['original','candidate']){
    let output;
    if(task.id==='bootstrap')output=variant==='original'?
      'Runtime.start(APP_ID, DemoConfig.class);':
      'Runtime.start(new StartupContext<>(APP_ID, DemoConfig.class));';
    else if(task.id==='cache-control')output='setCacheTtl(60);';
    else output=task.id==='token-safety'&&trial===2&&variant==='original'?
      'readTokenFromEnvironment()':'readTokenFromEnvironment();';
    runs.push({task_id:task.id,trial,variant,completed:true,output});
  }
  return {schema_version:1,provenance:{
    origin:'SYNTHETIC_REPLAY',agent:'synthetic-fixture',model:'fake-model',
    runner:'fixed-fixture',environment_id:'sandbox',
    manifest_sha256:digest(manifestBytes),
    original_skill_sha256:digest(originalSkillBytes),
    candidate_skill_sha256:digest(candidateSkillBytes)
  },runs};
}
function grade(artifact=make()){
  return gradeFictionalPilotOutputSurface({manifest,manifestBytes,
    originalSkillBytes,candidateSkillBytes,artifact});
}
test('separate output surface score catches missing semicolon without rewriting literal baseline',()=>{
  const result=grade();
  assert.equal(result.surface_summary.original_passes,8);
  assert.equal(result.surface_summary.candidate_passes,9);
  assert.equal(result.literal_baseline.summary.original_passes,6);
  assert.equal(result.literal_baseline.summary.candidate_passes,9);
  assert.equal(result.surface_summary.original_format_failures,1);
  assert.equal(result.surface_summary.candidate_format_failures,0);
  assert.equal(result.surface_summary.candidate_wins,1);
  assert.equal(result.by_task.bootstrap.original_passes,3);
  assert.equal(result.by_task.bootstrap.candidate_passes,3);
  assert.equal(result.basis,'POST_HOC_FIXED_OUTPUT_SHAPE_NOT_JAVA_COMPILATION');
  assert.equal(result.safe_to_promote,false);
  const token=result.pairs.find(p=>p.task_id==='token-safety'&&p.trial===2);
  assert.ok(token.original.failures.includes('MISSING_STATEMENT_TERMINATOR'));
});
test('extra prose, Markdown fences, comments and incorrect API cannot pass full-line format',()=>{
  for(const output of ['Here is your code: setCacheTtl(60);',
      String.fromCharCode(96).repeat(3)+'java\nsetCacheTtl(60);\n'+String.fromCharCode(96).repeat(3),
      'setCacheTtl(60); // comment', 'setCacheTtl(60); \nsetCacheTtl(60);',
      'setCacheTtl(61);']){
    const data=make();
    data.runs.find(r=>r.task_id==='cache-control'&&r.variant==='candidate'&&r.trial===1).output=output;
    const report=grade(data);
    assert.equal(report.by_task['cache-control'].candidate_passes,2,output);
  }
});
test('missing/duplicate run and forged hashes cannot bypass original scorer',()=>{
  const missing=make();missing.runs.pop();
  assert.throws(()=>grade(missing),/Incomplete/);
  const forged=make();forged.provenance.candidate_skill_sha256='0'.repeat(64);
  assert.throws(()=>grade(forged),/mismatching/);
});
test('read-only CLI prints only aggregate data and failure categories',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-surface-test-'));
  try {
    const file=path.join(root,'runs.json');
    const artifact=make();
    // Sentinel must never be echoed if the input file is confidential.
    artifact.runs[0].output='SENTINEL_CONFIDENTIAL_RESPONSE';
    fs.writeFileSync(file,JSON.stringify(artifact));
    const cli=new URL('../scripts/grade-copilot-pilot-shape.mjs',import.meta.url).pathname;
    const run=spawnSync(process.execPath,[cli,'--runs',file],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    assert.ok(!run.stdout.includes('SENTINEL_CONFIDENTIAL_RESPONSE'));
    const report=JSON.parse(run.stdout);
    assert.equal(report.grader,'FICTIONAL_TASK_SURFACE_V1');
    assert.equal(report.safe_to_promote,false);
    assert.equal(report.surface_summary.original_passes,7);
    assert.ok(report.failures.length>=2);
    assert.equal(fs.readFileSync(file,'utf8'),JSON.stringify(artifact));
  }finally {fs.rmSync(root,{recursive:true,force:true});}
});
