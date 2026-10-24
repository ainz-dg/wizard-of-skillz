/**
 * Distinguish thin client adapters from canonical Agent Skills.
 * This is an identity/read-only check, never a duplicate-removal signal.
 */
import path from 'node:path';

const p = value => value.split(path.sep).join('/');
export function thinAdapterTarget(skill) {
  if (!skill?.path?.startsWith('.claude/skills/') ||
      !skill.path.endsWith('/SKILL.md') || typeof skill.text !== 'string')
    return null;
  const body=skill.text;
  const matches=[...body.matchAll(/\]\((\.\.\/[^\s)]+\/SKILL\.md)\)/g)];
  if (matches.length!==1 || !/\b(?:adapter|bridge)\b/i.test(body)) return null;
  const target=p(path.posix.normalize(path.posix.join(path.posix.dirname(skill.path),matches[0][1])));
  if(!/^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(target)) return null;
  const alias=skill.path.split('/')[2], owner=target.split('/')[2];
  if(alias!==owner)return null;
  return target;
}

export function inspectSkillAdapters(skills){
  if(!Array.isArray(skills))throw Error('Expected skill inventory');
  const existing=new Set(skills.map(x=>x.path));
  const adapters=skills.flatMap(skill=>{
    const target=thinAdapterTarget(skill);
    return target?[{skill:skill.id,path:skill.path,canonical_path:target,
      status:existing.has(target)?'THIN_ADAPTER':'BROKEN_CANONICAL_POINTER',
      remove_recommended:false,write_authorized:false}]:[];
  });
  return {schema_version:1,basis:'EXPLICIT_THIN_ADAPTER_LINK',
    adapters,summary:{total:adapters.length,valid:adapters.filter(x=>x.status==='THIN_ADAPTER').length,
      broken:adapters.filter(x=>x.status==='BROKEN_CANONICAL_POINTER').length},
    write_authorized:false,
    note:'Missing matching adapters are not a reason to create one; client coverage is repository policy.'};
}
