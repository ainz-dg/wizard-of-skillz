/**
 * User-authorized local patch application. Technical verification protects the
 * chosen contents and destination; it does not overrule the human's decision.
 * No implicit apply, no semantic correctness or eval claims.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {planHumanSelection} from './review-selection.mjs';
import {commitApprovedBatch} from './apply-batch.mjs';
import {reconstructUserUpdate} from './review-candidates.mjs';
import {reconstructLifecycle} from './skill-lifecycle.mjs';
import {commitMixedBatch} from './apply-lifecycle.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
function rejectUnsupportedPreview(id){
  throw Error('No manually staged candidate for '+id+
    '; generic Wizard does not automatically apply unverified repairs');
}

function localTarget(root,relative){
  if(!root||typeof relative!=='string'||!relative||relative.length>1024||
    relative.includes('\\')||relative.includes('\0')||relative.startsWith('/')||
    relative.split('/').some(x=>!x||x==='.'||x==='..'))
    throw Error('Unsafe apply target path');
  const base=fs.realpathSync(root);
  let current=base;
  const segments=relative.split('/');
  for(let i=0;i<segments.length;i++){
    current=path.join(current,segments[i]);
    const entry=fs.lstatSync(current);
    if(entry.isSymbolicLink())throw Error('Apply refused: symlink in destination');
    if(i<segments.length-1&&!entry.isDirectory())
      throw Error('Apply refused: destination parent is not a directory');
    if(i===segments.length-1&&!entry.isFile())
      throw Error('Apply refused: destination is not a regular file');
  }
  if(!current.startsWith(base+path.sep))
    throw Error('Apply target escapes inspected root');
  return current;
}

export function prepareReviewedApply(catalog,selectedIds,previews,{consumerRoot,providerRoot}={}){
  if(!previews||!consumerRoot)
    throw Error('Apply requires concrete previews and explicit consumer root');
  if(catalog.source_repositories.consumer!==previews.consumer_repo||
    (catalog.source_repositories.provider??null)!==(previews.provider_repo??null))
    throw Error('Preview repository IDs do not match the reviewed catalog');
  const plan=planHumanSelection(catalog,selectedIds?.length?
    {mode:'SUBSET',ids:selectedIds}:{mode:'NONE'});
  if(!plan.selected_count)throw Error('Select at least one proposal before Apply');
  if(plan.blockers.length)throw Error('Selected proposals require preparation: '+
    plan.blockers.map(x=>x.type+':'+x.id).join(', '));
  const candidates=[],byPath=new Map();
  for(const id of plan.selected_ids){
    const item=catalog.items.find(x=>x.id===id);
    if(item?.readiness!=='PREVIEW_READY')
      throw Error('No concrete patch for '+id);
    const preview=previews.previews?.find(p=>p.proposal_id===id);
    const candidate=preview?.lifecycle_candidate===true?
      reconstructLifecycle(preview,consumerRoot):
      preview?.user_candidate===true?
        reconstructUserUpdate(preview,consumerRoot):
        rejectUnsupportedPreview(id);
    if(preview?.lifecycle_candidate){
      if(item.action!==candidate.operation||
         item.source?.repo!==((item.action==='CREATE')?undefined:candidate.repo)||
         (item.action!=='REMOVE'&&
           !(item.action==='MOVE'&&candidate.destination_dir!==undefined)&&
           item.target?.repo!==candidate.repo)||
         (item.action!=='CREATE'&&item.source?.path!==candidate.path)||
         (item.action==='CREATE'&&item.target?.path!==candidate.path)||
         (item.action==='MOVE'&&item.target?.path!==candidate.dest_path))
        throw Error('Lifecycle candidate differs from reviewed proposal');
    }else{
      if(item?.action!=='UPDATE'||item.target?.repo!==candidate.repo||
         item.target?.path!==candidate.path)
        throw Error('Candidate target differs from reviewed proposal');
      const target=localTarget(consumerRoot,candidate.path);
      if(sha(fs.readFileSync(target,'utf8'))!==candidate.before_sha256)
        throw Error('Apply source changed during preparation');
    }
    const groupIds=[...(candidate.group_ids??[id])].sort();
    if(!groupIds.every(member=>plan.selected_ids.includes(member)))
      throw Error('Consolidated patch requires every linked proposal to be selected');
    const key=candidate.repo+'\0'+candidate.path;
    const existing=byPath.get(key);
    if(existing){
      if(existing.before_sha256!==candidate.before_sha256 ||
         existing.after_sha256!==candidate.after_sha256 ||
         JSON.stringify(existing.covered_proposal_ids)!==JSON.stringify(groupIds))
        throw Error('Same-file proposals require one identical consolidated candidate');
      continue;
    }
    const entry={...candidate,covered_proposal_ids:groupIds};
    byPath.set(key,entry);
    candidates.push(entry);
  }
  return {catalog_sha256:catalog.catalog_sha256,selected_ids:[...plan.selected_ids],
    candidates,write_authorized:false,applied_count:0,needs_final_confirmation:true};
}

/**
 * Only call after a separate, direct human confirmation of the displayed plan.
 * Recompute and recheck the entire selection before performing any write.
 */
export function commitReviewedApply(prepared,{catalog,previews,consumerRoot,providerRoot,
  auditFolder,confirmation}={}){
  if(confirmation!=='APPLY')throw Error('Final explicit APPLY confirmation required');
  if(!prepared || prepared.catalog_sha256!==catalog?.catalog_sha256 ||
    prepared.write_authorized!==false || prepared.applied_count!==0 ||
    prepared.needs_final_confirmation!==true ||
    !Array.isArray(prepared.selected_ids)||!Array.isArray(prepared.candidates))
    throw Error('Invalid reviewed apply plan');
  // Rebuild all selected patches and re-verify snapshot/evidence and destinations
  // before passing ANY candidate to the write engine. Never partially skip IDs.
  const current=prepareReviewedApply(catalog,prepared.selected_ids,previews,
    {consumerRoot,providerRoot});
  if(JSON.stringify(current)!==JSON.stringify(prepared))
    throw Error('Apply plan changed since final preview; review again');
  const covered=current.candidates.flatMap(c=>c.covered_proposal_ids);
  if(covered.length!==current.selected_ids.length ||
     new Set(covered).size!==covered.length ||
     covered.some(id=>!current.selected_ids.includes(id)))
    throw Error('Apply batch must cover each selected proposal exactly once');
  const commit=current.candidates.some(c=>c.operation)?commitMixedBatch:commitApprovedBatch;
  return commit(current.candidates,{
    consumerRoot,providerRoot,auditFolder,confirmation
  });
}
