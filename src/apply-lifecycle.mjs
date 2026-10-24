/**
 * User-confirmed mixed batch writer for SKILL.md UPDATEs and full-skill
 * CREATE/MOVE/REMOVE operations. No multi-file transaction exists in Node:
 * preflight + backups + staging + guarded best-effort reverse rollback.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {skillLocation,packageSnapshot,chosenMoveDestination} from './skill-lifecycle.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const DIGEST=/^[a-f0-9]{64}$/;
const unique=(parent,kind)=>path.join(parent,'.wizard-'+kind+'-'+randomBytes(12).toString('hex'));
function updateTarget(root,rel){
  if(typeof rel!=='string'||!rel||rel.includes('\\')||rel.includes('\0')||
     rel.startsWith('/')||/^(?:[A-Za-z]:|~)/.test(rel)||
     rel.split('/').some(x=>!x||x==='.'||x==='..'))
    throw Error('Unsafe UPDATE path');
  let current=fs.realpathSync(root);
  for(const [i,part] of rel.split('/').entries()){
    current=path.join(current,part);
    const st=fs.lstatSync(current,{throwIfNoEntry:false});
    if(!st||st.isSymbolicLink()||
       (i===rel.split('/').length-1?!st.isFile():!st.isDirectory()))
      throw Error('Missing or unsafe UPDATE file: '+rel);
  }
  return current;
}
function capture(op,root){
  if(op.operation==='UPDATE'){
    const target=updateTarget(root,op.path);
    const bytes=fs.readFileSync(target);
    if(bytes.length>2_000_000||sha(bytes)!==op.before_sha256)
      throw Error('Source changed before Apply: '+op.path);
    return {source:target,target,dir:path.dirname(target)};
  }
  if(op.operation==='CREATE'){
    const dst=skillLocation(root,op.path,{existing:false});
    if(typeof op.after!=='string'||!op.after.trim()||
       Buffer.byteLength(op.after,'utf8')>2_000_000||
       sha(op.after)!==op.after_sha256)throw Error('Invalid CREATE contents');
    return {target:dst.directory,dir:path.dirname(dst.directory)};
  }
  const src=skillLocation(root,op.path,{existing:true});
  if(JSON.stringify(packageSnapshot(src))!==JSON.stringify(op.package_files))
    throw Error('Source skill package changed: '+op.path);
  if(op.operation==='MOVE'){
    if(op.destination_dir!==undefined){
      const chosen=chosenMoveDestination(src.directory,op.destination_dir);
      if(op.destination_absolute!==chosen.target)
        throw Error('Explicit MOVE destination changed since approval');
      return {source:src.directory,target:chosen.target,dir:chosen.parent,externalMove:true};
    }
    const dst=skillLocation(root,op.dest_path,{existing:false});
    if(dst.directory===src.directory||
       dst.directory.startsWith(src.directory+path.sep)||
       src.directory.startsWith(dst.directory+path.sep))
      throw Error('MOVE source and destination overlap');
    return {source:src.directory,target:dst.directory,dir:path.dirname(dst.directory)};
  }
  if(op.operation==='REMOVE')return {source:src.directory,target:null,dir:path.dirname(src.directory)};
  throw Error('Unknown batch action');
}
function receipt(folder,report){
  const file=path.join(folder,'apply-result-'+randomBytes(12).toString('hex')+'.json');
  try{
    fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    return {receipt:file,receipt_warning:null};
  }catch(error){return {receipt:null,receipt_warning:error.message};}
}
function safeFolder(folder,roots){
  const dir=fs.realpathSync(folder);
  if(!fs.statSync(dir).isDirectory())throw Error('Missing audit directory');
  for(const root of roots.filter(Boolean)){
    const r=fs.realpathSync(root);
    if(dir===r||dir.startsWith(r+path.sep))
      throw Error('Backup must be outside inspected repositories');
  }
  return dir;
}
function fileStatus(op){return {proposal_id:op.proposal_id,
  covered_proposal_ids:op.covered_proposal_ids??[op.proposal_id],
  repo:op.repo,action:op.operation,
  path:op.path,destination:op.destination_absolute??op.dest_path??null};}
function matchesCreated(op,root){
  const dst=skillLocation(root,op.path,{existing:true});
  return JSON.stringify(packageSnapshot(dst))===
    JSON.stringify([{path:'SKILL.md',sha256:op.after_sha256,size:Buffer.byteLength(op.after)}]);
}
export function commitMixedBatch(candidates,{
  consumerRoot,providerRoot,auditFolder,confirmation,rename=fs.renameSync
}={}){
  if(confirmation!=='APPLY')throw Error('Final explicit APPLY confirmation required');
  if(!Array.isArray(candidates)||!candidates.length||!consumerRoot)
    throw Error('Missing reviewed batch or consumer root');
  const folder=safeFolder(auditFolder,[consumerRoot,providerRoot]);
  const selected=new Set(),used=[];
  const entries=candidates.map(raw=>{
    const action=raw?.operation??'UPDATE';
    if(!['UPDATE','CREATE','MOVE','REMOVE'].includes(action)||
       typeof raw.proposal_id!=='string'||!raw.proposal_id||
       typeof raw.repo!=='string'||!raw.repo||typeof raw.path!=='string')
      throw Error('Invalid prepared lifecycle entry');
    const covered=raw.covered_proposal_ids??[raw.proposal_id];
    if(!Array.isArray(covered)||!covered.includes(raw.proposal_id)||
       covered.some(id=>typeof id!=='string'||!id||selected.has(id)))
      throw Error('Duplicated approved proposal');
    for(const id of covered)selected.add(id);
    const entry={...raw,operation:action,covered_proposal_ids:covered};
    const state=capture(entry,consumerRoot);
    if(state.externalMove &&
       (state.target===folder||state.target.startsWith(folder+path.sep)||
        folder.startsWith(state.target+path.sep)||
        state.dir===folder||state.dir.startsWith(folder+path.sep)))
      throw Error('MOVE destination cannot overlap audit/backup area');
    const affected=action==='MOVE'?[state.source,state.target]:
      action==='CREATE'?[state.target]:action==='REMOVE'?[state.source]:[state.target];
    for(const loc of affected){
      if(used.some(u=>loc===u||loc.startsWith(u+path.sep)||u.startsWith(loc+path.sep)))
        throw Error('Colliding paths in approved lifecycle batch');
      used.push(loc);
    }
    return {...entry,...state,stage:null,quarantine:null,
      createdTarget:false,quarantined:false,done:false};
  });
  const backup=fs.mkdtempSync(path.join(folder,'apply-backup-'));
  fs.chmodSync(backup,0o700);
  const completed=[];
  try{
    for(const [i,op] of entries.entries()){
      if(op.operation==='UPDATE'){
        if(typeof op.before!=='string'||typeof op.after!=='string'||
           !DIGEST.test(op.after_sha256??'')||
           sha(op.before)!==op.before_sha256||sha(op.after)!==op.after_sha256)
          throw Error('Invalid exact UPDATE candidate');
        fs.writeFileSync(path.join(backup,i+'.before'),op.before,{flag:'wx',mode:0o600});
        op.stage=unique(op.dir,'approved')+'.tmp';
        fs.writeFileSync(op.stage,op.after,{flag:'wx',mode:fs.statSync(op.source).mode&0o777});
      }else if(op.operation==='CREATE'){
        op.stage=unique(op.dir,'approved');
        fs.mkdirSync(op.stage,{mode:0o700});
        fs.writeFileSync(path.join(op.stage,'SKILL.md'),op.after,{flag:'wx',mode:0o600});
      }else{
        fs.cpSync(op.source,path.join(backup,i+'.package'),{
          recursive:true,force:false,errorOnExist:true});
        // Snapshot integrity is asserted once more after copying.
        const copy={directory:path.join(backup,i+'.package'),exists:true};
        if(JSON.stringify(packageSnapshot(copy))!==JSON.stringify(op.package_files))
          throw Error('Backup does not match original skill package');
        if(op.operation==='MOVE'&&op.externalMove){
          // Copy in the destination filesystem first; final promotion is a
          // same-volume rename, so EXDEV between source and target is supported.
          op.stage=unique(op.dir,'moving');
          fs.cpSync(op.source,op.stage,{recursive:true,force:false,errorOnExist:true});
          if(JSON.stringify(packageSnapshot({directory:op.stage,exists:true}))!==
             JSON.stringify(op.package_files))
            throw Error('Staged MOVE copy does not match its manifest');
        }
      }
    }
    // No source mutation before every candidate has passed snapshot + staging.
    for(const op of entries){
      const current=capture(op,consumerRoot);
      if(current.source!==op.source||current.target!==op.target)
        throw Error('Destination changed during preflight');
    }
    for(const op of entries){
      capture(op,consumerRoot);
      if(op.operation==='REMOVE'){
        op.quarantine=unique(op.dir,'quarantine');
        rename(op.source,op.quarantine);
        op.quarantined=true;
        op.done=true;completed.push(op);
      }else if(op.operation==='MOVE'&&op.externalMove){
        // Always recheck destination just before promotion. Never intentionally
        // replace a preexisting directory.
        capture(op,consumerRoot);
        rename(op.stage,op.target);
        op.stage=null;
        op.createdTarget=true;
        completed.push(op); // even a later source-quarantine failure must roll back
        op.quarantine=unique(path.dirname(op.source),'quarantine');
        rename(op.source,op.quarantine);
        op.quarantined=true;
        op.done=true;
      }else{
        rename(op.operation==='MOVE'?op.source:op.stage,op.target);
        op.done=true;completed.push(op);
      }
      if(op.operation==='UPDATE'&&sha(fs.readFileSync(op.target))!==op.after_sha256)
        throw Error('UPDATE verification failed after replace');
      if(op.operation==='CREATE'&&!matchesCreated(op,consumerRoot))
        throw Error('CREATE verification failed after write');
      if(op.operation==='MOVE'&&
         JSON.stringify(packageSnapshot({directory:op.target,exists:true}))!==
         JSON.stringify(op.package_files))
        throw Error('MOVE verification failed after rename');
    }
  }catch(error){
    const restored=[],unresolved=[];
    for(const op of [...completed].reverse()){
      try{
        if(op.operation==='UPDATE'){
          if(sha(fs.readFileSync(updateTarget(consumerRoot,op.path)))!==op.after_sha256)
            throw Error('Externally changed UPDATE, refusing rollback');
          const temp=unique(op.dir,'rollback')+'.tmp';
          try{
            fs.writeFileSync(temp,op.before,{flag:'wx',mode:0o600});
            rename(temp,op.target);
          }finally{fs.rmSync(temp,{force:true});}
        }else if(op.operation==='CREATE'){
          if(!matchesCreated(op,consumerRoot))
            throw Error('Externally changed CREATE, refusing rollback');
          fs.rmSync(op.target,{recursive:true,force:false});
        }else if(op.operation==='MOVE'){
          if(op.externalMove){
            if(JSON.stringify(packageSnapshot({directory:op.target,exists:true}))!==
               JSON.stringify(op.package_files))
              throw Error('External MOVE target changed; refusing destructive rollback');
            if(op.quarantined){
              if(fs.lstatSync(op.source,{throwIfNoEntry:false})||
                 JSON.stringify(packageSnapshot({directory:op.quarantine,exists:true}))!==
                 JSON.stringify(op.package_files))
                throw Error('External MOVE quarantine changed; refusing rollback');
            }else{
              if(JSON.stringify(packageSnapshot({directory:op.source,exists:true}))!==
                 JSON.stringify(op.package_files))
                throw Error('External MOVE source changed; refusing rollback');
            }
            fs.rmSync(op.target,{recursive:true,force:false});
            if(op.quarantined)rename(op.quarantine,op.source);
          }else{
            if(fs.existsSync(op.source)||
               JSON.stringify(packageSnapshot({directory:op.target,exists:true}))!==
               JSON.stringify(op.package_files))
              throw Error('MOVE changed after execution; refusing rollback');
            rename(op.target,op.source);
          }
        }else{
          if(fs.existsSync(op.source)||
             JSON.stringify(packageSnapshot({directory:op.quarantine,exists:true}))!==
             JSON.stringify(op.package_files))
            throw Error('REMOVE quarantine changed; refusing rollback');
          rename(op.quarantine,op.source);
        }
        restored.push(op);
      }catch(e){unresolved.push({proposal_id:op.proposal_id,
        path:op.path,reason:e.message});}
    }
    const report={schema_version:1,mode:'USER_CONFIRMED_BATCH_APPLY',
      status:unresolved.length?'PARTIAL':'ROLLED_BACK',
      selected_ids:[...selected],selected_count:selected.size,file_count:entries.length,
      applied_count:unresolved.length?null:0,backup_directory:backup,
      original_error:error.message,unresolved,
      files:entries.map(op=>({...fileStatus(op),
        status:unresolved.some(e=>e.proposal_id===op.proposal_id)?'UNRESOLVED':
          restored.includes(op)?'RESTORED':'NOT_APPLIED'})),
      note:'Rollback is best effort, not a filesystem transaction. Backups retained.'};
    const outcome={...report,...receipt(folder,report)};
    const failure=Error('Batch Apply '+report.status+': '+error.message+
      '. Backups: '+backup);
    failure.report=outcome;throw failure;
  }finally{
    for(const op of entries)if(op.stage){
      try{fs.rmSync(op.stage,{recursive:true,force:true});}catch{}
    }
  }
  const cleanupErrors=[];
  for(const op of entries){
    if(!op.quarantined||!op.quarantine)continue;
    try{fs.rmSync(op.quarantine,{recursive:true,force:false});}
    catch(e){cleanupErrors.push({proposal_id:op.proposal_id,path:op.quarantine,reason:e.message});}
  }
  const report={schema_version:1,mode:'USER_CONFIRMED_BATCH_APPLY',
    status:cleanupErrors.length?'PARTIAL':'APPLIED',
    selected_ids:[...selected],selected_count:selected.size,file_count:entries.length,
    applied_count:completed.length,backup_directory:backup,
    unresolved:cleanupErrors,unresolved_count:cleanupErrors.length,
    files:entries.map(op=>({...fileStatus(op),
      status:cleanupErrors.some(e=>e.proposal_id===op.proposal_id)?'CLEANUP_PENDING':'APPLIED'})),
    semantic_verification:false,eval_run:false,
    note:'Exact reviewed operations executed; backups retained. No semantic verification.'};
  return {...report,...receipt(folder,report)};
}
