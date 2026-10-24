/**
 * Exact, human-prepared lifecycle plans for whole Agent Skill directories.
 * Scope V1: same-repository CREATE, MOVE, REMOVE; no inferred destination,
 * no cross-repository moves, no automatic Apply.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {buildReviewCatalog} from './review-selection.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const SHA=/^[0-9a-f]{64}$/;
const MAX_FILES=256,MAX_BYTES=8*1024*1024;
const manifestName='lifecycle-candidates.json';
const fileName='repair-proposals.json';
function canonical(root){const real=fs.realpathSync(root);if(!fs.statSync(real).isDirectory())throw Error('Not a directory');return real;}
export function skillLocation(root,relative,{existing}={}){
  if(typeof relative!=='string'||relative.length>1024||!relative.endsWith('/SKILL.md')||
    relative.includes('\\')||relative.includes('\0')||relative.startsWith('/')||
    /^(?:[A-Za-z]:|~)/.test(relative)||
    relative.split('/').some(p=>!p||p==='.'||p==='..'))
    throw Error('Unsafe skill path (explicit path to SKILL.md required)');
  if(relative.split('/').some(p=>['.git','node_modules','.wizard'].includes(p)))
    throw Error('Skill path enters a reserved repository directory');
  const dir=path.posix.dirname(relative),name=path.posix.basename(dir);
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    throw Error('Skill directory must have a portable name');
  const base=canonical(root);
  let cursor=base;
  const segments=dir.split('/');
  for(let i=0;i<segments.length;i++){
    cursor=path.join(cursor,segments[i]);
    const st=fs.lstatSync(cursor,{throwIfNoEntry:false});
    if(!st){
      if(existing||i!==segments.length-1)
        throw Error('Skill parent does not exist: '+relative);
      return {root:base,directory:cursor,main:path.join(cursor,'SKILL.md'),relative:dir,exists:false};
    }
    if(st.isSymbolicLink()||!st.isDirectory())throw Error('Symlink or non-directory in skill path: '+relative);
  }
  if(existing===false)throw Error('Destination skill directory already exists: '+relative);
  const main=path.join(cursor,'SKILL.md');
  const m=fs.lstatSync(main,{throwIfNoEntry:false});
  if(existing && (!m||!m.isFile()||m.isSymbolicLink()))
    throw Error('Skill source has no regular SKILL.md: '+relative);
  return {root:base,directory:cursor,main,relative:dir,exists:true};
}
/**
 * An explicitly chosen, already existing local destination folder.
 * The skill basename is appended; no existing destination is overwritten.
 * Refuse symlinked path components rather than silently following them.
 */
export function chosenMoveDestination(sourceDirectory,destinationDir){
  if(typeof destinationDir!=='string'||!path.isAbsolute(destinationDir)||
     destinationDir.includes(String.fromCharCode(0)))
    throw Error('MOVE destination must be an absolute existing directory');
  const absolute=path.resolve(destinationDir);
  const root=path.parse(absolute).root;
  let cursor=root;
  for(const part of absolute.slice(root.length).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,part);
    const entry=fs.lstatSync(cursor,{throwIfNoEntry:false});
    if(!entry||entry.isSymbolicLink()||!entry.isDirectory())
      throw Error('MOVE destination has missing, symlinked or non-directory parent');
  }
  const parent=fs.realpathSync(absolute);
  const source=fs.realpathSync(sourceDirectory);
  if(parent===source||parent.startsWith(source+path.sep))
    throw Error('MOVE cannot place a skill inside its own source folder');
  const target=path.join(parent,path.basename(source));
  if(fs.lstatSync(target,{throwIfNoEntry:false}))
    throw Error('MOVE destination already exists: '+target);
  return {parent,target};
}

