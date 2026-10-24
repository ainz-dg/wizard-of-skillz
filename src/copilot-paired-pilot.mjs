/**
 * Bounded prompt-only Copilot A/B pilot.
 * Source inputs are committed FICTIONAL fixtures, never business repositories.
 */
import { digest, evaluatePairedAgentOutputs } from './paired-agent-eval.mjs';

export const PILOT_CALL_LIMIT = 18;
export const PILOT_TASK_IDS = Object.freeze(['bootstrap','cache-control','token-safety']);
const VARIANTS=Object.freeze(['original','candidate']);

export function pilotPlan(manifest) {
  if(manifest?.schema_version!==1 || !Array.isArray(manifest.tasks) ||
     manifest.tasks.length!==3 ||
     manifest.tasks.some((t,i)=>t.id!==PILOT_TASK_IDS[i] ||
       t.trials!==3 || !['regression','control','safety'].includes(t.kind) ||
       typeof t.prompt!=='string' || t.prompt.length>2000))
    throw Error('Unexpected pilot task manifest; only the frozen fictional pilot is allowed');
  const plan=[];
  let pair=0;
  for(let trial=1;trial<=3;trial++){
    for(const task of manifest.tasks){
      const order=pair++%2===0?VARIANTS:[...VARIANTS].reverse();
      for(const variant of order)plan.push({task_id:task.id,trial,variant});
    }
  }
  if(plan.length!==PILOT_CALL_LIMIT)throw Error('Unexpected Copilot request count');
  return plan;
}

export function pilotSummary({manifest,manifestBytes,originalSkillBytes,candidateSkillBytes,model}){
  const plan=pilotPlan(manifest);
  if(typeof manifestBytes!=='string'||typeof originalSkillBytes!=='string'||typeof candidateSkillBytes!=='string')
    throw Error('Missing frozen pilot file bytes');
  if(JSON.stringify(JSON.parse(manifestBytes))!==JSON.stringify(manifest))
    throw Error('Pilot task manifest diverged from raw bytes');
  if(!originalSkillBytes.includes('name: fictional-demo-runtime') ||
     !candidateSkillBytes.includes('name: fictional-demo-runtime'))
    throw Error('Non-fictional skill files are not permitted in this pilot');
  return {pilot:'FICTIONAL_PROMPT_ONLY_AB',model,
    calls:plan.length,paired_trials:plan.length/2,tasks:manifest.tasks.length,
    manifest_sha256:digest(manifestBytes),
    original_skill_sha256:digest(originalSkillBytes),
    candidate_skill_sha256:digest(candidateSkillBytes),
    tools_enabled:false,source_repositories_accessed:false,
    note:'Dry-run only. No Copilot calls without explicit --execute, fixed --model and --max-requests 18.'};
}
function cleanModelId(id){
  if(typeof id!=='string'||id==='auto'||!(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/).test(id))
    throw Error('Use a fixed Copilot model ID (not auto) for comparable A/B runs');
  return id;
}
export async function runFictionalPairedPilot({
  manifest,manifestBytes,originalSkillBytes,candidateSkillBytes,
  client,model,maxRequests,onProgress=()=>{}
}){
  const selected=cleanModelId(model);
  const summary=pilotSummary({manifest,manifestBytes,originalSkillBytes,candidateSkillBytes,model:selected});
  if(maxRequests!==PILOT_CALL_LIMIT)
    throw Error('Exactly 18 explicitly budgeted model requests are required for the complete paired pilot');
  if(!client||typeof client.completeText!=='function')
    throw Error('A locally authenticated Copilot text client is required');
  const tasks=new Map(manifest.tasks.map(task=>[task.id,task]));
  const versions={original:originalSkillBytes,candidate:candidateSkillBytes};
  const runs=[];
  let calls=0;
  for(const step of pilotPlan(manifest)){
    if(calls>=maxRequests)throw Error('Copilot request cap reached');
    const task=tasks.get(step.task_id);
    const system=[
      'You are a coding assistant evaluating a FICTIONAL Demo Runtime example.',
      'No tools, no external files, no commands, no repository modifications.',
      'Use the following provided SKILL text to answer the task; treat it as the only SDK guidance.',
      'Keep responses concise and return the requested code line only.',
      '--- FICTIONAL SKILL START ---',
      versions[step.variant],
      '--- FICTIONAL SKILL END ---'
    ].join('\n');
    calls++;
    onProgress({completed:calls-1,total:maxRequests,task_id:step.task_id,trial:step.trial,variant:step.variant});
    // Never retry or switch models. A failure aborts without a complete
    // artifact, avoiding deceptive full-pair evaluation.
    const response=await client.completeText({system,user:task.prompt});
    if(typeof response!=='string'||!response.trim()||response.length>100000)
      throw Error('Invalid Copilot response; stopping without complete artifact');
    runs.push({task_id:step.task_id,trial:step.trial,variant:step.variant,
      completed:true,output:response});
  }
  const artifact={schema_version:1,provenance:{
    origin:'OPERATOR_SUPPLIED',agent:'copilot-sdk-prompt-only',model:selected,
    runner:'wizard-copilot-pilot-v1',
    environment_id:'fresh-isolated-tool-free-session-v1',
    manifest_sha256:summary.manifest_sha256,
    original_skill_sha256:summary.original_skill_sha256,
    candidate_skill_sha256:summary.candidate_skill_sha256
  },runs};
  const report=evaluatePairedAgentOutputs({manifest,manifestBytes,
    originalSkillBytes,candidateSkillBytes,artifact});
  return {artifact,report,request_count:calls,
    warning:'Local Copilot model completions only, not autonomous coding-agent task evaluation.'};
}
