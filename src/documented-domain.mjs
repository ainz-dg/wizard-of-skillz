/**
 * Documented-domain pilot. Reads explicitly selected local documentation and
 * proposes review-only Agent Skill drafts. Never mutates the inspected domain.
 * Evidence quotes prove source presence, NOT semantic correctness.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inventorySkills} from './skills.mjs';
import {writeJson} from './fs-utils.mjs';

const FORMATS=new Set(['.md','.txt','.json','.yml','.yaml']);
const MAX_FILES=250,MAX_DOC=150000,MAX_TOTAL=1500000,MAX_CANDIDATES=3;
const SKILL_NAME=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const digest=s=>createHash('sha256').update(s).digest('hex');
const compact=s=>String(s).replace(/\s+/g,' ').trim();

function canonicalDirectory(value,label) {
  const resolved=fs.realpathSync(value);
  if(!fs.statSync(resolved).isDirectory())throw Error(label+' must be a directory');
  return resolved;
}
function safeOutput(root,out,protectedRoots=[]) {
  const target=out?path.resolve(out):fs.mkdtempSync(path.join(os.tmpdir(),'wizard-domain-'));
  if(out) {
    const parent=canonicalDirectory(path.dirname(target),'Output parent');
    const real=path.join(parent,path.basename(target));
    for(const guarded of [root,...protectedRoots]){
      if(real===guarded||real.startsWith(guarded+path.sep))
        throw Error('Output must be outside the inspected repository and its resource sources');
    }
    fs.mkdirSync(real,{mode:0o700});
    return real;
  }
  return target;
}
function walkDocs(root) {
  const docs=[];let total=0,visited=0,skipped=0;
  const stack=[{absolute:root,relative:'',depth:0}];
  while(stack.length && docs.length<MAX_FILES && total<MAX_TOTAL){
    const node=stack.pop(),entries=fs.readdirSync(node.absolute,{withFileTypes:true})
      .sort((a,b)=>a.name.localeCompare(b.name,'en'));
    for(let i=entries.length-1;i>=0;i--){
      const entry=entries[i],relative=node.relative?node.relative+'/'+entry.name:entry.name;
      if(entry.isSymbolicLink()){skipped++;continue;}
      if(entry.isDirectory()){
        if(node.depth<12 && !entry.name.startsWith('.') && entry.name!=='node_modules'){
          stack.push({absolute:path.join(node.absolute,entry.name),relative,depth:node.depth+1});
        }else skipped++;
        continue;
      }
      if(!entry.isFile() || !FORMATS.has(path.extname(entry.name).toLowerCase()))continue;
      if(++visited>MAX_FILES) {skipped++;continue;}
      const abs=path.join(node.absolute,entry.name),size=fs.statSync(abs).size;
      if(size>MAX_DOC || size+total>MAX_TOTAL){skipped++;continue;}
      const bytes=fs.readFileSync(abs);
      if(bytes.includes(0)){skipped++;continue;}
      const content=bytes.toString('utf8');
      docs.push({id:'R'+(docs.length+1),path:relative,sha256:digest(bytes),content});
      total+=bytes.length;
    }
  }
  docs.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  docs.forEach((doc,i)=>{doc.id='R'+(i+1);});
  return {docs,skipped,bytes:total};
}
function exactEvidence(e,byId) {
  if(!e || typeof e.source_id!=='string'||typeof e.quote!=='string')return null;
  const doc=byId.get(e.source_id),quote=compact(e.quote);
  if(!doc||quote.length<12||quote.length>400||!compact(doc.content).includes(quote))return null;
  return {source_id:doc.id,path:doc.path,sha256:doc.sha256,quote};
}
function normalizeList(arr,max=12) {
  return Array.isArray(arr)?arr.filter(v=>typeof v==='string'&&v.trim())
    .slice(0,max).map(v=>v.trim().slice(0,240)):[];
}
function markdownSkill(candidate,domainName) {
  const heading=candidate.name.split('-').map(x=>x[0].toUpperCase()+x.slice(1)).join(' ');
  const lines=['---','name: '+candidate.name,
    'description: '+JSON.stringify(candidate.description),'---','',
    '# '+heading,'',
    '> DRAFT — human review required. Source quotes verify presence, not correctness.','',
    '## Purpose',candidate.purpose,'',
    '## Procedure'];
  candidate.steps.forEach((s,i)=>{
    lines.push(String(i+1)+'. '+s.instruction);
    for(const e of s.evidence)lines.push('   - Evidence: '+e.path+' (sha256 '+e.sha256.slice(0,12)+'), quote: '+JSON.stringify(e.quote));
  });
  const c=candidate.communication;
  if(c.terminology.length||c.include.length||c.avoid.length){
    lines.push('','## Communication — '+domainName);
    if(c.terminology.length)lines.push('Use domain terms: '+c.terminology.join('; ')+'.');
    if(c.include.length)lines.push('Include when relevant: '+c.include.join('; ')+'.');
    if(c.avoid.length)lines.push('Avoid: '+c.avoid.join('; ')+'.');
    lines.push('Adapt to the actual audience. Never report unperformed work or unverified outcomes.');
  }
  lines.push('','## Limits','- This draft does not authorize execution of domain operations.',
    '- No toolset operation can be assumed without an independently verified tool contract.',
    '- Human approval is required before installing or using this skill.','');
  return lines.join('\n');
}
export function reviewDomainResponse(raw,docs,{existingNames=[]}={}){
  const byId=new Map(docs.map(x=>[x.id,x]));
  const names=new Set(existingNames),issues=[],candidates=[];
  const proposals=Array.isArray(raw?.candidates)?raw.candidates.slice(0,MAX_CANDIDATES):[];
  if(Array.isArray(raw?.candidates)&&raw.candidates.length>MAX_CANDIDATES)
    issues.push('Only the first three candidate skills were considered');
  for(const item of proposals){
    if(!SKILL_NAME.test(item?.name??'')||item.name.length>64||names.has(item.name)){
      issues.push('Rejected invalid or duplicate candidate name');continue;
    }
    const steps=[];
    for(const step of Array.isArray(item.steps)?item.steps.slice(0,12):[]){
      const evidence=Array.isArray(step?.evidence)?step.evidence.map(e=>exactEvidence(e,byId)).filter(Boolean):[];
      if(typeof step?.instruction!=='string'||!step.instruction.trim()||evidence.length===0){
        issues.push('Candidate '+item.name+': unsupported step rejected');continue;
      }
      steps.push({instruction:step.instruction.trim().slice(0,500),evidence});
    }
    if(steps.length<2){
      issues.push('Candidate '+item.name+': fewer than two independently cited steps');continue;
    }
    names.add(item.name);
    candidates.push({
      name:item.name,
      description:String(item.description??'').trim().slice(0,500)||('Review '+item.name+' with human oversight'),
      purpose:String(item.purpose??'').trim().slice(0,800),
      audience:String(item.audience??'').trim().slice(0,160),
      steps,
      communication:{
        terminology:normalizeList(item.communication?.terminology),
        include:normalizeList(item.communication?.include),
        avoid:normalizeList(item.communication?.avoid)
      },
      risks:normalizeList(item.risks),
      verification:'SOURCE_QUOTE_MATCH_ONLY',
      human_approval_required:true
    });
  }
  const existingReviews=(Array.isArray(raw?.existing_reviews)?raw.existing_reviews:[])
    .filter(x=>existingNames.includes(x?.skill)&&typeof x?.concern==='string')
    .slice(0,25).map(x=>({
      skill:x.skill,concern:x.concern.slice(0,500),
      evidence:Array.isArray(x.evidence)?x.evidence.map(e=>exactEvidence(e,byId)).filter(Boolean):[],
      verification:'NEEDS_REVIEW'
    }));
  return {candidates,existing_reviews:existingReviews,issues};
}
export const DOCUMENTED_DOMAIN_PROMPT=[
  'You are Wizard of Skillz, a conservative document-grounded Agent Skills designer.',
  'The source documents describe a domain, NOT necessarily agent procedures.',
  'Do not invent tools, commands, permissions, measurements, regulatory requirements, or operational steps.',
  'Return up to 3 useful recurring procedural skills, or zero if the resources are only descriptive or insufficient.',
  'Each candidate must have >=2 actionable steps, each citing an exact verbatim source quote (12-400 chars).',
  'Use source_id values from input. Do not cite a skill as evidence for itself.',
  'Domain terminology, output content, and intended recipient may differ greatly from a coding agent.',
  'Produce domain-specific communication guidance only when supported by sources; otherwise leave empty.',
  'Flag gaps, ambiguities and conflicts; do not claim citation proves semantic correctness.',
  'Review existing skills for likely mismatches but never auto-edit them.',
  'Return JSON object: {"candidates":[{"name":"kebab-case","description":"...","purpose":"...","audience":"...","steps":[{"instruction":"...","evidence":[{"source_id":"R1","quote":"exact quote"}]}],"communication":{"terminology":[],"include":[],"avoid":[]},"risks":[]}],"existing_reviews":[{"skill":"existing-name","concern":"...","evidence":[{"source_id":"R1","quote":"exact quote"}]}]}'
].join('\n');

export async function runDocumentedDomain({root,resources,skills='skills',out=null,client=null}={}){
  if(!root)throw Error('Domain repository required');
  const base=canonicalDirectory(root,'Domain repository');
  if(typeof resources!=='string'||!resources.trim())throw Error('Explicit --resources path is required');
  const docsRoot=canonicalDirectory(path.resolve(base,resources),'Resources');
  const skillsPath=path.resolve(base,skills);
  if(skillsPath!==base&&!skillsPath.startsWith(base+path.sep))
    throw Error('Skills directory must be inside the inspected repository');
  const skillsReal=fs.existsSync(skillsPath)?canonicalDirectory(skillsPath,'Skills'):null;
  if(skillsReal&&skillsReal!==base&&!skillsReal.startsWith(base+path.sep))
    throw Error('Skills directory resolves outside the inspected repository');
  const existing=skillsReal?inventorySkills(skillsReal,{safeRoot:true}):[];
  if(docsRoot===skillsPath || docsRoot.startsWith(skillsPath+path.sep) || skillsPath.startsWith(docsRoot+path.sep))
    throw Error('Resources and skills must be separate paths');
  const {docs,skipped,bytes}=walkDocs(docsRoot);
  if(!docs.length)throw Error('No eligible resource documents to inspect');
  // Validate the destination before any optional remote model request.
  const output=safeOutput(base,out,[docsRoot,...(skillsReal?[skillsReal]:[])]);
  const response=client?await client.completeJson({
    system:DOCUMENTED_DOMAIN_PROMPT,
    user:JSON.stringify({
      documents:docs.map(({id,path,sha256,content})=>({id,path,sha256,content})),
      existing_skills:existing.map(s=>({name:s.id,path:s.path,text:s.text.slice(0,6000)})),
      constraints:{max_candidates:MAX_CANDIDATES,toolset:'unavailable-unless-independently-verified'}
    })
  }):null;
  const review=response?reviewDomainResponse(response,docs,{existingNames:existing.map(s=>s.id)}):
    {candidates:[],existing_reviews:[],issues:[]};
  const domainName=path.basename(base);
  const drafts=[];
  for(const c of review.candidates){
    const folder=path.join(output,'skill-candidates',c.name);
    fs.mkdirSync(folder,{recursive:true,mode:0o700});
    const relative='skill-candidates/'+c.name+'/SKILL.md';
    fs.writeFileSync(path.join(folder,'SKILL.md'),markdownSkill(c,domainName),{mode:0o600,flag:'wx'});
    drafts.push({name:c.name,path:relative,status:'DRAFT_REQUIRES_APPROVAL'});
  }
  const summary={
    schema_version:1,profile:'documented-domain',root:base,resources_root:docsRoot,
    skills_root:skillsPath,resources_count:docs.length,skipped_resources:skipped,
    bytes_scanned:bytes,existing_skill_count:existing.length,
    proposal_count:drafts.length,model_invoked:Boolean(client),
    verdict:'REVIEW_REQUIRED',semantic_truth_verified:false,
    toolset_verified:false,write_authorized:false,applied_count:0,
    source_index:docs.map(({id,path,sha256})=>({id,path,sha256})),
    draft_skills:drafts,existing_reviews:review.existing_reviews,issues:review.issues,
    note:'Source quote matching establishes provenance only; all functional and communication choices require human review.'
  };
  writeJson(path.join(output,'domain-audit.json'),summary);
  writeJson(path.join(output,'candidate-details.json'),review);
  return {output_directory:output,...summary};
}
