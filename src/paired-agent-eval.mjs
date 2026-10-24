/**
 * Paired coding-agent output evaluation: TEXTUAL replay, not an agent runner.
 *
 * Keep the provenance/truth boundary explicit: an arbitrary JSON file cannot
 * prove real agent execution. Even declared observed runs remain unverified.
 */
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
const SHA=/^[a-f0-9]{64}$/;
const KINDS=new Set(['regression','control','safety']);
const VARIANTS=['original','candidate'];
const ORIGINS=new Set(['SYNTHETIC_REPLAY','OPERATOR_SUPPLIED']);
const plain=o=>o&&typeof o==='object'&&!Array.isArray(o);
const str=x=>typeof x==='string'&&x.trim().length>0;
const checkStringList=(x,where)=>{
  if(!Array.isArray(x))throw Error(where+' must be an array');
  if(x.length>32||x.some(v=>!str(v)||v.length>500))throw Error('Invalid check in '+where);
  if(new Set(x).size!==x.length)throw Error('Duplicate checks in '+where);
};

function validateTasks(manifest){
  if(!plain(manifest)||manifest.schema_version!==1||!Array.isArray(manifest.tasks)||!manifest.tasks.length||manifest.tasks.length>100)
    throw Error('Invalid task manifest');
  const ids=new Set();
  for(const task of manifest.tasks){
    if(!plain(task)||!str(task.id)||!str(task.prompt)||task.prompt.length>12000||
       !KINDS.has(task.kind)||!Number.isInteger(task.trials)||task.trials<1||task.trials>20)
      throw Error('Invalid task identity, prompt, kind or trials');
    if(ids.has(task.id))throw Error('Duplicate task ID '+task.id);
    ids.add(task.id);
    if(!plain(task.checks))throw Error('Missing explicit checks for '+task.id);
    checkStringList(task.checks.must_include,task.id+'.must_include');
    checkStringList(task.checks.must_avoid,task.id+'.must_avoid');
    if(!task.checks.must_include.length&&!task.checks.must_avoid.length)
      throw Error('No acceptance criteria for '+task.id);
    if(task.checks.must_include.some(x=>task.checks.must_avoid.includes(x)))
      throw Error('Contradictory acceptance checks for '+task.id);
  }
}
function validateProvenance(p,manifestBytes,originalBytes,candidateBytes){
  if(!plain(p)||!ORIGINS.has(p.origin)||
     !str(p.agent)||!str(p.model)||!str(p.runner)||!str(p.environment_id)||
     p.agent.length>128||p.model.length>128||p.environment_id.length>256)
    throw Error('Missing comparable run provenance');
  for(const [key,bytes] of [['manifest_sha256',manifestBytes],
    ['original_skill_sha256',originalBytes],['candidate_skill_sha256',candidateBytes]]){
    if(!SHA.test(p[key]||'')||p[key]!==digest(bytes))
      throw Error('Missing or mismatching '+key+' in run provenance');
  }
  if(p.origin==='SYNTHETIC_REPLAY'&&p.agent!=='synthetic-fixture')
    throw Error('Synthetic replay must identify its fixture agent explicitly');
}
function textualChecks(output,checks){
  const missing=checks.must_include.filter(s=>!output.includes(s));
  const forbidden=checks.must_avoid.filter(s=>output.includes(s));
  return {pass:missing.length===0&&forbidden.length===0,missing,forbidden};
}

