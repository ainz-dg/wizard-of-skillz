/**
 * One-command, local-only intake. It deliberately does not invent provider
 * ownership, semantic verification, missing skills, or executable patches.
 * All artifacts live outside the inspected project.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inventorySkills,auditSkillReferenceLinks} from './skills.mjs';
import {auditLocalPathMentions} from './local-path-mentions.mjs';
import {inspectSkillAdapters} from './skill-adapters.mjs';
import {inspectSourceConsistency,consistencyUpdateProposals} from './source-consistency.mjs';
import {proposeSkillReferenceRepairs} from './skill-reference-proposals.mjs';
import {writeJson} from './fs-utils.mjs';

function directoryOutside(root,requested){
  // Explicit output must be a new directory under an existing parent.
  // Canonicalize the parent before creating anything to catch symlink escapes.
  const out=path.resolve(requested);
  const parent=fs.realpathSync(path.dirname(out));
  const canonical=path.join(parent,path.basename(out));
  if(canonical===root || canonical.startsWith(root+path.sep))
    throw Error('Refusing scan output inside inspected repository');
  return canonical;
}

export function createLocalScan(root,{out=null,repoId=null}={}){
  const project=fs.realpathSync(root);
  if(!fs.statSync(project).isDirectory())throw Error('Repository root must be a directory');
  const id=repoId??'local/'+path.basename(project).replace(/[^a-zA-Z0-9._-]/g,'-')+
    '-'+createHash('sha256').update(project).digest('hex').slice(0,8);
  if(typeof id!=='string'||!id.trim())throw Error('Repository id is required');
  let target;
  if(out){
    target=directoryOutside(project,out);
    // Refuse an existing path rather than replacing previous reviews.
    fs.mkdirSync(target,{mode:0o700});
  }else{
    const temporaryRoot=fs.realpathSync(os.tmpdir());
    if(temporaryRoot===project || temporaryRoot.startsWith(project+path.sep))
      throw Error('Temporary output would be inside inspected repository; supply --out outside it');
    target=fs.mkdtempSync(path.join(temporaryRoot,'wizard-of-skillz-'));
    fs.chmodSync(target,0o700);
  }

  const skills=inventorySkills(project,{safeRoot:true});
  const references=auditSkillReferenceLinks(project,skills);
  const localPaths=auditLocalPathMentions(project,skills);
  const adapters=inspectSkillAdapters(skills);
  const consistency=inspectSourceConsistency(project,skills);
  const linkRepairs=proposeSkillReferenceRepairs({repoId:id,skills,audit:references});
  const sourceRepairs=consistencyUpdateProposals(consistency,id);
  const proposals={schema_version:1,consumer_repo:id,proposals:[
    ...linkRepairs.proposals,...sourceRepairs.proposals
  ],discovery:'LOCAL_STRUCTURAL_CHECKS_ONLY',read_only:true};
  const summary={
    schema_version:1,mode:'LOCAL_STRUCTURAL_ONLY',repository:id,
    skill_count:skills.length,proposal_count:proposals.proposals.length,
    reference_summary:references.summary,local_path_summary:localPaths.summary,
    source_summary:consistency.summary,
    adapter_summary:adapters.summary,scope_evaluated:false,
    semantic_verification:false,provider_cross_check:false,
    llm_used:false,write_authorized:false,applied_count:0,
    note:'Bounded local checks only; no semantic proof, scope ownership, or automatic fixes.'
  };
  writeJson(path.join(target,'skill-inventory.json'),skills.map(({text,...item})=>item));
  writeJson(path.join(target,'skill-reference-links.json'),references);
  writeJson(path.join(target,'local-path-mentions.json'),localPaths);
  writeJson(path.join(target,'skill-adapters.json'),adapters);
  writeJson(path.join(target,'source-consistency.json'),consistency);
  writeJson(path.join(target,'repair-proposals.json'),proposals);
  writeJson(path.join(target,'local-scan-summary.json'),summary);
  return {output_directory:target,...summary};
}
