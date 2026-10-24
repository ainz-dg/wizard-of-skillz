import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { proposeSkillDesignReview, renderSkillDesignDiff } from '../src/skill-design-proposals.mjs';
import { buildReviewCatalog, planHumanSelection } from '../src/review-selection.mjs';

function fixture() {
  return {
    decision:'SKILL', decision_reason:'Repeatable source-backed process',
    skill:{
      name:'docs-process', invocation:'model',
      description:'Use for multi-step documentation audits.',
      trigger_branches:['When documentation is changed'],
      steps:[{id:'verify',instruction:'Verify the documentation',
        completion_criterion:'Every claim is checked',claim_ids:['claim-1']}],
      reference:[{claim_id:'claim-1',placement:'disclosed',rule:'Use documented commands',reason:'Reference only'}],
      disclosed_references:[{name:'checks.md',pointer:'when auditing',claim_ids:['claim-1']}]
    },
    _meta:{target_owner:'org/docs',source_skill:'docs-process'}
  };
}
function root() { return fs.mkdtempSync(path.join(os.tmpdir(),'wizard-design-review-')); }
function build(dir,design=fixture()) {
  return proposeSkillDesignReview({design,repoRoot:dir,repoId:'org/docs',skillsDir:'.agents/skills'});
}
test('new package becomes one CREATE, includes exact candidate files, and selects NONE by default',()=>{
  const dir=root();
  try {
    const p=build(dir), c=buildReviewCatalog(p), selected=planHumanSelection(c,{mode:'ALL'});
    assert.equal(p.proposals.length,1);
    assert.equal(p.proposals[0].action,'CREATE');
    assert.equal(p.proposals[0].target.path,'.agents/skills/docs-process/SKILL.md');
    assert.deepEqual(p.candidate_files.map(f=>f.change),['CREATE','CREATE']);
    assert.match(p.candidate_files[0].candidate_content,/name: docs-process/);
    assert.match(p.candidate_files[1].candidate_content,/Use documented commands/);
    assert.equal(planHumanSelection(c).selected_count,0);
    assert.equal(selected.ready_for_final_confirmation,false);
    assert.ok(selected.blockers.some(x=>x.type==='MANUAL_PREPARATION_REQUIRED'));
    assert.equal(selected.write_authorized,false);
    assert.equal(fs.readdirSync(dir).length,0);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('existing skill becomes UPDATE with original source hash and per-file changes; identical package is a no-op',()=>{
  const dir=root();
  try {
    const first=build(dir);
    for(const f of first.candidate_files){
      const p=path.join(dir,f.path);
      fs.mkdirSync(path.dirname(p),{recursive:true});
      fs.writeFileSync(p,f.candidate_content);
    }
    assert.equal(build(dir).proposals.length,0);
    const skill=path.join(dir,'.agents/skills/docs-process/SKILL.md');
    fs.writeFileSync(skill,'old guidance');
    const p=build(dir);
    assert.equal(p.proposals[0].action,'UPDATE');
    assert.equal(p.proposals[0].evidence.length,1);
    assert.match(p.proposals[0].evidence[0].sha256,/^[a-f0-9]{64}$/);
    assert.deepEqual(p.candidate_files.map(f=>f.change),['UPDATE','UNCHANGED']);
    assert.equal(p.candidate_files[0].original_content,'old guidance');
    assert.equal(fs.readFileSync(skill,'utf8'),'old guidance','review must not edit the source');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('NO_SKILL correctly produces no candidate and no review action',()=>{
  const dir=root();
  try {
    const p=build(dir,{decision:'NO_SKILL',decision_reason:'Cheap lookup',skill:null});
    assert.equal(p.decision,'NO_SKILL');
    assert.deepEqual(p.proposals,[]);
    assert.deepEqual(p.candidate_files,[]);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('owner mismatches, path escapes, occupied folders and target symlinks fail closed',()=>{
  const dir=root();
  try {
    const design=fixture();
    design._meta.target_owner='org/other';
    assert.throws(()=>build(dir,design),/owner does not match/);
    assert.throws(()=>proposeSkillDesignReview({design:fixture(),repoRoot:dir,
      repoId:'org/docs',skillsDir:'../escape'}),/safe repository-relative/);
    const occupied=path.join(dir,'.agents/skills/docs-process');
    fs.mkdirSync(occupied,{recursive:true});
    assert.throws(()=>build(dir),/already exists without SKILL.md/);
    fs.rmSync(occupied,{recursive:true});
    const outside=path.join(dir,'outside.md');
    fs.writeFileSync(outside,'original');
    fs.symlinkSync(outside,path.join(dir,'.agents/skills/docs-process'));
    assert.throws(()=>build(dir),/Symlink in target path/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('review-design CLI outputs machine and human review without touching repository',()=>{
  const dir=root(), store=root();
  try {
    const input=path.join(store,'skill-design.json');
    fs.writeFileSync(input,JSON.stringify(fixture()));
    const cli=new URL('../bin/wizard.mjs',import.meta.url).pathname;
    const args=['review-design',input,'--repo-root',dir,'--repo-id','org/docs','--skills-dir','.agents/skills'];
    const run=extra=>spawnSync(process.execPath,[cli,...args,...extra],{encoding:'utf8'});
    const initial=run([]);
    assert.equal(initial.status,0,initial.stderr);
    const result=JSON.parse(initial.stdout);
    assert.equal(result.design_review.proposals[0].action,'CREATE');
    assert.equal(result.selection.selected_count,0);
    assert.equal(result.selection.write_authorized,false);
    const diff=run(['--format','diff']);
    assert.equal(diff.status,0,diff.stderr);
    assert.match(diff.stdout,/--- \/dev\/null/);
    assert.match(diff.stdout,/\+\+\+ b\/\.agents\/skills\/docs-process\/SKILL\.md/);
    const md=run(['--all','--format','md']);
    assert.equal(md.status,0,md.stderr);
    assert.match(md.stdout,/CREATE skill docs-process/);
    assert.ok(md.stdout.replaceAll(String.fromCharCode(92), '').includes('MANUAL_PREPARATION_REQUIRED'));
    assert.notEqual(run(['--all','--none']).status,0);
    assert.equal(fs.readdirSync(dir).length,0);
    assert.deepEqual(fs.readdirSync(store),['skill-design.json']);
  } finally {fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(store,{recursive:true,force:true});}
});


test('design diff displays every changed file, omits unchanged files and validates content hashes',()=>{
  const dir=root();
  try {
    const create=build(dir);
    const creationDiff=renderSkillDesignDiff(create);
    assert.match(creationDiff,/--- \/dev\/null/);
    assert.match(creationDiff,/\+\+\+ b\/\.agents\/skills\/docs-process\/SKILL\.md/);
    assert.match(creationDiff,/\+\+\+ b\/\.agents\/skills\/docs-process\/references\/checks\.md/);
    assert.match(creationDiff, /@@ -0,0 \+1,\d+ @@/);
    for(const f of create.candidate_files){
      const p=path.join(dir,f.path);
      fs.mkdirSync(path.dirname(p),{recursive:true});
      fs.writeFileSync(p,f.candidate_content);
    }
    assert.equal(renderSkillDesignDiff(build(dir)),'');
    const main=path.join(dir,'.agents/skills/docs-process/SKILL.md');
    fs.writeFileSync(main,'old guidance without newline');
    const update=build(dir);
    const diff=renderSkillDesignDiff(update);
    assert.match(diff,/--- a\/\.agents\/skills\/docs-process\/SKILL\.md/);
    assert.match(diff,/\+\+\+ b\/\.agents\/skills\/docs-process\/SKILL\.md/);
    assert.match(diff,/-old guidance without newline/);
    assert.match(diff,/\\ No newline at end of file/);
    assert.doesNotMatch(diff,/^\+\+\+ b\/\.agents\/skills\/docs-process\/references\/checks\.md$/m);
    assert.equal(fs.readFileSync(main,'utf8'),'old guidance without newline');
    const edited=structuredClone(update);
    edited.candidate_files[0].candidate_content+='tampered';
    assert.throws(()=>renderSkillDesignDiff(edited),/SHA-256/);
    const incorrect=structuredClone(update);
    incorrect.candidate_files[0].change='UNCHANGED';
    assert.throws(()=>renderSkillDesignDiff(incorrect),/classification/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