export function packageSnapshot(location){
  if(!location.exists)throw Error('Missing skill package');
  const files=[];let bytes=0;
  const visit=(dir,rel='',depth=0)=>{
    if(depth>12)throw Error('Skill folder nested too deeply');
    for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(entry.isSymbolicLink())throw Error('Symlink inside skill package: '+entry.name);
      const filename=path.join(dir,entry.name),relative=rel?rel+'/'+entry.name:entry.name;
      if(entry.isDirectory())visit(filename,relative,depth+1);
      else if(entry.isFile()){
        const stat=fs.lstatSync(filename);
        if(files.length>=MAX_FILES||stat.size>MAX_BYTES||bytes+stat.size>MAX_BYTES)
          throw Error('Skill package exceeds inspection limits');
        const content=fs.readFileSync(filename);
        bytes+=content.length;
        files.push({path:relative,sha256:hash(content),size:content.length});
      }else throw Error('Unsupported item inside skill package');
    }
  };
  visit(location.directory);
  if(!files.some(x=>x.path==='SKILL.md'))throw Error('Skill main missing');
  return files;
}
export function matchingPackage(location,manifest){
  return JSON.stringify(packageSnapshot(location))===JSON.stringify(manifest);
}
function outputFolder(folder,root){
  const audit=canonical(folder),source=canonical(root);
  if(audit===source||audit.startsWith(source+path.sep))
    throw Error('Audit directory must be outside source repository');
  return audit;
}
const proposalHash=data=>hash(JSON.stringify(data));
function loadProposals(folder){return JSON.parse(fs.readFileSync(path.join(folder,fileName),'utf8'));}
function nativePreviews(folder){
  const file=path.join(folder,'repair-previews.json');
  return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
}
export function readLifecycleCandidates(folder,proposals){
  const file=path.join(folder,manifestName);
  const st=fs.lstatSync(file,{throwIfNoEntry:false});
  if(!st)return {schema_version:1,proposals_sha256:proposalHash(proposals),candidates:[]};
  if(!st.isFile()||st.size>10_000_000)throw Error('Unsafe lifecycle manifest');
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  if(data.schema_version!==1||data.proposals_sha256!==proposalHash(proposals)||
    !Array.isArray(data.candidates)||data.candidates.length>100)
    throw Error('Lifecycle manifest does not match audit');
  const ids=new Set();
  for(const c of data.candidates){
    if(typeof c?.proposal_id!=='string'||ids.has(c.proposal_id)||
       !['CREATE','MOVE','REMOVE'].includes(c.action)||
       typeof c.repo!=='string'||typeof c.path!=='string'||
       (c.action==='CREATE'?
         typeof c.content!=='string'||!c.content.trim()||
         Buffer.byteLength(c.content,'utf8')>2_000_000||hash(c.content)!==c.after_sha256:
         !Array.isArray(c.package_files)||!c.package_files.length||
         c.package_files.length>MAX_FILES||
         c.package_files.some(f=>typeof f.path!=='string'||!SHA.test(f.sha256??'')))||
       (c.action==='MOVE'&&(typeof c.dest_path!=='string'||
         (c.destination_dir!==undefined&&
          (!path.isAbsolute(c.destination_dir)||!path.isAbsolute(c.destination_absolute??''))))))
      throw Error('Malformed lifecycle candidate');
    ids.add(c.proposal_id);
  }
  return data;
}
function persist(folder,data){
  const dest=path.join(folder,manifestName);
  const stat=fs.lstatSync(dest,{throwIfNoEntry:false});
  if(stat&&!stat.isFile())throw Error('Refusing symlinked lifecycle manifest');
  const temp=path.join(folder,'.wizard-lifecycle-'+randomBytes(12).toString('hex')+'.tmp');
  try{
    fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
    fs.renameSync(temp,dest);
  }finally{fs.rmSync(temp,{force:true});}
}
export function stageLifecycle(auditFolder,{consumerRoot,proposalId,content=null,destinationDir=null}={}){
  if(!proposalId||!consumerRoot)throw Error('Proposal ID and consumer root required');
  const folder=outputFolder(auditFolder,consumerRoot);
  const proposals=loadProposals(folder),catalog=buildReviewCatalog(proposals,{previews:nativePreviews(folder)});
  const item=catalog.items.find(i=>i.id===proposalId);
  if(!item||!['CREATE','MOVE','REMOVE'].includes(item.action))
    throw Error('Only explicit CREATE, MOVE, REMOVE proposals may be staged');
  if(item.action!=='REMOVE'&&item.action!=='MOVE'&&
     item.target?.repo!==catalog.source_repositories.consumer||
     item.source?.repo!==catalog.source_repositories.consumer&&item.action!=='CREATE'||
     item.action==='MOVE'&&!destinationDir&&
       item.target?.repo!==catalog.source_repositories.consumer)
    throw Error('Cross-repository lifecycle Apply requires an explicit local destination');
  if(destinationDir!==null&&item.action!=='MOVE')
    throw Error('An explicit destination directory is only valid for MOVE');
  if(item.action==='REMOVE'&&(!item.source||item.target&&
    (item.target.path!==item.source.path||item.target.repo!==item.source.repo)))
    throw Error('REMOVE must reference one exact source skill');
  const entry={proposal_id:proposalId,action:item.action,
    repo:catalog.source_repositories.consumer,path:(item.source??item.target).path};
  if(item.action==='CREATE'){
    const dst=skillLocation(consumerRoot,item.target.path,{existing:false});
    if(typeof content!=='string'||!content.trim()||Buffer.byteLength(content,'utf8')>2_000_000)
      throw Error('CREATE requires a nonempty complete SKILL.md file (max 2 MB)');
    entry.path=item.target.path;entry.content=content;entry.after_sha256=hash(content);
    entry.diff=actionDiff(entry);
  }else{
    const src=skillLocation(consumerRoot,item.source.path,{existing:true});
    entry.package_files=packageSnapshot(src);
    if(item.action==='MOVE'){
      if(!item.target?.path||!item.target?.repo)
        throw Error('MOVE requires a target identity in its reviewed proposal');
      entry.dest_path=item.target.path;
      if(destinationDir!==null){
        const chosen=chosenMoveDestination(src.directory,destinationDir);
        const report=fs.realpathSync(folder);
        if(chosen.parent===report||chosen.parent.startsWith(report+path.sep)||
           report.startsWith(chosen.target+path.sep))
          throw Error('MOVE destination overlaps the audit output directory');
        entry.destination_dir=chosen.parent;
        entry.destination_absolute=chosen.target;
      }else{
        const dst=skillLocation(consumerRoot,item.target.path,{existing:false});
        if(dst.directory===src.directory||dst.directory.startsWith(src.directory+path.sep)||
           src.directory.startsWith(dst.directory+path.sep))
          throw Error('MOVE cannot overlap its source directory');
      }
    }
    entry.diff=actionDiff(entry);
  }
  const existing=readLifecycleCandidates(folder,proposals);
  const index=existing.candidates.findIndex(x=>x.proposal_id===proposalId);
  if(index<0)existing.candidates.push(entry);else existing.candidates[index]=entry;
  persist(folder,existing);
  return {status:'STAGED',proposal_id:proposalId,action:item.action,
    file_count:entry.package_files?.length??1,write_authorized:false};
}
function actionDiff(c){
  if(c.action==='CREATE')return '--- /dev/null\n+++ b/'+c.path+'\n'+
    c.content.split('\n').map(x=>'+'+x).join('\n')+'\n';
  return c.action+' PACKAGE '+c.path+
    (c.destination_absolute?' → '+c.destination_absolute:
      c.dest_path?' → '+c.dest_path:' → /dev/null')+'\n'+
    c.package_files.map(f=>'  '+f.path+' sha256 '+f.sha256).join('\n');
}
export function lifecyclePreviews(folder,proposals){
  const data=readLifecycleCandidates(folder,proposals);
  const catalog=buildReviewCatalog(proposals);
  return data.candidates.map(c=>{
    const item=catalog.items.find(i=>i.id===c.proposal_id);
    if(!item||item.action!==c.action ||
       (item.source?.path??null)!==(c.action==='CREATE'?null:c.path)||
       (item.target?.path??null)!==(c.action==='REMOVE'?item.target?.path??null:
         c.action==='CREATE'?c.path:c.dest_path)||
       (item.source?.repo??item.target?.repo)!==c.repo||
       (c.action==='MOVE'&&c.destination_dir!==undefined&&
         (typeof c.destination_absolute!=='string'||
          path.join(c.destination_dir,path.basename(path.posix.dirname(c.path)))!==
            c.destination_absolute)))
      throw Error('Lifecycle candidate target differs from reviewed proposal');
    return {proposal_id:c.proposal_id,status:'PREVIEW_READY',
      lifecycle_candidate:true,action:c.action,target_repo:c.repo,
      target_path:c.action==='REMOVE'?c.path:c.action==='CREATE'?c.path:c.dest_path,
      source_path:c.action==='CREATE'?null:c.path,
      content:c.content,package_files:c.package_files,
      destination_dir:c.destination_dir,destination_absolute:c.destination_absolute,
      after_sha256:c.after_sha256,diff:actionDiff(c)};
  });
}
export function reconstructLifecycle(preview,root){
  if(!preview?.lifecycle_candidate||!['CREATE','MOVE','REMOVE'].includes(preview.action))
    throw Error('Invalid lifecycle preview');
  const action=preview.action;
  if(action==='CREATE'){
    skillLocation(root,preview.target_path,{existing:false});
    if(typeof preview.content!=='string'||!preview.content.trim()||
       hash(preview.content)!==preview.after_sha256)
      throw Error('CREATE draft content is not intact');
    return {operation:'CREATE',proposal_id:preview.proposal_id,repo:preview.target_repo,
      path:preview.target_path,after:preview.content,
      after_sha256:preview.after_sha256,diff:preview.diff};
  }
  const src=skillLocation(root,preview.source_path,{existing:true});
  if(!matchingPackage(src,preview.package_files))
    throw Error('Skill package changed since review; run a new audit');
  if(action==='MOVE'){
    if(preview.destination_dir!==undefined){
      const chosen=chosenMoveDestination(src.directory,preview.destination_dir);
      if(chosen.target!==preview.destination_absolute)
        throw Error('MOVE destination changed since review');
    }else skillLocation(root,preview.target_path,{existing:false});
  }
  return {operation:action,proposal_id:preview.proposal_id,repo:preview.target_repo,
    path:preview.source_path,dest_path:action==='MOVE'?preview.target_path:null,
    destination_dir:action==='MOVE'?preview.destination_dir:undefined,
    destination_absolute:action==='MOVE'?preview.destination_absolute:undefined,
    package_files:preview.package_files,diff:preview.diff};
}