export function evaluatePairedAgentOutputs({
  manifest,manifestBytes,originalSkillBytes,candidateSkillBytes,artifact
}){
  if(typeof manifestBytes!=='string'||typeof originalSkillBytes!=='string'||
     typeof candidateSkillBytes!=='string')
    throw Error('Missing raw source contents for provenance checks');
  validateTasks(manifest);
  // A hash of one file must not authorize scoring a different in-memory
  // manifest. The CLI parses these bytes directly, but keep the library safe.
  let parsedManifest;
  try { parsedManifest=JSON.parse(manifestBytes); } catch { throw Error('Invalid raw task manifest'); }
  if(JSON.stringify(parsedManifest)!==JSON.stringify(manifest))
    throw Error('Task manifest differs from hashed manifest bytes');
  if(!plain(artifact)||artifact.schema_version!==1||!Array.isArray(artifact.runs))
    throw Error('Invalid paired run artifact');
  validateProvenance(artifact.provenance,manifestBytes,originalSkillBytes,candidateSkillBytes);
  const expected=new Map();
  for(const task of manifest.tasks)for(let n=1;n<=task.trials;n++)
    for(const variant of VARIANTS)expected.set(task.id+'\u0000'+n+'\u0000'+variant,
      {task,trial:n,variant});
  if(artifact.runs.length!==expected.size)
    throw Error('Incomplete or extra paired runs: expected '+expected.size+', found '+artifact.runs.length);
  const observed=new Map();
  for(const run of artifact.runs){
    if(!plain(run)||!str(run.task_id)||!Number.isInteger(run.trial)||
       !VARIANTS.includes(run.variant)||run.completed!==true||
       typeof run.output!=='string'||run.output.length>100000)
      throw Error('Invalid, incomplete or oversized run artifact');
    const key=run.task_id+'\u0000'+run.trial+'\u0000'+run.variant;
    if(!expected.has(key))throw Error('Unexpected run '+key);
    if(observed.has(key))throw Error('Duplicate run '+key);
    observed.set(key,run);
  }
  if(observed.size!==expected.size)throw Error('Missing expected task/variant/trial pair');
  const summary={
    task_count:manifest.tasks.length,paired_trials:0,original_passes:0,candidate_passes:0,
    candidate_wins:0,original_wins:0,ties_both_pass:0,ties_both_fail:0,
    control_regressions:0,safety_candidate_failures:0
  };
  const pairs=[];
  for(const task of manifest.tasks){
    for(let n=1;n<=task.trials;n++){
      const original=textualChecks(observed.get(task.id+'\u0000'+n+'\u0000original').output,task.checks);
      const candidate=textualChecks(observed.get(task.id+'\u0000'+n+'\u0000candidate').output,task.checks);
      const outcome=candidate.pass&&!original.pass?'CANDIDATE_WIN':
        original.pass&&!candidate.pass?'ORIGINAL_WIN':
        original.pass?'BOTH_PASS':'BOTH_FAIL';
      summary.paired_trials++;
      if(original.pass)summary.original_passes++;
      if(candidate.pass)summary.candidate_passes++;
      if(outcome==='CANDIDATE_WIN')summary.candidate_wins++;
      if(outcome==='ORIGINAL_WIN')summary.original_wins++;
      if(outcome==='BOTH_PASS')summary.ties_both_pass++;
      if(outcome==='BOTH_FAIL')summary.ties_both_fail++;
      if((task.kind==='control'||task.kind==='safety')&&original.pass&&!candidate.pass)
        summary.control_regressions++;
      if(task.kind==='safety'&&!candidate.pass)summary.safety_candidate_failures++;
      // Do not echo task prompts or agent outputs into the public score report.
      pairs.push({task_id:task.id,kind:task.kind,trial:n,outcome,
        original,candidate});
    }
  }
  const baseline=summary.original_passes/summary.paired_trials;
  const candidate=summary.candidate_passes/summary.paired_trials;
  const blockers=[];
  if(summary.control_regressions)blockers.push('CONTROL_REGRESSIONS');
  if(summary.safety_candidate_failures)blockers.push('SAFETY_FAILURES');
  if(summary.original_wins)blockers.push('CANDIDATE_WORSE_ON_SOME_TASKS');
  if(artifact.provenance.origin==='SYNTHETIC_REPLAY')blockers.push('SYNTHETIC_RUNS_NOT_AGENT_OBSERVATIONS');
  return {schema_version:1,kind:'PAIRED_TEXTUAL_REPLAY_EVAL',
    provenance:{...artifact.provenance,real_agent_execution_verified:false},
    summary:{...summary,original_pass_rate:baseline,candidate_pass_rate:candidate,
      paired_delta:candidate-baseline},
    blockers,pairs,safe_to_promote:false,
    interpretation:'Literal task-output checks on operator-supplied text. No evidence of live agent execution, source correctness, Java compilation or real-world performance.'};
}
