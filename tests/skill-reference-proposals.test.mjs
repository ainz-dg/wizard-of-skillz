import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inventorySkills, auditSkillReferenceLinks } from '../src/skills.mjs';
import { proposeSkillReferenceRepairs } from '../src/skill-reference-proposals.mjs';
import { buildReviewCatalog, planHumanSelection } from '../src/review-selection.mjs';

test('broken skill references produce source-backed UPDATE reviews, never writes', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-review-'));
  try {
    const dir=path.join(root,'.agents','skills','demo');
    fs.mkdirSync(path.join(dir,'references'),{recursive:true});
    fs.writeFileSync(path.join(dir,'references','present.md'),'# Present');
    const source='---\nname: demo\ndescription: Example\n---\n[good](references/present.md)\n[missing](references/absent.md)\n';
    fs.writeFileSync(path.join(dir,'SKILL.md'),source);
    const skills=inventorySkills(root);
    const audit=auditSkillReferenceLinks(root,skills);
    assert.equal(audit.summary.valid,1);
    assert.equal(audit.summary.missing,1);
    const proposals=proposeSkillReferenceRepairs({repoId:'org/demo',skills,audit});
    assert.equal(proposals.proposals.length,1);
    assert.equal(proposals.proposals[0].action,'UPDATE');
    assert.equal(proposals.proposals[0].steps.length,1);
    assert.equal(proposals.proposals[0].auto_apply,false);
    const catalog=buildReviewCatalog(proposals);
    assert.equal(catalog.items[0].readiness,'MANUAL_ONLY');
    assert.equal(planHumanSelection(catalog).selected_count,0);
    const selected=planHumanSelection(catalog,{mode:'ALL'});
    assert.equal(selected.write_authorized,false);
    assert.equal(selected.ready_for_final_confirmation,false);
    assert.ok(selected.blockers.some(x=>x.type==='MANUAL_PREPARATION_REQUIRED'));
    const cli=new URL('../bin/wizard.mjs',import.meta.url).pathname;
    const result=spawnSync(process.execPath,[cli,'review-references',root,'--id','org/demo'],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(result.stdout);
    assert.equal(report.catalog.items.length,1);
    assert.equal(report.selection.mode,'NONE');
    assert.equal(fs.readFileSync(path.join(dir,'SKILL.md'),'utf8'),source);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('a clean audit produces no proposals and missing CLI roots fail clearly',()=>{
  const proposals=proposeSkillReferenceRepairs({repoId:'org/demo',skills:[],audit:{links:[]}});
  assert.deepEqual(proposals.proposals,[]);
  const cli=new URL('../bin/wizard.mjs',import.meta.url).pathname;
  const run=spawnSync(process.execPath,[cli,'review-references','/missing-wizard-repo'],{encoding:'utf8'});
  assert.notEqual(run.status,0);
  assert.match(run.stderr,/repository path does not exist/);
  assert.equal(run.stdout,'');
});
