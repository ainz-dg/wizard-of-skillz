/**
 * User-authored complete replacement SKILL.md candidates.
 * Staging never edits a source repository, never invents a correction and
 * does not grant Apply permission. Candidates become ordinary review diffs.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {buildReviewCatalog} from './review-selection.mjs';
import {lifecyclePreviews} from './skill-lifecycle.mjs';

const LIMIT=2_000_000;
const MANIFEST='review-candidates.json';
const sha=value=>createHash('sha256').update(value).digest('hex');
const decoder=new TextDecoder('utf-8',{fatal:true});
const digestSet=proposals=>sha(JSON.stringify(proposals));
function textFile(file){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.size>LIMIT)throw Error('Candidate/source must be a regular UTF-8 file (max 2 MB)');
  return decoder.decode(fs.readFileSync(file));
}
function safeSource(root,relative){
  if(!root||typeof relative!=='string'||!relative||relative.length>1024||
    relative.includes('\\')||relative.includes('\0')||relative.startsWith('/')||
    /^(?:[A-Za-z]:|~)/.test(relative)||
    relative.split('/').some(part=>!part||part==='.'||part==='..')||
    !/(^|\/)SKILL\.md$/.test(relative))
    throw Error('Only explicit existing SKILL.md UPDATE targets are supported');
  const base=fs.realpathSync(root);
  let target=base;
  for(const [i,part] of relative.split('/').entries()){
    target=path.join(target,part);
    const stat=fs.lstatSync(target);
    if(stat.isSymbolicLink())throw Error('Symbolic link in UPDATE target');
    if(i<relative.split('/').length-1&&!stat.isDirectory())
      throw Error('Invalid target directory');
    if(i===relative.split('/').length-1&&!stat.isFile())
      throw Error('UPDATE target is not a regular file');
  }
  if(!target.startsWith(base+path.sep))throw Error('UPDATE escapes inspected project');
  return target;
}
function auditOutside(auditFolder,consumerRoot){
  const audit=fs.realpathSync(auditFolder),root=fs.realpathSync(consumerRoot);
  if(!fs.statSync(audit).isDirectory()||audit===root||audit.startsWith(root+path.sep))
    throw Error('Audit folder must be outside the inspected project');
  return audit;
}
export function candidateDiff(before,after,relative){
  if(before===after)return '';
  const a=before.split('\n'),b=after.split('\n');
  let pre=0;
  while(pre<Math.min(a.length,b.length)&&a[pre]===b[pre])pre++;
  let post=0;
  while(post<a.length-pre&&post<b.length-pre&&
    a[a.length-1-post]===b[b.length-1-post])post++;
  const left=a.slice(pre,a.length-post),right=b.slice(pre,b.length-post);
  const contextBefore=a.slice(Math.max(0,pre-2),pre);
  const contextAfter=a.slice(a.length-post,Math.min(a.length,a.length-post+2));
  const start=Math.max(0,pre-2);
  return ['--- a/'+relative,'+++ b/'+relative,
    '@@ -'+(start+1)+','+(contextBefore.length+left.length+contextAfter.length)+
    ' +'+(start+1)+','+(contextBefore.length+right.length+contextAfter.length)+' @@',
    ...contextBefore.map(x=>' '+x),...left.map(x=>'-'+x),
    ...right.map(x=>'+'+x),...contextAfter.map(x=>' '+x)].join('\n')+'\n';
}
export function readReviewCandidates(folder,proposalSet){
  const file=path.join(folder,MANIFEST);
  let stat;
  try{stat=fs.lstatSync(file);}
  catch(error){if(error.code==='ENOENT')return {schema_version:1,mode:'USER_CANDIDATE_DRAFTS',
    proposals_sha256:digestSet(proposalSet),candidates:[]};throw error;}
  if(!stat.isFile()||stat.size>16_000_000)throw Error('Unsafe review candidate manifest');
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  if(data?.schema_version!==1||data.mode!=='USER_CANDIDATE_DRAFTS'||
    data.proposals_sha256!==digestSet(proposalSet)||!Array.isArray(data.candidates)||
    data.candidates.length>100)
    throw Error('Candidate manifest does not match the current audit');
  const ids=new Set();
  for(const entry of data.candidates){
    if(typeof entry?.proposal_id!=='string'||ids.has(entry.proposal_id)||
       entry.action!=='UPDATE'||typeof entry.repo!=='string'||
       typeof entry.target_path!=='string'||typeof entry.content!=='string'||
       entry.content.length>LIMIT||
       !/^[0-9a-f]{64}$/.test(entry.source_sha256??'')||
       sha(entry.content)!==entry.candidate_sha256||
       (entry.group_ids!==undefined&&(
         !Array.isArray(entry.group_ids)||!entry.group_ids.includes(entry.proposal_id)||
         entry.group_ids.some(id=>typeof id!=='string')||
         new Set(entry.group_ids).size!==entry.group_ids.length)))
      throw Error('Malformed or duplicated staged candidate');
    ids.add(entry.proposal_id);
  }
  return data;
}
function writeManifest(folder,data){
  const dest=path.join(folder,MANIFEST);
  try{const st=fs.lstatSync(dest);if(!st.isFile())throw Error('Refusing symlinked candidate manifest');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const temp=path.join(folder,'.wizard-review-candidates-'+randomBytes(12).toString('hex')+'.tmp');
  try{
    fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
    fs.renameSync(temp,dest);
  }finally{
    try{fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
export function stageUpdateText(auditFolder,{consumerRoot,proposalId,proposalIds=null,content}={}){
  const ids=proposalIds??[proposalId];
  if(!consumerRoot||!Array.isArray(ids)||!ids.length||
     new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id)||
     typeof content!=='string')
    throw Error('Root, unique proposal IDs and candidate text required');
  const folder=auditOutside(auditFolder,consumerRoot);
  const proposalSet=JSON.parse(fs.readFileSync(path.join(folder,'repair-proposals.json'),'utf8'));
  const nativeFile=path.join(folder,'repair-previews.json');
  const native=fs.existsSync(nativeFile)?JSON.parse(fs.readFileSync(nativeFile,'utf8')):null;
  const catalog=buildReviewCatalog(proposalSet,{previews:native});
  const entries=ids.map(id=>{
    const found=catalog.items.find(p=>p.id===id);
    if(!found)throw Error('Unknown proposal ID: '+id);
    return found;
  });
  const item=entries[0];
  if(item.action!=='UPDATE'||!item.source||!item.target||
     item.source.repo!==item.target.repo||item.source.path!==item.target.path||
     item.target.repo!==catalog.source_repositories.consumer)
    throw Error('Only existing consumer-repo UPDATE targets can be staged');
  for(const entry of entries){
    if(entry.action!=='UPDATE'||!entry.source||!entry.target||
       entry.source.repo!==item.target.repo||entry.source.path!==item.target.path||
       entry.target.repo!==item.target.repo||entry.target.path!==item.target.path)
      throw Error('Grouped proposals must UPDATE the same existing skill');
  }
  if(native?.previews?.some(p=>ids.includes(p.proposal_id)&&p.status==='PREVIEW_READY'))
    throw Error('Proposal already has a source-verified native preview');
  const file=safeSource(consumerRoot,item.target.path);
  const original=textFile(file);
  for(const entry of entries){
    const expected=entry.evidence?.find(e=>e.repo===item.target.repo&&e.path===item.target.path&&e.sha256);
    if(expected && sha(original)!==expected.sha256)
      throw Error('Source differs from the proposal audit evidence; run a fresh scan');
  }
  const candidate=content;
  if(Buffer.byteLength(candidate,'utf8')>LIMIT)throw Error('Candidate exceeds 2 MB');
  if(!candidate.trim()||original===candidate)throw Error('Candidate is empty or unchanged');
  const data=readReviewCandidates(folder,proposalSet);
  // Replacing any previous candidate for this target is explicit and complete.
  // Prevent stale overlapping groups from silently claiming different content.
  const conflict=data.candidates.find(c=>c.target_path===item.target.path &&
    !ids.includes(c.proposal_id));
  if(conflict)throw Error('Another staged candidate touches the same file: '+
    conflict.proposal_id+'. Consolidate its proposal IDs in one draft.');
  const groups=[...ids].sort();
  for(const id of ids){
    const entry={proposal_id:id,action:'UPDATE',repo:item.target.repo,
      target_path:item.target.path,source_sha256:sha(original),
      candidate_sha256:sha(candidate),content:candidate,
      diff:candidateDiff(original,candidate,item.target.path),
      group_ids:groups};
    const index=data.candidates.findIndex(c=>c.proposal_id===id);
    if(index>=0)data.candidates[index]=entry;else data.candidates.push(entry);
  }
  writeManifest(folder,data);
  return {proposal_id:groups[0],proposal_ids:groups,target_path:item.target.path,
    before_sha256:sha(original),after_sha256:sha(candidate),
    staged_count:data.candidates.length,write_authorized:false};
}
/** Backwards-compatible import from an external edited file. */
export function stageUpdateCandidate(auditFolder,{consumerRoot,proposalId,candidateFile}={}){
  if(!candidateFile)throw Error('A candidate file is required');
  return stageUpdateText(auditFolder,{consumerRoot,proposalId,content:textFile(candidateFile)});
}

