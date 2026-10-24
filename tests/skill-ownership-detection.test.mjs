import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {detectOwnershipMoves} from '../src/skill-ownership-detection.mjs';
import {buildReviewCatalog,planHumanSelection} from '../src/review-selection.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'wizard-owner-'));
const skill='diagnostic-skill';
const skillRel='.agents/skills/'+skill+'/SKILL.md';
const text='---\nname: diagnostic-skill\ndescription: Check diagnostics\n---\n';

function fixture() {
  const source=temp(), target=temp();
  const skillFile=path.join(source,skillRel);
  fs.mkdirSync(path.dirname(skillFile),{recursive:true});
  fs.mkdirSync(path.join(path.dirname(skillFile),'references'));
  fs.writeFileSync(skillFile,text);
  fs.writeFileSync(path.join(path.dirname(skillFile),'references/checks.md'),'# Checks\n');
  const manifestPath=path.join(target,'docs/ownership.json');
  fs.mkdirSync(path.dirname(manifestPath),{recursive:true});
  const declaration={
    schema_version:1,owner_repo:'example/provider',source_repo:'example/consumer',
    skills:[{name:skill,source_skill_sha256:sha(Buffer.from(text))}]
  };
  const save=(data=declaration)=>fs.writeFileSync(manifestPath,JSON.stringify(data));
  save();
  const args={sourceRoot:source,sourceRepo:'example/consumer',targetRoot:target,
    targetRepo:'example/provider',ownershipFile:'docs/ownership.json',
    skillsDir:'.github/skills'};
  const remove=()=>{fs.rmSync(source,{recursive:true,force:true});fs.rmSync(target,{recursive:true,force:true});};
  return {source,target,skillFile,manifestPath,declaration,save,args,remove};
}

test('owner-declared exact source hash yields a reviewable MOVE with two-sided evidence and no writes',()=>{
  const f=fixture();
  try {
    const before=fs.readFileSync(f.manifestPath);
    const output=detectOwnershipMoves(f.args);
    assert.equal(output.basis,'TARGET_REPOSITORY_OWNERSHIP_DECLARATION_WITH_SOURCE_SHA256');
    assert.equal(output.proposals.length,1);
    assert.equal(output.checks[0].status,'MOVE_CANDIDATE');
    const proposal=output.proposals[0];
    assert.equal(proposal.action,'MOVE');
    assert.equal(proposal.target.repo,'example/provider');
    assert.equal(proposal.target.path,'.github/skills/diagnostic-skill/SKILL.md');
    assert.equal(proposal.source.path,skillRel);
    assert.equal(output.file_manifest.length,2);
    assert.ok(proposal.evidence.some(e=>e.repo==='example/provider' &&
      e.path==='docs/ownership.json' && e.sha256===sha(before)));
    assert.ok(proposal.evidence.some(e=>e.repo==='example/consumer' &&
      e.path===skillRel && e.sha256===sha(Buffer.from(text))));
    const catalog=buildReviewCatalog(output);
    assert.equal(planHumanSelection(catalog).selected_count,0);
    const all=planHumanSelection(catalog,{mode:'ALL'});
    assert.equal(all.write_authorized,false);
    assert.equal(all.ready_for_final_confirmation,false);
    assert.ok(all.blockers.some(x=>x.type==='MANUAL_PREPARATION_REQUIRED'));
    assert.deepEqual(fs.readdirSync(f.target),['docs']);
    assert.equal(fs.readFileSync(f.skillFile,'utf8'),text);
    assert.deepEqual(fs.readFileSync(f.manifestPath),before);
  } finally {f.remove();}
});

test('missing, stale and ambiguous source skills are diagnostics, never MOVE',()=>{
  const f=fixture();
  try {
    const otherPath=path.join(f.source,'.agents/skills/other-skill');
    fs.renameSync(path.dirname(f.skillFile),otherPath);
    let out=detectOwnershipMoves(f.args);
    assert.equal(out.checks[0].status,'SOURCE_NOT_FOUND');
    assert.equal(out.proposals.length,0);
    fs.renameSync(otherPath,path.dirname(f.skillFile));

    fs.writeFileSync(f.skillFile,text+'extra\n');
    out=detectOwnershipMoves(f.args);
    assert.equal(out.checks[0].status,'SOURCE_HASH_MISMATCH');
    assert.equal(out.proposals.length,0);
    fs.writeFileSync(f.skillFile,text);

    const duplicate=path.join(f.source,'nested/diagnostic-skill');
    fs.mkdirSync(duplicate,{recursive:true});
    fs.copyFileSync(f.skillFile,path.join(duplicate,'SKILL.md'));
    out=detectOwnershipMoves(f.args);
    assert.equal(out.checks[0].status,'AMBIGUOUS_SOURCE');
    assert.equal(out.proposals.length,0);
  } finally {f.remove();}
});

test('occupied destination and unreadable ownership evidence cannot authorize relocation',()=>{
  const f=fixture();
  try {
    const occupied=path.join(f.target,'.github/skills/diagnostic-skill');
    fs.mkdirSync(occupied,{recursive:true});
    let out=detectOwnershipMoves(f.args);
    assert.equal(out.checks[0].status,'MOVE_BLOCKED');
    assert.equal(out.proposals.length,0);
    fs.rmSync(occupied,{recursive:true});
    assert.throws(()=>detectOwnershipMoves({...f.args,ownershipFile:'../secret.json'}),/Unsafe/);
    assert.throws(()=>detectOwnershipMoves({...f.args,targetRepo:'wrong/repo'}),/mismatched/);
    f.save({...f.declaration,skills:[...f.declaration.skills,...f.declaration.skills]});
    assert.throws(()=>detectOwnershipMoves(f.args),/duplicated/);
    f.save();
    const old=fs.readFileSync(f.manifestPath);
    fs.rmSync(f.manifestPath);
    fs.symlinkSync(f.skillFile,f.manifestPath);
    assert.throws(()=>detectOwnershipMoves(f.args),/Symlink/);
    fs.rmSync(f.manifestPath);
    fs.writeFileSync(f.manifestPath,old);
    assert.equal(detectOwnershipMoves(f.args).proposals.length,1);
  } finally {f.remove();}
});

test('CLI detects a MOVE with JSON or Markdown, defaults NONE and never edits repos',()=>{
  const f=fixture();
  try {
    const cli=new URL('../bin/wizard.mjs',import.meta.url).pathname;
    const cmd=['detect-moves',f.source,
      '--source-id','example/consumer','--target-root',f.target,
      '--target-id','example/provider','--ownership-file','docs/ownership.json',
      '--skills-dir','.github/skills'];
    const run=rest=>spawnSync(process.execPath,[cli,...cmd,...rest],{encoding:'utf8'});
    const normal=run([]);
    assert.equal(normal.status,0,normal.stderr);
    const output=JSON.parse(normal.stdout);
    assert.equal(output.detection.checks[0].status,'MOVE_CANDIDATE');
    assert.equal(output.selection.mode,'NONE');
    assert.equal(output.selection.write_authorized,false);
    const md=run(['--all','--format','md']);
    assert.equal(md.status,0,md.stderr);
    assert.match(md.stdout,/Review relocation of diagnostic-skill/);
    assert.match(md.stdout,/Autorizzazione alla scrittura: \*\*no\*\*/);
    assert.notEqual(run(['--none','--all']).status,0);
    assert.equal(fs.readFileSync(f.skillFile,'utf8'),text);
    assert.equal(fs.existsSync(path.join(f.target,'.github')),false);
  } finally {f.remove();}
});
