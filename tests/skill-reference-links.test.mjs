import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inventorySkills, auditSkillReferenceLinks } from '../src/skills.mjs';
import { auditLocalPathMentions } from '../src/local-path-mentions.mjs';

function withSkill(fn){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-ref-links-'));
  const folder=path.join(root,'.agents','skills','demo');
  const refs=path.join(folder,'references');
  fs.mkdirSync(refs,{recursive:true});
  const write=(name,content)=>fs.writeFileSync(path.join(refs,name),content);
  try{return fn({root,folder,refs,write});}
  finally{fs.rmSync(root,{force:true,recursive:true});}
}
test('existing skill references: check valid, missing, anchors, symlink escape and traversal separately',()=>withSkill(({root,folder,refs,write})=>{
  write('api.md','# API\n');
  fs.mkdirSync(path.join(refs,'directory.md'));
  const external=path.join(root,'outside.md');
  fs.writeFileSync(external,'# external\n');
  fs.symlinkSync(external,path.join(refs,'linked.md'));
  fs.writeFileSync(path.join(folder,'SKILL.md'),[
    '---','name: demo','description: Fictional test skill','---',
    'Read [API](references/api.md#methods).',
    'Read [API again](references/api.md#methods).',
    'Read [missing](references/no-file.md).',
    'Read [outside](references/../outside.md).',
    'Read [symlink](references/linked.md).',
    'Read [directory](references/directory.md).',
    'Read [encoded](references/%2e%2e/outside.md).',
    '~~~md','[example missing](references/example.md)','~~~'
  ].join('\n'));
  const inventory=inventorySkills(root);
  const report=auditSkillReferenceLinks(root,inventory);
  assert.equal(report.summary.checked,6);
  assert.deepEqual(report.summary,{checked:6,valid:1,missing:1,unsafe:3,not_a_file:1});
  const map=Object.fromEntries(report.links.map(x=>[x.target,x.status]));
  assert.equal(map['references/api.md#methods'],'VALID');
  assert.equal(map['references/no-file.md'],'MISSING');
  assert.equal(map['references/linked.md'],'UNSAFE');
  assert.equal(map['references/../outside.md'],'UNSAFE');
  assert.equal(map['references/directory.md'],'NOT_A_FILE');
  assert.equal(map['references/%2e%2e/outside.md'],'UNSAFE');
  assert.equal(report.links.some(x=>x.target.includes('example.md')),false);
  assert.equal(fs.readFileSync(external,'utf8'),'# external\n');
}));
test('skills with no linked references are valid empty inventories',()=>withSkill(({root,folder})=>{
  fs.writeFileSync(path.join(folder,'SKILL.md'),'# Just an instruction\n');
  const report=auditSkillReferenceLinks(root);
  assert.deepEqual(report.links,[]);
  assert.deepEqual(report.summary,{checked:0,valid:0,missing:0,unsafe:0,not_a_file:0});
}));
test('inventory CLI --check-references is a read-only diagnostic, default output unchanged',()=>withSkill(({root,folder,write})=>{
  write('guide.md','# Guide\n');
  fs.writeFileSync(path.join(folder,'SKILL.md'),'---\nname: demo\ndescription: Test\n---\n[Guide](references/guide.md)\n');
  const script=new URL('../bin/wizard.mjs',import.meta.url).pathname;
  const original=spawnSync(process.execPath,[script,'inventory',root],{encoding:'utf8'});
  const extended=spawnSync(process.execPath,[script,'inventory',root,'--check-references'],{encoding:'utf8'});
  assert.equal(original.status,0,original.stderr);
  assert.equal(extended.status,0,extended.stderr);
  assert.ok(Array.isArray(JSON.parse(original.stdout)));
  const output=JSON.parse(extended.stdout);
  assert.equal(output.skills.length,1);
  assert.equal(output.reference_links.summary.valid,1);
  assert.equal(fs.readFileSync(path.join(folder,'SKILL.md'),'utf8').includes('guide.md'),true);
}));


