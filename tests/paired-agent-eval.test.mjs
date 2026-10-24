import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest, evaluatePairedAgentOutputs } from '../src/paired-agent-eval.mjs';

const manifestFile=new URL('./fixtures/paired-agent-tasks.synthetic.json',import.meta.url);
const manifestBytes=fs.readFileSync(manifestFile,'utf8');
const manifest=JSON.parse(manifestBytes);
const originalSkillBytes='# Fictional original\nUse old runtime start syntax.\n';
const candidateSkillBytes='# Fictional candidate\nUse StartupContext and preserve all other instructions.\n';
function make(){
  // Each adversarial test owns a private manifest: no shared mutable state.
  const localManifest=structuredClone(manifest);
  const runs=[];
  for(const task of localManifest.tasks)for(let trial=1;trial<=task.trials;trial++){
    for(const variant of ['original','candidate']){
      let output;
      if(task.id==='startup-modern-api'){
        output=variant==='original'
          ? 'Runtime.start(APP_ID, DemoConfig.class);'
          : 'Runtime.start(new StartupContext<>(APP_ID, DemoConfig.class));';
      } else if(task.id==='unrelated-cache-setting'){
        output='setCacheTtl(60);';
      } else {
        output='String token = readTokenFromEnvironment();';
      }
      runs.push({task_id:task.id,trial,variant,completed:true,output});
    }
  }
  const artifact={schema_version:1,provenance:{
    origin:'SYNTHETIC_REPLAY',agent:'synthetic-fixture',model:'no-model',
    runner:'fixture-builder-v1',environment_id:'synthetic-frozen-tools-v1',
    manifest_sha256:digest(manifestBytes),
    original_skill_sha256:digest(originalSkillBytes),
    candidate_skill_sha256:digest(candidateSkillBytes)
  },runs};
  return {manifest:localManifest,manifestBytes,originalSkillBytes,candidateSkillBytes,artifact};
}
test('a complete synthetic replay produces paired, label-safe results without claiming live runs',()=>{
  const report=evaluatePairedAgentOutputs(make());
  assert.equal(report.kind,'PAIRED_TEXTUAL_REPLAY_EVAL');
  assert.equal(report.summary.task_count,3);
  assert.equal(report.summary.paired_trials,4);
  assert.equal(report.summary.original_passes,2);
  assert.equal(report.summary.candidate_passes,4);
  assert.equal(report.summary.candidate_wins,2);
  assert.equal(report.summary.ties_both_pass,2);
  assert.equal(report.summary.control_regressions,0);
  assert.equal(report.summary.safety_candidate_failures,0);
  assert.equal(report.provenance.real_agent_execution_verified,false);
  assert.equal(report.safe_to_promote,false);
  assert.ok(report.blockers.includes('SYNTHETIC_RUNS_NOT_AGENT_OBSERVATIONS'));
  assert.ok(report.pairs.every(p=>!('output' in p.original)&&!('prompt' in p)));
});
test('mismatched skill or manifest hashes cannot be silently scored',()=>{
  for(const key of ['original_skill_sha256','candidate_skill_sha256','manifest_sha256']){
    const x=make();x.artifact.provenance[key]='a'.repeat(64);
    assert.throws(()=>evaluatePairedAgentOutputs(x),/mismatching/);
  }
});
test('missing, duplicate and extraneous task/trial/variant runs fail closed',()=>{
  const missing=make();missing.artifact.runs.pop();
  assert.throws(()=>evaluatePairedAgentOutputs(missing),/Incomplete/);
  const duplicate=make();duplicate.artifact.runs[1]={...duplicate.artifact.runs[0]};
  assert.throws(()=>evaluatePairedAgentOutputs(duplicate),/Duplicate run/);
  const extra=make();extra.artifact.runs[0].task_id='unknown-case';
  assert.throws(()=>evaluatePairedAgentOutputs(extra),/Unexpected run/);
  const wrongTrial=make();wrongTrial.artifact.runs[0].trial=999;
  assert.throws(()=>evaluatePairedAgentOutputs(wrongTrial),/Unexpected run/);
});
test('unfinished or too-large agent outputs are not treated as completed trials',()=>{
  const x=make();x.artifact.runs[0].completed=false;
  assert.throws(()=>evaluatePairedAgentOutputs(x),/incomplete/);
  const big=make();big.artifact.runs[0].output='x'.repeat(100001);
  assert.throws(()=>evaluatePairedAgentOutputs(big),/oversized/);
});
test('control regression and candidate safety failures are counted explicitly',()=>{
  const x=make();
  x.artifact.runs.find(r=>r.task_id==='unrelated-cache-setting'&&r.variant==='candidate').output='Runtime.start(new StartupContext<>(APP_ID, DemoConfig.class));';
  x.artifact.runs.find(r=>r.task_id==='secret-handling'&&r.variant==='candidate').output='disableAuthentication(); hardcoded-token';
  const report=evaluatePairedAgentOutputs(x);
  assert.equal(report.summary.control_regressions,2);
  assert.equal(report.summary.safety_candidate_failures,1);
  assert.ok(report.blockers.includes('CONTROL_REGRESSIONS'));
  assert.ok(report.blockers.includes('SAFETY_FAILURES'));
  assert.ok(report.blockers.includes('CANDIDATE_WORSE_ON_SOME_TASKS'));
});
test('operator-supplied results remain explicitly unverified, even when checks pass',()=>{
  const x=make();x.artifact.provenance.origin='OPERATOR_SUPPLIED';
  x.artifact.provenance.agent='unknown-coding-agent';
  const report=evaluatePairedAgentOutputs(x);
  assert.equal(report.provenance.real_agent_execution_verified,false);
  assert.equal(report.safe_to_promote,false);
  assert.equal(report.summary.paired_trials,4);
  assert.ok(!report.blockers.includes('SYNTHETIC_RUNS_NOT_AGENT_OBSERVATIONS'));
});
test('manifest validation rejects duplicate IDs, contradictory checks and empty criteria',()=>{
  const dup=make();dup.manifest.tasks.push({...dup.manifest.tasks[0]});
  assert.throws(()=>evaluatePairedAgentOutputs(dup),/Duplicate task/);
  const conflict=make();conflict.manifest.tasks[0].checks.must_avoid.push(conflict.manifest.tasks[0].checks.must_include[0]);
  assert.throws(()=>evaluatePairedAgentOutputs(conflict),/Contradictory/);
  const empty=make();empty.manifest.tasks[0].checks={must_include:[],must_avoid:[]};
  assert.throws(()=>evaluatePairedAgentOutputs(empty),/No acceptance/);
});
test('CLI accepts local synthetic artifacts without changing source files',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-paired-eval-'));
  try{
    const x=make();
    const paths={
      tasks:path.join(tmp,'tasks.json'),
      runs:path.join(tmp,'runs.json'),
      original:path.join(tmp,'original.md'),
      candidate:path.join(tmp,'candidate.md')
    };
    fs.writeFileSync(paths.tasks,manifestBytes);
    fs.writeFileSync(paths.runs,JSON.stringify(x.artifact));
    fs.writeFileSync(paths.original,originalSkillBytes);
    fs.writeFileSync(paths.candidate,candidateSkillBytes);
    const script=new URL('../bin/wizard.mjs',import.meta.url).pathname;
    const result=spawnSync(process.execPath,[script,'eval-paired',paths.tasks,
      '--runs',paths.runs,'--original-skill',paths.original,
      '--candidate-skill',paths.candidate],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(result.stdout);
    assert.equal(report.summary.candidate_wins,2);
    assert.equal(report.safe_to_promote,false);
    assert.equal(fs.readFileSync(paths.original,'utf8'),originalSkillBytes);
    assert.equal(fs.readFileSync(paths.candidate,'utf8'),candidateSkillBytes);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('parsed task definitions cannot diverge from hashed manifest bytes',()=>{
  const x=make();
  x.manifest.tasks[0].prompt='Changed independently after the hash was computed';
  assert.throws(()=>evaluatePairedAgentOutputs(x),/Task manifest differs/);
});