export function inspectUpdateDraft(auditFolder,{consumerRoot,proposalIds}={}){
  if(!Array.isArray(proposalIds)||!proposalIds.length||
     new Set(proposalIds).size!==proposalIds.length)
    throw Error('Supply one or more unique UPDATE proposal IDs');
  const folder=auditOutside(auditFolder,consumerRoot);
  const proposalSet=JSON.parse(fs.readFileSync(path.join(folder,'repair-proposals.json'),'utf8'));
  const file=path.join(folder,'repair-previews.json');
  const native=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  const catalog=buildReviewCatalog(proposalSet,{previews:native});
  const items=proposalIds.map(id=>{
    const candidate=catalog.items.find(x=>x.id===id);
    if(!candidate)throw Error('Unknown proposal ID: '+id);
    return candidate;
  });
  const item=items[0];
  if(!item||item.action!=='UPDATE'||!item.source||!item.target||
     item.source.repo!==item.target.repo||item.source.path!==item.target.path||
     item.target.repo!==catalog.source_repositories.consumer)
    throw Error('Only existing consumer SKILL.md UPDATE proposals can be drafted');
  if(items.some(candidate=>candidate.action!=='UPDATE'||!candidate.source||
    !candidate.target||candidate.source.repo!==item.target.repo||
    candidate.source.path!==item.target.path||
    candidate.target.repo!==item.target.repo||
    candidate.target.path!==item.target.path))
    throw Error('All selected proposals must UPDATE the same SKILL.md');
  if(native?.previews?.some(p=>proposalIds.includes(p.proposal_id)&&p.status==='PREVIEW_READY'))
    throw Error('A native preview already exists for one of these proposals');
  const target=safeSource(consumerRoot,item.target.path);
  const before=textFile(target);
  for(const candidate of items){
    const expected=candidate.evidence.find(e=>e.repo===item.target.repo&&
      e.path===item.target.path&&e.sha256);
    if(expected&&sha(before)!==expected.sha256)
      throw Error('Source differs from the audited source; run a new scan');
  }
  const evidence=[];
  for(const e of items.flatMap(i=>i.evidence)){
    if(e.repo!==item.target.repo||e.path===item.target.path||!e.sha256)continue;
    try{
      // Only inspect source files in this repository, never other repositories.
      if(e.path.length>1024||e.path.includes('\\')||
        e.path.split('/').some(p=>!p||p==='.'||p==='..'))continue;
      const base=fs.realpathSync(consumerRoot);
      const absolute=path.join(base,e.path);
      const st=fs.lstatSync(absolute);
      if(!st.isFile()||st.size>20000)continue;
      const real=fs.realpathSync(absolute);
      if(!real.startsWith(base+path.sep))continue;
      const text=textFile(absolute);
      if(sha(text)!==e.sha256)
        throw Error('Evidence source has changed: '+e.path);
      evidence.push({path:e.path,content:text});
      if(evidence.length>=3)break;
    }catch(error){
      if(error.message.startsWith('Evidence source has changed:'))throw error;
    }
  }
  // Reopening a staged draft in the editor must retain previous edits.
  // Source snapshots and SHA checks always refer to the actual repository.
  const prior=readReviewCandidates(folder,proposalSet).candidates.find(c=>
    c.proposal_id===item.id &&
    JSON.stringify([...(c.group_ids??[c.proposal_id])].sort())===
      JSON.stringify([...proposalIds].sort()) &&
    c.source_sha256===sha(before));
  return {item,items,before,editable:prior?.content??before,evidence,
    consumer_repo:catalog.source_repositories.consumer};
}

