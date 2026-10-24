/**
 * Narrow, read-only comparisons between explicit skill instructions and
 * locally checked code. No source inference is a patch or semantic proof.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {walk} from './fs-utils.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const safe=p=>typeof p==='string' && p.length<1024 && !p.includes('\\') &&
  !p.startsWith('/') && p.split('/').every(s=>s && s!=='.' && s!=='..');
const line=(s,i)=>s.slice(0,i).split('\n').length;
function read(root,rel){
  if(!safe(rel))return null;
  try {
    const base=fs.realpathSync(root),file=fs.realpathSync(path.join(base,rel));
    const stat=fs.statSync(file);
    return file.startsWith(base+path.sep) && stat.isFile() && stat.size<=1_000_000 ?
      fs.readFileSync(file,'utf8') : null;
  } catch {return null;}
}
function block(code,name){
  if(!/^\w+$/.test(name))return null;
  const declaration=new RegExp('\\b(?:export\\s+)?(?:type|interface)\\s+'+name+'\\b').exec(code);
  if(!declaration)return null;
  const start=code.indexOf('{',declaration.index+declaration[0].length);
  if(start<0||start>declaration.index+200)return null;
  let depth=0;
  for(let i=start;i<code.length && i<start+3000;i++){
    if(code[i]==='{')depth++;
    else if(code[i]==='}' && --depth===0)return code.slice(start,i+1);
  }
  return null;
}
function java(root,subdir){
  const dir=path.join(root,subdir);
  if(!fs.existsSync(dir))return [];
  return walk(dir).filter(f=>f.endsWith('.java')).slice(0,200).flatMap(f=>{
    const rel=path.relative(root,f).split(path.sep).join('/');
    const src=read(root,rel),match=src?.match(/^\s*package\s+([\w.]+)\s*;/m);
    return match?[{path:rel,pkg:match[1],line:line(src,match.index),text:src}]:[];
  });
}
export function inspectSourceConsistency(root,skills){
  if(!Array.isArray(skills)||!fs.statSync(root).isDirectory())throw Error('Expected root and skills');
  const observations=[],production=java(root,'src/main/java'),tests=java(root,'src/test/java');
  for(const skill of skills){
    if(!safe(skill?.path)||typeof skill.text!=='string')continue;
    const lines=skill.text.split('\n');
    let anchor=null;
    for(let i=0;i<lines.length;i++){
      const s=lines[i];
      const file=s.match(/^\s*(?:\*\*)?File:(?:\*\*)?\s*\x60(src\/[^\x60]+\.tsx?)\x60/i);
      if(file)anchor=file[1];
      const property=s.match(/\bAdd an entry to \x60(\w+)\x60 with at minimum \x60\{\s*(\w+)\s*:\s*(?:true|false)\s*\}\x60/i);
      if(property && anchor){
        const src=read(root,anchor);
        const declaration=src && new RegExp('\\b(?:export\\s+)?const\\s+'+property[1]+'\\s*:\\s*(\\w+)').exec(src);
        const body=declaration && block(src,declaration[1]);
        if(body && !new RegExp('\\b'+property[2]+'\\s*\\??\\s*:').test(body)){
          observations.push({kind:'TYPE_PROPERTY_MISMATCH',skill:skill.id,skill_path:skill.path,
            skill_line:i+1,source:{path:anchor,line:line(src,declaration.index),sha256:sha(src)},
            detail:'Required key absent from the current map type; check whether the skill or type must change.',
            suggested_action:'REVIEW_UPDATE',confidence:'SOURCE_STRUCTURE_ONLY',target:null,write_authorized:false});
        }
      }
      const pkg=s.match(/Follow the package naming convention:\s*\x60([^\x60]+)\x60/i);
      if(pkg && production.length){
        const prefix=pkg[1].split('<')[0];
        const other=prefix.endsWith('.') && production.find(f=>!f.pkg.startsWith(prefix));
        if(other)observations.push({kind:'PACKAGE_CONVENTION_MISMATCH',
          skill:skill.id,skill_path:skill.path,skill_line:i+1,
          source:{path:other.path,line:other.line,sha256:sha(other.text)},
          detail:'A local source package differs; verify which code this convention governs.',
          suggested_action:'REVIEW_UPDATE',confidence:'SOURCE_STRUCTURE_ONLY',target:null,write_authorized:false});
      }
      if(/Set up test fixtures in a \x60static \{\}\x60 block/i.test(s)){
        const other=tests.find(f=>/@Before\b/.test(f.text)&&/@After\b/.test(f.text));
        if(other)observations.push({kind:'ALTERNATIVE_TEST_SETUP',
          skill:skill.id,skill_path:skill.path,skill_line:i+1,
          source:{path:other.path,line:line(other.text,other.text.indexOf('@Before')),sha256:sha(other.text)},
          detail:'Per-test setup/teardown exists; it does not prove static fixtures are universally wrong.',
          suggested_action:'CHECK_USAGE',confidence:'ALTERNATIVE_PRACTICE_ONLY',target:null,write_authorized:false});
      }
    }
  }
  for(const item of observations){
    item.skill_sha256=sha(skills.find(x=>x.path===item.skill_path).text);
  }
  return {schema_version:1,basis:'BOUNDED_EXPLICIT_SKILL_TO_SOURCE_PATTERNS',
    observations,summary:{review_candidates:observations.length,
      source_mismatches:observations.filter(o=>o.confidence==='SOURCE_STRUCTURE_ONLY').length,
      alternative_practices:observations.filter(o=>o.confidence==='ALTERNATIVE_PRACTICE_ONLY').length},
    write_authorized:false,confirmation_required:true,
    note:'Pattern-scoped code consistency, not full semantic verification or a generated patch.'};
}
export function sourceConsistencyMarkdown(report){
  if(report?.write_authorized!==false || !Array.isArray(report.observations))
    throw Error('Invalid read-only consistency report');
  const md=x=>String(x??'').replace(/\s+/g,' ').trim().replace(/[\\*_[\]#|<>]/g,'\\$&');
  const lines=['# Wizard — source consistency','',
    '**Solo diagnosi. Nessuna correzione applicata o autorizzata.**',''];
  if(!report.observations.length)lines.push('Nessun contrasto individuato dal controllo limitato (non è un esito di verifica completo).','');
  for(const o of report.observations)lines.push('## '+md(o.skill)+' — '+md(o.kind),'',
    '- Skill: '+md(o.skill_path)+':'+o.skill_line,
    '- Fonte: '+md(o.source.path)+':'+o.source.line,
    '- SHA-256 fonte: '+o.source.sha256,
    '- Evidenza: '+md(o.confidence),
    '- Verificare: '+md(o.detail),
    '- Prossimo passo: '+md(o.suggested_action)+' (manuale, nessun MOVE)','');
  return lines.join('\n');
}


/** Turn only source-structural mismatches into manually reviewable UPDATEs. */
export function consistencyUpdateProposals(report,repoId){
  if(report?.write_authorized!==false || !Array.isArray(report.observations) ||
    typeof repoId!=='string' || !repoId.trim())throw Error('Invalid consistency proposals');
  const proposals=[];
  for(const o of report.observations){
    if(o.suggested_action!=='REVIEW_UPDATE')continue;
    if(!safe(o.skill_path) || !safe(o.source?.path) ||
      !/^[a-f0-9]{64}$/.test(o.skill_sha256??'') ||
      !/^[a-f0-9]{64}$/.test(o.source.sha256??''))
      throw Error('Missing source snapshot for review-only update');
    const location={repo:repoId,path:o.skill_path};
    proposals.push({
      id:'source-review-'+sha(repoId+'\0'+o.skill_path+'\0'+o.kind+'\0'+o.source.path+'\0'+o.skill_line).slice(0,16),
      action:'UPDATE',kind:'SOURCE_CONSISTENCY_REVIEW',priority:'P1',
      skill:o.skill,title:'Review '+o.kind+' in '+o.skill,
      reason:o.detail,source:location,target:location,
      evidence:[{...location,sha256:o.skill_sha256},
        {repo:repoId,path:o.source.path,sha256:o.source.sha256}],
      steps:['Verify the exact skill instruction against its source snapshot.',
        'Decide whether the skill instruction or source contract needs clarification.',
        'Prepare and inspect the minimal diff before any final confirmation.'],
      limits:['A structural mismatch is not full semantic proof.',
        'No executable patch has been generated; manual review is mandatory.'],
      auto_apply:false
    });
  }
  return {schema_version:1,consumer_repo:repoId,proposals,
    discovery:'SOURCE_STRUCTURE_REVIEW',read_only:true};
}
