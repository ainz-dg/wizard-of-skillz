import path from 'node:path';
import fs from 'node:fs';
import { walk, readText, rel } from './fs-utils.mjs';

function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return {};
  const body = text.slice(4, end);
  const obj = {};
  for (const line of body.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    obj[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return obj;
}

export function inventorySkills(root,{safeRoot=false}={}) {
  const base=safeRoot?fs.realpathSync(root):null;
  const files = walk(root).filter(f => {
    if(path.basename(f)!=='SKILL.md')return false;
    if(!safeRoot)return true;
    // Do not follow skill-file symlinks (including links outside the checkout).
    if(!fs.lstatSync(f).isFile())return false;
    const real=fs.realpathSync(f);
    return real.startsWith(base+path.sep);
  });
  return files.map(file => {
    const text = readText(file);
    const fm = parseFrontmatter(text);
    return {
      id: fm.name || path.basename(path.dirname(file)),
      description: fm.description || null,
      path: rel(root, file),
      text
    };
  });
}


/**
 * Read-only and narrow: validate explicit relative Markdown references.
 * This does not validate reference document truth or all Markdown syntax.
 */
export function auditSkillReferenceLinks(root,skills=inventorySkills(root)){
  const base=fs.realpathSync(root),links=[];
  for(const skill of skills){
    const skillDir=fs.realpathSync(path.dirname(path.resolve(base,skill.path)));
    let fence=null;
    const seen=new Set();
    for(const line of skill.text.split(/\r?\n/)){
      const trimmed=line.trimStart();
      const marker=trimmed.startsWith('\x60\x60\x60')?'\x60\x60\x60':
        trimmed.startsWith('~~~')?'~~~':null;
      if(marker){
        if(!fence)fence=marker;
        else if(fence===marker)fence=null;
        continue;
      }
      if(fence)continue;
      for(const match of line.matchAll(/\]\((references\/[^)\s]+)\)/g)){
        const target=match[1];
        if(seen.has(target))continue;
        seen.add(target);
        // Only check the referenced file, not an optional fragment anchor.
        // Encoded paths are unsupported, rather than decoded inconsistently.
        const file=target.split(/[?#]/,1)[0];
        const parts=file.split('/');
        let status;
        if((skillDir!==base && !skillDir.startsWith(base+path.sep)) ||
          file.includes('\\') || file.includes('%') ||
          parts.some(p=>!p||p==='.'||p==='..')){
          status='UNSAFE';
        }else{
          try{
            const actual=fs.realpathSync(path.join(skillDir,file));
            if(!actual.startsWith(skillDir+path.sep))status='UNSAFE';
            else status=fs.statSync(actual).isFile()?'VALID':'NOT_A_FILE';
          }catch{status='MISSING';}
        }
        links.push({skill:skill.path,target,status});
      }
    }
  }
  const count=status=>links.filter(l=>l.status===status).length;
  return {schema_version:1,basis:'EXPLICIT_REFERENCE_MARKDOWN_LINKS_ONLY',
    links,summary:{checked:links.length,valid:count('VALID'),missing:count('MISSING'),
      unsafe:count('UNSAFE'),not_a_file:count('NOT_A_FILE')},
    note:'Does not parse all Markdown forms, validate anchor fragments or prove technical accuracy.'};
}
