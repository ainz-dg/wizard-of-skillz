#!/usr/bin/env node
/** Offline, read-only, fictional-task output shape grader. Never executes code. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gradeFictionalPilotOutputSurface } from '../src/pilot-output-surface.mjs';

const idx=process.argv.indexOf('--runs');
if(idx<0||!process.argv[idx+1]){
  console.error('Usage: node scripts/grade-copilot-pilot-shape.mjs --runs /private/path/paired-runs.json');
  process.exit(2);
}
const root=new URL('../tests/fixtures/copilot-pilot-v1/',import.meta.url);
const manifestBytes=fs.readFileSync(new URL('tasks.json',root),'utf8');
const originalSkillBytes=fs.readFileSync(new URL('SKILL.original.md',root),'utf8');
const candidateSkillBytes=fs.readFileSync(new URL('SKILL.candidate.md',root),'utf8');
try{
  const artifact=JSON.parse(fs.readFileSync(process.argv[idx+1],'utf8'));
  const report=gradeFictionalPilotOutputSurface({manifest:JSON.parse(manifestBytes),
    manifestBytes,originalSkillBytes,candidateSkillBytes,artifact});
  // Only aggregate scores and failure categories. Never echo model outputs.
  const sanitized={
    grader:report.grader,basis:report.basis,
    literal_baseline:report.literal_baseline.summary,
    surface_summary:report.surface_summary,
    by_task:report.by_task,
    failures:report.pairs.filter(p=>!p.original.pass||!p.candidate.pass)
      .map(p=>({task_id:p.task_id,trial:p.trial,
        original_failures:p.original.failures,
        candidate_failures:p.candidate.failures})),
    safe_to_promote:false,warning:report.warning
  };
  console.log(JSON.stringify(sanitized,null,2));
}catch(error){
  console.error('[pilot-shape] Evaluation failed: '+error.message);
  process.exitCode=1;
}