/** Opens a CREATE draft in a temporary editor, outside the source tree. */
export function editCreateSkill(auditFolder,{consumerRoot,proposalId,
  editor=process.env.VISUAL||process.env.EDITOR||'vi'}={}){
  const folder=outputFolder(auditFolder,consumerRoot);
  const proposals=loadProposals(folder);
  const catalog=buildReviewCatalog(proposals);
  const item=catalog.items.find(i=>i.id===proposalId);
  if(!item||item.action!=='CREATE'||item.target?.repo!==catalog.source_repositories.consumer)
    throw Error('Editor CREATE requires one explicit consumer-owned destination');
  skillLocation(consumerRoot,item.target.path,{existing:false});
  const command=String(editor??'').trim().split(/\s+/);
  if(!command[0]||command.some(c=>/[;&|<>$]/.test(c)))
    throw Error('Unsafe editor command');
  const current=readLifecycleCandidates(folder,proposals).candidates.find(c=>c.proposal_id===proposalId);
  const temp=fs.mkdtempSync(path.join(folder,'.wizard-create-'));
  fs.chmodSync(temp,0o700);
  const filename=path.join(temp,'SKILL.md');
  try{
    fs.writeFileSync(filename,current?.content??'',{flag:'wx',mode:0o600});
    const result=spawnSync(command[0],[...command.slice(1),filename],
      {stdio:'inherit',shell:false});
    if(result.error)throw result.error;
    if(result.status!==0)throw Error('Editor failed with code '+result.status);
    const stat=fs.lstatSync(filename);
    if(!stat.isFile()||stat.size>2_000_000)throw Error('Unsafe edited skill');
    return stageLifecycle(auditFolder,{consumerRoot,proposalId,
      content:fs.readFileSync(filename,'utf8')});
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
