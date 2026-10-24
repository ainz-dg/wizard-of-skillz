/**
 * Commit a fully reviewed batch with one human confirmation.
 *
 * Node filesystems do not offer a multi-file atomic rename. Therefore:
 * preflight every file, stage every replacement, retain all originals,
 * then replace targets; on failure restore completed files when their bytes
 * still match the candidate. Never conceal a partial rollback.
 *
 * Caller is responsible for preparing/verifying each candidate against the
 * reviewed catalog. This layer validates exact contents/paths and writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';

const sha=value=>createHash('sha256').update(value).digest('hex');
const HASH=/^[0-9a-f]{64}$/;

function safeTarget(root,relative){
  if(!root||typeof relative!=='string'||relative.length>1024||!relative||
    relative.includes('\\')||relative.includes('\0')||relative.startsWith('/')||
    /^(?:[A-Za-z]:|~)/.test(relative)||
    relative.split('/').some(part=>!part||part==='.'||part==='..'))
    throw Error('Unsafe apply destination path');
  const base=fs.realpathSync(root);
  let absolute=base;
  const segments=relative.split('/');
  for(const [i,part] of segments.entries()){
    absolute=path.join(absolute,part);
    const stat=fs.lstatSync(absolute);
    if(stat.isSymbolicLink())throw Error('Apply refused: symlink in destination '+relative);
    if(i===segments.length-1){
      if(!stat.isFile())throw Error('Apply target is not a regular file '+relative);
    }else if(!stat.isDirectory())throw Error('Apply parent is not a directory '+relative);
  }
  if(!absolute.startsWith(base+path.sep))throw Error('Destination escapes repository');
  return absolute;
}
function safeOutputDirectory(auditFolder,roots){
  const folder=fs.realpathSync(auditFolder);
  if(!fs.statSync(folder).isDirectory())throw Error('Expected audit output directory');
  for(const root of roots.filter(Boolean)){
    const base=fs.realpathSync(root);
    if(folder===base||folder.startsWith(base+path.sep))
      throw Error('Apply audit/backup directory must be outside inspected repositories');
  }
  return folder;
}
function exclusiveTemporary(dir,prefix){
  return path.join(dir,'.wizard-'+prefix+'-'+randomBytes(12).toString('hex')+'.tmp');
}
function writeReceipt(folder,report){
  const name=path.join(folder,'apply-result-'+randomBytes(12).toString('hex')+'.json');
  try{
    fs.writeFileSync(name,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    return {receipt:name,receipt_warning:null};
  }catch(error){
    return {receipt:null,receipt_warning:'Failed to persist apply receipt: '+error.message};
  }
}

/**
 * This is the write-only engine for verified, exact-content UPDATE candidates.
 * The public TUI provides a distinct final confirmation before calling it.
 * An injection seam for rename is used only by failure simulation tests.
 */
