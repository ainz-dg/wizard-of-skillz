/**
 * Conservative, source-structure-only checks for explicit local paths quoted
 * in existing SKILL.md and referenced Markdown documents. No edits.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const within=(base,file)=>file===base||file.startsWith(base+path.sep);
const fileLike=value=>/^[^\s\\%?#*|<>$!]+$/.test(value) &&
  !value.includes('...') && !/[{}]/.test(value) &&
  !value.endsWith('/') && /(?:^|\/)[^/]+\.[a-zA-Z0-9]+$/.test(value);
const clean=value=>value.split(/[?#]/,1)[0];

function referencesUnder(skillDir){
  const folder=path.join(skillDir,'references');
  const found=[];
  const visit=(dir,depth)=>{
    if(depth>12)return;
    let entries;
    try{entries=fs.readdirSync(dir,{withFileTypes:true});}
    catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const entry of entries){
      if(entry.isSymbolicLink())continue;
      const file=path.join(dir,entry.name);
      if(entry.isDirectory())visit(file,depth+1);
      else if(entry.isFile()&&entry.name.endsWith('.md'))found.push(file);
    }
  };
  visit(folder,0);
  return found.sort();
}
function linesWithoutFences(text){
  let opening=null;
  return text.split(/\r?\n/).map((line,i)=>{
    const fence=/^\s*(\x60{3,}|~{3,})/.exec(line);
    if(fence){
      const marker=fence[1][0],length=fence[1].length;
      if(!opening)opening={marker,length};
      else if(marker===opening.marker&&length>=opening.length)opening=null;
      return null;
    }
    return opening?null:{line,line_number:i+1};
  }).filter(Boolean);
}
function mentions(line,fromReference){
  const found=[];
  // Only accept an entire inline code span when it is an unambiguous file path.
  for(const match of line.matchAll(/(?<!\x60)\x60([^\x60\n]+)\x60(?!\x60)/g)){
    const value=match[1];
    if(value.startsWith('src/')&&fileLike(value))found.push({value,rootRelative:true});
  }
  // The legacy checker owns SKILL.md references/ links; do not duplicate them.
  for(const match of line.matchAll(/\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)){
    const value=match[1],literal=clean(value);
    if(!fileLike(literal))continue;
    if(literal.startsWith('src/'))found.push({value,rootRelative:true});
    else if(fromReference&&(literal.startsWith('./')||literal.startsWith('../')||
      !literal.includes('://')&&!literal.startsWith('/')&&!literal.includes(':')))
      found.push({value,rootRelative:false});
  }
  return found;
}
function inspectPath(base,absolute){
  if(!within(base,absolute))return 'UNSAFE_PATH';
  let current=base;
  const parts=path.relative(base,absolute).split(path.sep);
  try{
    for(const [i,part] of parts.entries()){
      current=path.join(current,part);
      const stat=fs.lstatSync(current);
      if(stat.isSymbolicLink())return 'UNSAFE_SYMLINK';
      if(i===parts.length-1)return stat.isFile()?'PRESENT':'NOT_A_FILE';
      if(!stat.isDirectory())return 'NOT_A_FILE';
    }
    return 'NOT_A_FILE';
  }catch(error){
    if(error.code==='ENOENT')return 'MISSING_AT_SNAPSHOT';
    if(error.code==='EACCES'||error.code==='EPERM')return 'UNREADABLE';
    throw error;
  }
}
/**
 * A missing path may refer to a future file, not necessarily a stale skill.
 * All paths are resolved against a canonical, bounded repository root.
 */
export function auditLocalPathMentions(root,skills){
  const base=fs.realpathSync(root),result=[],read=new Map();
  for(const skill of skills){
    const skillFile=path.resolve(base,skill.path);
    if(!within(base,skillFile))continue;
    const skillDir=path.dirname(skillFile);
    for(const file of [skillFile,...referencesUnder(skillDir)]){
      if(!within(base,file))continue;
      let document=read.get(file);
      if(!document){
        const stat=fs.lstatSync(file);
        if(!stat.isFile()||stat.isSymbolicLink())continue;
        const bytes=fs.readFileSync(file);
        document={text:bytes.toString('utf8'),sha256:digest(bytes)};
        read.set(file,document);
      }
      const documentPath=path.relative(base,file).split(path.sep).join('/');
      const fromReference=file!==skillFile,seen=new Set();
      for(const {line,line_number} of linesWithoutFences(document.text)){
        for(const mention of mentions(line,fromReference)){
          const bare=clean(mention.value);
          const absolute=path.resolve(mention.rootRelative?base:path.dirname(file),bare);
          const resolved=within(base,absolute)?
            path.relative(base,absolute).split(path.sep).join('/'):null;
          const key=line_number+'\0'+resolved+'\0'+mention.value;
          if(seen.has(key))continue;
          seen.add(key);
          result.push({skill:skill.path,document:documentPath,line:line_number,
            mentioned_path:mention.value,resolved_path:resolved,
            status:inspectPath(base,absolute),document_sha256:document.sha256});
        }
      }
    }
  }
  const count=status=>result.filter(x=>x.status===status).length;
  return {schema_version:1,basis:'EXPLICIT_LOCAL_FILE_MENTIONS_ONLY',
    mentions:result,summary:{checked:result.length,present:count('PRESENT'),
      missing_at_snapshot:count('MISSING_AT_SNAPSHOT'),not_a_file:count('NOT_A_FILE'),
      unsafe_path:count('UNSAFE_PATH'),unsafe_symlink:count('UNSAFE_SYMLINK'),
      unreadable:count('UNREADABLE')},
    note:'File existence at scan time only. No semantic judgement, no inferred correction, no UPDATE proposal.'};
}
