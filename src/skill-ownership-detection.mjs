/**
 * Conservative, read-only ownership hints. A destination-repository declaration
 * + an exact SHA-256 of the source SKILL.md is evidence of an explicit claim,
 * not independent proof that the destination is the right owner.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {proposeSkillMoveReview} from './skill-move-proposals.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{64}$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKIP = new Set(['.git','node_modules','dist','target']);
const MAX_SKILLS = 64;
const MAX_VISITS = 20000;

function safeRelative(value) {
  if(typeof value !== 'string' || !value || value.length > 1024 ||
     value.includes('\\') || value.includes('\0') || value.startsWith('/') ||
     value.startsWith('~') || /^[A-Za-z]:/.test(value) ||
     value.split('/').some(x=>!x || x==='.' || x==='..'))
    throw Error('Unsafe ownership declaration path');
  return value;
}
function readDeclaration(root, filename) {
  const rel=safeRelative(filename);
  let current=root;
  for(const [index,part] of rel.split('/').entries()) {
    current=path.join(current,part);
    const stat=fs.lstatSync(current,{throwIfNoEntry:false});
    if(!stat)throw Error('Ownership declaration not found: '+rel);
    if(stat.isSymbolicLink())throw Error('Symlink in ownership declaration path: '+rel);
    const last=index===rel.split('/').length-1;
    if(last ? !stat.isFile() : !stat.isDirectory())
      throw Error('Invalid ownership declaration path: '+rel);
    if(last && stat.size>64*1024)throw Error('Ownership declaration exceeds size limit');
  }
  const bytes=fs.readFileSync(current);
  return {source:JSON.parse(bytes.toString('utf8')),evidence:{
    repo:null,path:rel,sha256:digest(bytes)
  }};
}

// Deliberately no symlink following, hidden scan heuristics or source-code
// interpretation. The declaration must name the skill and the exact bytes.
function locateSkillMains(root,names) {
  const found=new Map([...names].map(name=>[name,[]]));
  let visited=0;
  const visit=(dir,depth) => {
    if(depth>18)throw Error('Source directory nesting exceeds inspection limit');
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      if(++visited>MAX_VISITS)throw Error('Source inspection exceeds file limit');
      if(entry.isSymbolicLink() || SKIP.has(entry.name))continue;
      const absolute=path.join(dir,entry.name);
      if(entry.isDirectory()){visit(absolute,depth+1);continue;}
      if(entry.isFile() && entry.name==='SKILL.md') {
        const name=path.basename(dir);
        if(!names.has(name))continue;
        const bytes=fs.readFileSync(absolute);
        found.get(name).push({
          path:path.relative(root,absolute).split(path.sep).join('/'),
          sha256:digest(bytes)
        });
      }
    }
  };
  visit(root,0);
  return found;
}

export function detectOwnershipMoves({
  sourceRoot,sourceRepo,targetRoot,targetRepo,ownershipFile,skillsDir
}) {
  if(typeof sourceRepo!=='string'||!sourceRepo.trim()||
     typeof targetRepo!=='string'||!targetRepo.trim())
    throw Error('Source and destination repository IDs are required');
  const source=fs.realpathSync(sourceRoot),target=fs.realpathSync(targetRoot);
  if(!fs.statSync(source).isDirectory()||!fs.statSync(target).isDirectory()||
     source===target||sourceRepo===targetRepo)
    throw Error('Ownership detection requires two distinct repositories');
  const {source:manifest,evidence}=readDeclaration(target,ownershipFile);
  if(!manifest || manifest.schema_version!==1 ||
     manifest.owner_repo!==targetRepo || manifest.source_repo!==sourceRepo ||
     !Array.isArray(manifest.skills) || manifest.skills.length>MAX_SKILLS)
    throw Error('Invalid or mismatched ownership declaration');
  const seen=new Set();
  for(const item of manifest.skills) {
    if(!item||typeof item.name!=='string'||!NAME.test(item.name)||
       typeof item.source_skill_sha256!=='string'||!SHA.test(item.source_skill_sha256)||
       seen.has(item.name))
      throw Error('Invalid or duplicated skill ownership entry');
    seen.add(item.name);
  }
  evidence.repo=targetRepo;
  const found=locateSkillMains(source,seen);
  const checks=[],proposals=[],file_manifest=[];
  for(const item of manifest.skills) {
    const candidates=found.get(item.name);
    const check={skill:item.name,source_candidates:candidates.length,
      expected_sha256:item.source_skill_sha256,status:null};
    if(candidates.length===0)check.status='SOURCE_NOT_FOUND';
    else if(candidates.length>1)check.status='AMBIGUOUS_SOURCE';
    else if(candidates[0].sha256!==item.source_skill_sha256) {
      check.status='SOURCE_HASH_MISMATCH';
      check.actual_sha256=candidates[0].sha256;
    } else {
      check.source_path=candidates[0].path;
      try {
        const move=proposeSkillMoveReview({
          sourceRoot:source,sourceRepo,sourceSkill:candidates[0].path,
          targetRoot:target,targetRepo,skillsDir,
          reason:'Target repository declares ownership of '+item.name+
            '; exact source SKILL.md hash matches. Ownership claim requires human review.'
        });
        const proposal=move.proposals[0];
        proposal.evidence.push({...evidence});
        proposal.limits.push(
          'Ownership declaration is a repository-local claim, not objective proof of correct ownership.'
        );
        proposals.push(proposal);
        file_manifest.push(...move.file_manifest.map(f=>({...f,proposal_id:proposal.id})));
        check.status='MOVE_CANDIDATE';
        check.proposal_id=proposal.id;
      } catch(error) {
        // Invalid or occupied moves are evidence for review, never an action.
        check.status='MOVE_BLOCKED';
        check.reason=error.message;
      }
    }
    checks.push(check);
  }
  return {schema_version:1,consumer_repo:sourceRepo,provider_repo:targetRepo,
    basis:'TARGET_REPOSITORY_OWNERSHIP_DECLARATION_WITH_SOURCE_SHA256',
    declaration:evidence,checks,proposals,file_manifest,
    write_authorized:false,confirmation_required:true,
    note:'A declared owner is not objectively verified. No skills or repository files were modified.'};
}