test('missing/non-directory roots fail with a helpful message instead of Node stack traces',()=>{
  const cli=new URL('../bin/wizard.mjs',import.meta.url).pathname;
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-cli-missing-root-'));
  try{
    const missing=path.join(tmp,'repo');
    const existingFile=path.join(tmp,'not-a-directory.txt');
    fs.writeFileSync(existingFile,'not a repository');
    for(const command of ['inventory','profile','claims']){
      for(const target of [missing,existingFile]){
        const args=[cli,command,target];
        if(command==='inventory')args.push('--check-references');
        const result=spawnSync(process.execPath,args,{encoding:'utf8'});
        assert.notEqual(result.status,0,command+' must not accept '+target);
        assert.match(result.stderr,/repository path (does not exist|is not a directory)/);
        assert.ok(!result.stderr.includes('at Object.realpathSync'));
        assert.equal(result.stdout,'');
      }
    }
    const withoutCheck=spawnSync(process.execPath,[cli,'inventory',missing],{encoding:'utf8'});
    assert.notEqual(withoutCheck.status,0,'a missing root must not return an empty inventory');
    assert.match(withoutCheck.stderr,/repository path does not exist/);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('local path mentions check chapter evidence without rewriting legacy link proposals',()=>withSkill(({root,folder,refs,write})=>{
  const tick=String.fromCharCode(96);
  const actual='src/components/framework/accent-wrapper/accent-wrapper.tsx';
  const missing='src/components/framework/accentWrapper/accentWrapper.tsx';
  const dynamic='src/routes/[slug].tsx';
  for(const file of [actual,dynamic]){
    fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});
    fs.writeFileSync(path.join(root,file),'export {}\n');
  }
  fs.writeFileSync(path.join(root,'outside.md'),'private fixture');
  write('related.md','# related');
  fs.mkdirSync(path.join(refs,'folder.md'));
  fs.symlinkSync(path.join(root,'outside.md'),path.join(refs,'linked.md'));
  const chapter=[
    '# Source anchors',
    '- '+tick+missing+tick+' (missing)',
    '- '+tick+actual+tick+' (present)',
    '- '+tick+dynamic+tick+' (literal bracketed route)',
    '- '+tick+'src/generated/<name>.tsx'+tick+' (placeholder, skip)',
    '- '+tick+'src/**/thing.tsx'+tick+' (glob, skip)',
    '- '+tick+'src/example/...'+tick+' (ellipsis, skip)',
    '~~~tsx',tick+'src/hidden.tsx'+tick,'~~~',
    '- [related](./related.md)',
    '- [planned](./planned.md)',
    '- [directory](./folder.md)',
    '- [link](./linked.md)',
    '- [escape](../../../../../outside.md)',
    '- [online](https://example.com/page.md)',
    '- [existing root source](src/routes/[slug].tsx)'
  ].join('\n');
  write('chapter.md',chapter);
  fs.writeFileSync(path.join(folder,'SKILL.md'),[
    '# A skill','[chapter](references/chapter.md)',
    'File: '+tick+actual+tick
  ].join('\n'));
  const legacy=auditSkillReferenceLinks(root);
  assert.equal(legacy.summary.checked,1);
  assert.equal(legacy.summary.valid,1);
  const found=auditLocalPathMentions(root,inventorySkills(root,{safeRoot:true}));
  const fromChapter=found.mentions.filter(x=>x.document.endsWith('references/chapter.md'));
  const byPath=new Map(fromChapter.map(x=>[x.mentioned_path,x]));
  assert.equal(byPath.get(missing).status,'MISSING_AT_SNAPSHOT');
  assert.equal(byPath.get(missing).line,2);
  assert.equal(byPath.get(actual).status,'PRESENT');
  assert.equal(byPath.get(dynamic).status,'PRESENT');
  assert.equal(byPath.get('./related.md').status,'PRESENT');
  assert.equal(byPath.get('./planned.md').status,'MISSING_AT_SNAPSHOT');
  assert.equal(byPath.get('./folder.md').status,'NOT_A_FILE');
  assert.equal(byPath.get('./linked.md').status,'UNSAFE_SYMLINK');
  assert.equal(byPath.get('../../../../../outside.md').status,'UNSAFE_PATH');
  assert.equal(byPath.get('src/routes/[slug].tsx').status,'PRESENT');
  assert.equal(fromChapter.filter(x=>x.mentioned_path==='src/routes/[slug].tsx').length,2);
  assert.equal(found.mentions.some(x=>x.mentioned_path.includes('<name>')),false);
  assert.equal(found.mentions.some(x=>x.mentioned_path.includes('**')),false);
  assert.equal(found.mentions.some(x=>x.mentioned_path.includes('...')),false);
  assert.equal(found.mentions.some(x=>x.mentioned_path.includes('hidden')),false);
  assert.equal(found.mentions.some(x=>x.mentioned_path.includes('https')),false);
  assert.equal(found.mentions.some(x=>x.mentioned_path==='references/chapter.md'),false);
  assert.ok(found.mentions.every(x=>/^[a-f0-9]{64}$/.test(x.document_sha256)));
  assert.equal(found.summary.missing_at_snapshot,2);
  assert.equal(found.summary.unsafe_path,1);
  assert.equal(found.summary.unsafe_symlink,1);
  assert.equal(found.summary.not_a_file,1);
}));

test('local path mentions deduplicate same-line references and skip symlinked chapters',()=>withSkill(({root,folder,refs,write})=>{
  const tick=String.fromCharCode(96);
  fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'src','index.ts'),'export {}\n');
  fs.writeFileSync(path.join(folder,'SKILL.md'),[
    '# Skill',
    'See '+tick+'src/index.ts'+tick+' and '+tick+'src/index.ts'+tick,
    'See '+tick+'src/missing.ts'+tick,
    '[chapter](references/chapter.md)'
  ].join('\n'));
  write('chapter.md','# Chapter');
  const external=path.join(root,'outside.md');
  fs.writeFileSync(external,tick+'src/external-leak.ts'+tick);
  fs.symlinkSync(external,path.join(refs,'escape.md'));
  const report=auditLocalPathMentions(root,inventorySkills(root,{safeRoot:true}));
  assert.equal(report.summary.checked,2);
  assert.equal(report.summary.present,1);
  assert.equal(report.summary.missing_at_snapshot,1);
  assert.ok(!report.mentions.some(x=>x.mentioned_path.includes('external-leak')));
}));