export function commitApprovedBatch(candidates,{
  consumerRoot,providerRoot,auditFolder,confirmation,rename=fs.renameSync
}={}){
  if(confirmation!=='APPLY')throw Error('Final explicit APPLY confirmation required');
  if(!Array.isArray(candidates)||!candidates.length)
    throw Error('Refusing an empty Apply batch');
  const folder=safeOutputDirectory(auditFolder,[consumerRoot,providerRoot]);
  const selectedIds=new Set(),paths=new Set();
  const entries=candidates.map(candidate=>{
    if(!candidate||typeof candidate.proposal_id!=='string'||!candidate.proposal_id||
      typeof candidate.repo!=='string'||typeof candidate.path!=='string'||
      typeof candidate.before!=='string'||typeof candidate.after!=='string'||
      !HASH.test(candidate.before_sha256??'')||
      !HASH.test(candidate.after_sha256??'')||
      candidate.repo==='')
      throw Error('Malformed prepared candidate');
    const covered=candidate.covered_proposal_ids??[candidate.proposal_id];
    if(!Array.isArray(covered)||!covered.length||
      !covered.includes(candidate.proposal_id)||
      covered.some(id=>typeof id!=='string'||!id||selectedIds.has(id))||
      new Set(covered).size!==covered.length||paths.has(candidate.path))
      throw Error('Apply batch has duplicate proposal or destination');
    for(const id of covered)selectedIds.add(id);
    paths.add(candidate.path);
    if(candidate.before===candidate.after||
      sha(candidate.before)!==candidate.before_sha256||
      sha(candidate.after)!==candidate.after_sha256)
      throw Error('Apply candidate contents do not match their exact hashes');
    const target=safeTarget(consumerRoot,candidate.path);
    const stat=fs.statSync(target);
    if(stat.size>2_000_000||sha(fs.readFileSync(target,'utf8'))!==candidate.before_sha256)
      throw Error('Apply aborted before writing: changed source '+candidate.path);
    return {...candidate,target,mode:stat.mode&0o777,temp:null};
  });
  // Snapshot/stage every destination before mutating ANY source file.
  const backupRoot=fs.mkdtempSync(path.join(folder,'apply-backup-'));
  fs.chmodSync(backupRoot,0o700);
  const completed=[];
  let outcome=null;
  try{
    for(const [index,entry] of entries.entries()){
      fs.writeFileSync(path.join(backupRoot,index+'.before'),entry.before,
        {flag:'wx',mode:0o600});
      entry.temp=exclusiveTemporary(path.dirname(entry.target),'approved');
      fs.writeFileSync(entry.temp,entry.after,{flag:'wx',mode:entry.mode});
      if(sha(fs.readFileSync(entry.temp,'utf8'))!==entry.after_sha256)
        throw Error('Staged patch digest mismatch: '+entry.path);
    }
    for(const entry of entries){
      if(safeTarget(consumerRoot,entry.path)!==entry.target ||
        sha(fs.readFileSync(entry.target,'utf8'))!==entry.before_sha256)
        throw Error('Source changed immediately before replacement: '+entry.path);
      rename(entry.temp,entry.target);
      entry.temp=null;
      completed.push(entry);
      if(sha(fs.readFileSync(entry.target,'utf8'))!==entry.after_sha256)
        throw Error('Post-write digest mismatch: '+entry.path);
    }
    const report={
      schema_version:1,mode:'USER_CONFIRMED_BATCH_APPLY',status:'APPLIED',
      selected_ids:[...selectedIds],selected_count:selectedIds.size,
      file_count:entries.length,
      applied_count:completed.length,backup_directory:backupRoot,
      files:entries.map(entry=>({
        proposal_id:entry.proposal_id,
        covered_proposal_ids:entry.covered_proposal_ids??[entry.proposal_id],
        repo:entry.repo,path:entry.path,status:'APPLIED',
        before_sha256:entry.before_sha256,after_sha256:entry.after_sha256
      })),
      semantic_verification:false,eval_run:false,
      note:'All selected exact-content patches written and hash-checked; semantic correctness not asserted.'
    };
    outcome={...report,...writeReceipt(folder,report)};
  }catch(error){
    const restored=[],unresolved=[];
    for(const entry of [...completed].reverse()){
      try{
        if(safeTarget(consumerRoot,entry.path)!==entry.target ||
          sha(fs.readFileSync(entry.target,'utf8'))!==entry.after_sha256)
          throw Error('File changed after Apply; avoiding destructive rollback');
        const temp=exclusiveTemporary(path.dirname(entry.target),'rollback');
        try{
          fs.writeFileSync(temp,entry.before,{flag:'wx',mode:entry.mode});
          if(sha(fs.readFileSync(temp,'utf8'))!==entry.before_sha256)
            throw Error('Rollback snapshot verification failed');
          rename(temp,entry.target);
          if(sha(fs.readFileSync(entry.target,'utf8'))!==entry.before_sha256)
            throw Error('Rollback post-write digest mismatch');
          restored.push(entry);
        }finally{try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
      }catch(rollbackError){
        unresolved.push({proposal_id:entry.proposal_id,path:entry.path,
          reason:rollbackError.message});
      }
    }
    const report={
      schema_version:1,mode:'USER_CONFIRMED_BATCH_APPLY',
      status:unresolved.length?'PARTIAL':'ROLLED_BACK',
      selected_ids:[...selectedIds],selected_count:selectedIds.size,
      file_count:entries.length,
      applied_count:unresolved.length?null:0,unresolved_count:unresolved.length,
      restored_count:restored.length,
      backup_directory:backupRoot,
      original_error:error.message,unresolved,
      files:entries.map(entry=>({
        proposal_id:entry.proposal_id,
        covered_proposal_ids:entry.covered_proposal_ids??[entry.proposal_id],
        repo:entry.repo,path:entry.path,
        status:unresolved.some(x=>x.proposal_id===entry.proposal_id)?
          'UNRESOLVED':restored.includes(entry)?'RESTORED':'NOT_APPLIED',
        before_sha256:entry.before_sha256,after_sha256:entry.after_sha256
      })),
      note:'Multiple file replacement is not filesystem-atomic. Original backups retained; inspect unresolved destinations if any.'
    };
    const receipt=writeReceipt(folder,report);
    const failure=Error('Batch Apply '+report.status+': '+error.message+
      '. Backups: '+backupRoot+
      (unresolved.length?'. Unresolved: '+unresolved.map(x=>x.path).join(', '):''));
    failure.report={...report,...receipt};
    throw failure;
  }finally{
    for(const entry of entries)if(entry.temp){
      try{fs.unlinkSync(entry.temp);}catch(error){if(error.code!=='ENOENT'){}}
    }
  }
  return outcome;
}
