import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {proposeSkillMoveReview} from '../src/skill-move-proposals.mjs';
import {buildReviewCatalog,planHumanSelection,renderReviewMarkdown} from '../src/review-selection.mjs';

const sha = x => createHash('sha256').update(x).digest('hex');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(),'wizard-move-review-'));
const skillPath = '.agents/skills/diagnostic-skill/SKILL.md';

function fixture() {
  const src=temp(),dest=temp();
  const skill=path.join(src,skillPath);
  const ref=path.join(path.dirname(skill),'references','checks.md');
  const binary=path.join(path.dirname(skill),'assets','icon.bin');
  fs.mkdirSync(path.dirname(ref),{recursive:true});
  fs.mkdirSync(path.dirname(binary),{recursive:true});
  fs.writeFileSync(skill,'---\nname: diagnostic-skill\ndescription: Review diagnostics\n---\n');
  fs.writeFileSync(ref,'# Checks\n');
  fs.writeFileSync(binary,Buffer.from([0,255,8,9]));
  return {src,dest,skill,ref,binary};
}
const args=f=>({
  sourceRoot:f.src,sourceRepo:'fiction/source',
  sourceSkill:skillPath,targetRoot:f.dest,targetRepo:'fiction/target',
  skillsDir:'.github/skills',reason:'Explicit review of ownership transfer'
});
const cleanup=f=>{fs.rmSync(f.src,{recursive:true,force:true});fs.rmSync(f.dest,{recursive:true,force:true});};

test('MOVE contains full byte-hashed package manifest, explicit paths and no writes',()=>{
  const f=fixture();
  try {
    const result=proposeSkillMoveReview(args(f));
    assert.equal(result.proposals.length,1);
    const move=result.proposals[0];
    assert.equal(move.action,'MOVE');
    assert.deepEqual(move.source,{repo:'fiction/source',path:skillPath});
    assert.deepEqual(move.target,{repo:'fiction/target',path:'.github/skills/diagnostic-skill/SKILL.md'});
    assert.equal(result.file_manifest.length,3);
    assert.ok(result.file_manifest.some(x=>x.from.endsWith('/references/checks.md')));
    const binary=result.file_manifest.find(x=>x.from.endsWith('/assets/icon.bin'));
    assert.equal(binary.sha256,sha(Buffer.from([0,255,8,9])));
    assert.equal(binary.to,'.github/skills/diagnostic-skill/assets/icon.bin');
    assert.equal(move.evidence.length,result.file_manifest.length);
    const catalog=buildReviewCatalog(result);
    assert.equal(catalog.items[0].action,'MOVE');
    assert.equal(planHumanSelection(catalog).selected_count,0);
    const selected=planHumanSelection(catalog,{mode:'ALL'});
    assert.equal(selected.write_authorized,false);
    assert.equal(selected.ready_for_final_confirmation,false);
    assert.ok(selected.blockers.some(b=>b.type==='MANUAL_PREPARATION_REQUIRED'));
    assert.match(renderReviewMarkdown(catalog,selected),/Relocation|relocation|relocazione|MOVE/);
    assert.deepEqual(fs.readdirSync(f.dest),[]);
    assert.equal(fs.readFileSync(f.ref,'utf8'),'# Checks\n');
  } finally {cleanup(f);}
});

test('same repository relocation supports distinct directories without apply',()=>{
  const f=fixture();
  try {
    const input={...args(f),targetRoot:f.src,targetRepo:'fiction/source',skillsDir:'.github/skills'};
    const result=proposeSkillMoveReview(input);
    assert.equal(result.proposals[0].action,'MOVE');
    assert.equal(result.proposals[0].source.repo,result.proposals[0].target.repo);
    assert.equal(fs.existsSync(path.join(f.src,'.github')),false);
  } finally {cleanup(f);}
});

test('occupied destination, unsafe roots/paths, same-folder and symlinks fail closed',()=>{
  const f=fixture();
  try {
    const input=args(f);
    assert.throws(()=>proposeSkillMoveReview({...input,sourceSkill:'../outside/SKILL.md'}),/Unsafe/);
    assert.throws(()=>proposeSkillMoveReview({...input,sourceSkill:'not-a-skill.md'}),/SKILL.md/);
    assert.throws(()=>proposeSkillMoveReview({...input,targetRepo:'fiction/source'}),/IDs and roots disagree/);
    assert.throws(()=>proposeSkillMoveReview({...input,targetRoot:f.src}),/IDs and roots disagree/);
    assert.throws(()=>proposeSkillMoveReview({...input,targetRoot:f.src,targetRepo:'fiction/source',skillsDir:'.agents/skills'}),/Destination may not/);

    const occupied=path.join(f.dest,'.github/skills/diagnostic-skill');
    fs.mkdirSync(occupied,{recursive:true});
    assert.throws(()=>proposeSkillMoveReview(input),/occupied/);
    fs.rmSync(occupied,{recursive:true});
    fs.symlinkSync(f.src,occupied);
    assert.throws(()=>proposeSkillMoveReview(input),/Symlink/);
    fs.rmSync(occupied);
    const nested=path.join(path.dirname(f.skill),'references','other.md');
    fs.symlinkSync(f.ref,nested);
    assert.throws(()=>proposeSkillMoveReview(input),/Symlink inside skill/);
    fs.rmSync(nested);
    const main=f.skill;
    fs.rmSync(main);
    fs.symlinkSync(f.ref,main);
    assert.throws(()=>proposeSkillMoveReview(input),/Symlink in source path/);
  } finally {cleanup(f);}
});

test('review-move CLI reports unselected JSON and selected Markdown, keeps repos untouched',()=>{
  const f=fixture();
  try {
    const cli=new URL('../bin/wizard.mjs',import.meta.url).pathname;
    const cmd=['review-move',f.src,'--source-id','fiction/source',
      '--skill-path',skillPath,'--target-root',f.dest,
      '--target-id','fiction/target','--skills-dir','.github/skills'];
    const run=extra=>spawnSync(process.execPath,[cli,...cmd,...extra],{encoding:'utf8'});
    const initial=run([]);
    assert.equal(initial.status,0,initial.stderr);
    const review=JSON.parse(initial.stdout);
    assert.equal(review.move_review.proposals[0].action,'MOVE');
    assert.equal(review.selection.selected_count,0);
    assert.equal(review.selection.write_authorized,false);
    const md=run(['--all','--format','md']);
    assert.equal(md.status,0,md.stderr);
    assert.match(md.stdout,/Review relocation of diagnostic-skill/);
    assert.match(md.stdout.replaceAll(String.fromCharCode(92),''),/MANUAL_PREPARATION_REQUIRED/);
    assert.notEqual(run(['--none','--all']).status,0);
    assert.equal(fs.readdirSync(f.dest).length,0);
  } finally {cleanup(f);}
});
