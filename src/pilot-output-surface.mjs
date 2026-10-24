/**
 * Post-hoc, task-specific surface checker for the fixed fictional pilot.
 * NOT Java parsing, compilation, execution, or security verification.
 */
import { evaluatePairedAgentOutputs } from './paired-agent-eval.mjs';

const SURFACES=Object.freeze({
  bootstrap:/^Runtime\.start\((?:APP_ID,\s*DemoConfig\.class|new StartupContext<>\(APP_ID,\s*DemoConfig\.class\))\);$/,
  'cache-control':/^setCacheTtl\(60\);$/,
  'token-safety':/^readTokenFromEnvironment\(\);$/
});
const TASK_IDS=Object.freeze(Object.keys(SURFACES));
function surface(output,task){
  const failures=[];
  if(output!==output.trim())failures.push('SURROUNDING_WHITESPACE');
  if(output.includes('\n')||output.includes('\r'))failures.push('MULTILINE');
  if(output.includes(String.fromCharCode(96)))failures.push('MARKDOWN_FENCE_OR_BACKTICK');
  if(output.includes('//')||output.includes('/*'))failures.push('COMMENT_OR_EXTRA_CONTENT');
  if(!output.endsWith(';'))failures.push('MISSING_STATEMENT_TERMINATOR');
  if(!SURFACES[task].test(output))failures.push('OUTSIDE_FIXED_TASK_GRAMMAR');
  return {pass:failures.length===0,failures};
}

export function gradeFictionalPilotOutputSurface({manifest,manifestBytes,
  originalSkillBytes,candidateSkillBytes,artifact}){
  // Reuse full pair completeness, manifest identity and SHA-256 provenance.
  const literal=evaluatePairedAgentOutputs({
    manifest,manifestBytes,originalSkillBytes,candidateSkillBytes,artifact
  });
  if(manifest.tasks.length!==TASK_IDS.length ||
     manifest.tasks.some((t,i)=>t.id!==TASK_IDS[i]||t.trials!==3))
    throw Error('Only the fixed three-task fictional pilot can be surface-graded');
  const raw=new Map(artifact.runs.map(r=>[r.task_id+'\0'+r.trial+'\0'+r.variant,r.output]));
  const categories={},pairs=[];
  const totals={original_passes:0,candidate_passes:0,paired_trials:0,
    candidate_wins:0,original_wins:0,ties_both_pass:0,ties_both_fail:0,
    original_format_failures:0,candidate_format_failures:0};
  for(const task of manifest.tasks){
    const record=categories[task.id]={kind:task.kind,paired_trials:0,original_passes:0,candidate_passes:0};
    for(let trial=1;trial<=3;trial++){
      const original=surface(raw.get(task.id+'\0'+trial+'\0original'),task.id);
      const candidate=surface(raw.get(task.id+'\0'+trial+'\0candidate'),task.id);
      record.paired_trials++;totals.paired_trials++;
      if(original.pass){record.original_passes++;totals.original_passes++;}
      else totals.original_format_failures++;
      if(candidate.pass){record.candidate_passes++;totals.candidate_passes++;}
      else totals.candidate_format_failures++;
      const outcome=candidate.pass&&!original.pass?'CANDIDATE_WIN':
        original.pass&&!candidate.pass?'ORIGINAL_WIN':
        original.pass?'BOTH_PASS':'BOTH_FAIL';
      if(outcome==='CANDIDATE_WIN')totals.candidate_wins++;
      if(outcome==='ORIGINAL_WIN')totals.original_wins++;
      if(outcome==='BOTH_PASS')totals.ties_both_pass++;
      if(outcome==='BOTH_FAIL')totals.ties_both_fail++;
      pairs.push({task_id:task.id,trial,original,candidate,outcome});
    }
  }
  return {
    schema_version:1,grader:'FICTIONAL_TASK_SURFACE_V1',
    basis:'POST_HOC_FIXED_OUTPUT_SHAPE_NOT_JAVA_COMPILATION',
    provenance:{...literal.provenance},
    literal_baseline:{summary:literal.summary,unchanged:true},
    surface_summary:{...totals,
      original_pass_rate:totals.original_passes/totals.paired_trials,
      candidate_pass_rate:totals.candidate_passes/totals.paired_trials},
    by_task:categories,pairs,safe_to_promote:false,
    warning:'Fixture-specific line/terminator and exact expression-form checks only. NOT a Java compiler or real agent task evaluation.'
  };
}