export function loadReviewPreviews(folder,proposalSet,native=null){
  const data=readReviewCandidates(folder,proposalSet);
  const map=new Map((native?.previews??[]).map(p=>[p.proposal_id,p]));
  const catalog=buildReviewCatalog(proposalSet,{previews:native});
  for(const c of data.candidates){
    const item=catalog.items.find(p=>p.id===c.proposal_id);
    if(!item||item.action!=='UPDATE'||!item.source||!item.target||
       item.source.repo!==c.repo||item.target.repo!==c.repo||
       item.source.path!==c.target_path||item.target.path!==c.target_path||
       (map.get(c.proposal_id)?.status==='PREVIEW_READY'))
      throw Error('Staged candidate does not match an eligible UPDATE proposal');
    map.set(c.proposal_id,{proposal_id:c.proposal_id,status:'PREVIEW_READY',
      user_candidate:true,auto_apply:false,target_repo:c.repo,target_path:c.target_path,
      preconditions:{source_sha256:c.source_sha256},
      candidate_sha256:c.candidate_sha256,content:c.content,diff:c.diff,
      group_ids:c.group_ids??[c.proposal_id]});
  }
  for(const preview of lifecyclePreviews(folder,proposalSet)){
    if(map.has(preview.proposal_id))
      throw Error('Native or UPDATE preview already exists for lifecycle proposal');
    map.set(preview.proposal_id,preview);
  }
  for(const c of data.candidates){
    for(const sibling of c.group_ids??[c.proposal_id]){
      const other=data.candidates.find(x=>x.proposal_id===sibling);
      if(!other || other.target_path!==c.target_path ||
         other.source_sha256!==c.source_sha256 ||
         other.candidate_sha256!==c.candidate_sha256 ||
         JSON.stringify(other.group_ids??[other.proposal_id])!==
         JSON.stringify(c.group_ids??[c.proposal_id]))
        throw Error('Incomplete or inconsistent consolidated candidate group');
    }
  }
  return {schema_version:1,mode:'REVIEW_PREVIEWS',
    consumer_repo:proposalSet.consumer_repo,
    provider_repo:proposalSet.provider_repo??null,
    previews:[...map.values()]};
}
export function reconstructUserUpdate(preview,consumerRoot){
  if(preview?.status!=='PREVIEW_READY'||preview.user_candidate!==true||
     typeof preview.content!=='string'||preview.content.length>LIMIT||
     typeof preview.diff!=='string'||typeof preview.target_path!=='string')
    throw Error('Invalid user-authored candidate');
  const target=safeSource(consumerRoot,preview.target_path);
  const before=textFile(target);
  if(sha(before)!==preview.preconditions?.source_sha256)
    throw Error('Edited source changed since the candidate was prepared');
  if(sha(preview.content)!==preview.candidate_sha256||
     candidateDiff(before,preview.content,preview.target_path)!==preview.diff)
    throw Error('Candidate contents differ from reviewed diff');
  return {proposal_id:preview.proposal_id,repo:preview.target_repo,path:preview.target_path,
    before,after:preview.content,group_ids:preview.group_ids??[preview.proposal_id],
    before_sha256:sha(before),
    after_sha256:sha(preview.content),diff:preview.diff};
}
