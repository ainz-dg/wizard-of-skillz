import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildReviewCatalog, planHumanSelection, renderReviewMarkdown } from '../src/review-selection.mjs';

const H='a'.repeat(64);
const previewSet={consumer_repo:'org/app',provider_repo:'org/sdk',previews:[
  {proposal_id:'update-A',status:'PREVIEW_READY'},
  {proposal_id:'update-B',status:'MANUAL_ONLY'}
]};
function set() {
  return {schema_version:1,consumer_repo:'org/app',provider_repo:'org/sdk',proposals:[
    {id:'update-A',kind:'CONFIRMED_SOURCE_DRIFT',skill:'frontend-guidance',
      title:'Correct an outdated TypeScript guideline',reason:'API changed',
      priority:'P1',evidence:[{repo:'org/app',path:'.agents/skills/frontend-guidance/SKILL.md',sha256:H}],
      steps:['Update the example'],limits:['Review first'],auto_apply:false},
    {id:'update-B',kind:'CONFIRMED_SOURCE_DRIFT',skill:'docs-guidance',
      title:'Clarify documentation style',reason:'Inconsistent terminology',
      priority:'P2',evidence:[{repo:'org/app',path:'.agents/skills/docs-guidance/SKILL.md',sha256:H}],
      steps:['Clarify wording'],auto_apply:false}
  ]};
}
function fixtureCatalog() {
  const source=set();
  source.proposals.push({
    id:'create-C',action:'CREATE',title:'Add a missing skill',reason:'Missing guidance',
    target:{repo:'org/app',path:'.agents/skills/markdown-authoring/SKILL.md'},
    depends_on:[],steps:['Draft required behavior'],evidence:[]});
  source.proposals.push({
    id:'move-D',action:'MOVE',title:'Move skill to its correct scope',
    source:{repo:'org/app',path:'.agents/skills/misplaced/SKILL.md'},
    target:{repo:'org/other',path:'.agents/skills/misplaced/SKILL.md'},
    depends_on:['create-C'],evidence:[]});
  return buildReviewCatalog(source,{previews:previewSet});
}
test('legacy source-backed repairs are reviewable UPDATE items without inventing automated patches',()=>{
  const c=buildReviewCatalog(set(),{previews:previewSet});
  assert.equal(c.items.length,2);
  assert.deepEqual(c.items.map(x=>x.action),['UPDATE','UPDATE']);
  assert.equal(c.items[0].readiness,'PREVIEW_READY');
  assert.equal(c.items[1].readiness,'MANUAL_ONLY');
  assert.equal(c.items[0].target.path,'.agents/skills/frontend-guidance/SKILL.md');
  assert.equal(c.items[0].write_authorized,false);
  assert.equal(c.confirmation_required,true);
  assert.equal(c.default_selection,'NONE');
  assert.equal(c.items[0].evidence[0].sha256,H);
});
test('default and NONE mean no changes: never auto-select proposed work',()=>{
  const c=fixtureCatalog();
  const plan=planHumanSelection(c);
  assert.equal(plan.mode,'NONE');
  assert.equal(plan.selected_count,0);
  assert.equal(plan.rejected_count,4);
  assert.equal(plan.ready_for_final_confirmation,false);
  assert.deepEqual(plan.blockers,[]);
  assert.equal(plan.write_authorized,false);
  assert.equal(plan.applied_count,0);
});
test('SUBSET preserves approved scope; even preview-ready items still require human final confirmation',()=>{
  const c=fixtureCatalog();
  const plan=planHumanSelection(c,{mode:'subset',ids:['update-A']});
  assert.deepEqual(plan.selected_ids,['update-A']);
  assert.equal(plan.selected_count,1);
  assert.equal(plan.rejected_count,3);
  assert.equal(plan.ready_for_final_confirmation,true);
  assert.equal(plan.confirmation_required,true);
  assert.equal(plan.write_authorized,false);
  assert.equal(plan.applied_count,0);
  assert.deepEqual(plan.blockers,[]);
  assert.ok(plan.items.find(x=>x.id==='update-B'&&!x.selected));
});
test('ALL selects all proposals but cannot bypass manual preparation or dependencies',()=>{
  const c=fixtureCatalog();
  const plan=planHumanSelection(c,{mode:'ALL'});
  assert.equal(plan.selected_count,4);
  assert.equal(plan.rejected_count,0);
  assert.equal(plan.ready_for_final_confirmation,false);
  assert.ok(plan.blockers.some(x=>x.type==='MANUAL_PREPARATION_REQUIRED'));
  assert.equal(plan.blockers.some(x=>x.type==='MISSING_DEPENDENCY'),false);
  assert.equal(plan.write_authorized,false);
});
test('missing dependencies are disclosed; never silently selected',()=>{
  const p=planHumanSelection(fixtureCatalog(),{mode:'SUBSET',ids:['move-D']});
  assert.equal(p.selected_count,1);
  assert.deepEqual(p.selected_ids,['move-D']);
  assert.ok(p.blockers.some(b=>b.type==='MISSING_DEPENDENCY'&&b.depends_on==='create-C'));
});
test('two selected operations writing the same target produce PATH_COLLISION',()=>{
  const source=set();
  source.proposals.push({id:'create-conflict',action:'CREATE',title:'New skill',
    target:{repo:'org/app',path:'.agents/skills/frontend-guidance/SKILL.md'}});
  const c=buildReviewCatalog(source,{previews:previewSet});
  const p=planHumanSelection(c,{mode:'SUBSET',ids:['update-A','create-conflict']});
  assert.ok(p.blockers.some(b=>b.type==='PATH_COLLISION'));
  assert.equal(p.ready_for_final_confirmation,false);
});
test('malformed choices, fake IDs, duplicates and tampered catalogs fail closed',()=>{
  const c=fixtureCatalog();
  assert.throws(()=>planHumanSelection(c,{mode:'SUBSET',ids:['no-such-item']}),/Unknown selected/);
  assert.throws(()=>planHumanSelection(c,{mode:'SUBSET',ids:['update-A','update-A']}),/unique/);
  assert.throws(()=>planHumanSelection(c,{mode:'NONE',ids:['update-A']}),/only allowed/);
  assert.throws(()=>planHumanSelection(c,{mode:'SOME',ids:['update-A']}),/NONE, ALL or SUBSET/);
  const forged=structuredClone(c);forged.items[0].title='Now safe to apply';
  assert.throws(()=>planHumanSelection(forged,{mode:'ALL'}),/modified after creation/);
});
test('unsafe paths, implicit relocation, invalid MOVE and unknown dependencies are rejected',()=>{
  const bad=set();
  bad.proposals[0].target={repo:'org/app',path:'../../outside.md'};
  assert.throws(()=>buildReviewCatalog(bad),/Unsafe/);
  const move=set();
  move.proposals[0]={id:'move',action:'MOVE',source:{repo:'org/app',path:'a/SKILL.md'},
    target:{repo:'org/app',path:'a/SKILL.md'}};
  assert.throws(()=>buildReviewCatalog(move),/distinct/);
  const missing=set();
  missing.proposals[0].depends_on=['nonexistent'];
  assert.throws(()=>buildReviewCatalog(missing),/Unknown\/self dependency/);
  const duplicate=set();
  duplicate.proposals[1].id='update-A';
  assert.throws(()=>buildReviewCatalog(duplicate),/duplicated proposal/);
});
test('language neutrality: CREATE and MOVE work for docs and Python without build assumptions',()=>{
  const c=fixtureCatalog();
  const add=c.items.find(x=>x.id==='create-C');
  const move=c.items.find(x=>x.id==='move-D');
  assert.equal(add.action,'CREATE');
  assert.equal(add.source,null);
  assert.equal(move.action,'MOVE');
  assert.equal(move.source.repo,'org/app');
  assert.equal(move.target.repo,'org/other');
  assert.equal(c.items.every(x=>x.write_authorized===false),true);
});
test('blocked source plans remain visible, but no selection can claim readiness',()=>{
  const src=set();
  src.proposals.push({id:'unresolved',action:'CREATE',title:'Unknown target'});
  const c=buildReviewCatalog(src,{previews:previewSet});
  const p=planHumanSelection(c,{mode:'SUBSET',ids:['unresolved']});
  assert.ok(p.blockers.some(x=>x.type==='BLOCKED_PROPOSAL'));
  assert.equal(p.ready_for_final_confirmation,false);
});


test('CLI proposes NONE by default and SUBSET only when explicitly selected',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-select-cli-'));
  try{
    const source=path.join(temp,'proposals.json'),previews=path.join(temp,'previews.json');
    fs.writeFileSync(source,JSON.stringify(set()));
    fs.writeFileSync(previews,JSON.stringify(previewSet));
    const script=new URL('../bin/wizard.mjs',import.meta.url).pathname;
    const cmd=(extra=[])=>spawnSync(process.execPath,[script,'plan-repairs',source,'--previews',previews,...extra],{encoding:'utf8'});
    const zero=cmd();
    assert.equal(zero.status,0,zero.stderr);
    const n=JSON.parse(zero.stdout);
    assert.equal(n.selection.selected_count,0);
    assert.equal(n.selection.write_authorized,false);
    const some=cmd(['--select','update-A']);
    assert.equal(some.status,0,some.stderr);
    const p=JSON.parse(some.stdout);
    assert.deepEqual(p.selection.selected_ids,['update-A']);
    assert.equal(p.selection.ready_for_final_confirmation,true);
    assert.equal(p.selection.confirmation_required,true);
    const all=cmd(['--all']);
    assert.equal(all.status,0,all.stderr);
    assert.equal(JSON.parse(all.stdout).selection.selected_count,2);
    const bad=cmd(['--none','--all']);
    assert.notEqual(bad.status,0);
    assert.equal(fs.readdirSync(temp).length,2,'CLI must not create files');
  } finally {fs.rmSync(temp,{force:true,recursive:true});}
});


test('Markdown shows every candidate, current choice, evidence and blockers without authorizing changes',()=>{
  const c=fixtureCatalog();
  const p=planHumanSelection(c,{mode:'SUBSET',ids:['move-D']});
  const md=renderReviewMarkdown(c,p);
  assert.match(md,/Anteprima in sola lettura\. Nessuna modifica è stata applicata/);
  assert.match(md,/## \[ \] Correct an outdated TypeScript guideline/);
  assert.match(md,/## \[x\] Move skill to its correct scope/);
  assert.ok(md.replaceAll('\\','').includes('MISSING_DEPENDENCY'));
  assert.ok(md.replaceAll('\\','').includes('MANUAL_PREPARATION_REQUIRED'));
  assert.match(md,/org\/other/);
  assert.match(md,/SHA-256 aaaaaaaaaaaa/);
  assert.match(md,/Autorizzazione alla scrittura: \*\*no\*\*/);
  assert.equal(md.includes('write_authorized: true'),false);
  assert.match(renderReviewMarkdown(c,planHumanSelection(c)),/Nessuna proposta selezionata/);
});

test('Markdown summary rejects forged selection and escapes untrusted source markup',()=>{
  const source=set();
  source.proposals[0].title='Change\n# pretend approval';
  source.proposals[0].reason='Example | content with special markdown';
  const c=buildReviewCatalog(source,{previews:previewSet});
  const selected=planHumanSelection(c,{mode:'SUBSET',ids:['update-A']});
  const md=renderReviewMarkdown(c,selected);
  assert.ok(!md.includes('\n# pretend approval'));
  assert.ok(md.includes('Example \\| content'));
  const fake=structuredClone(selected);
  fake.selected_ids=['update-B'];
  assert.throws(()=>renderReviewMarkdown(c,fake),/does not match/);
});

test('CLI Markdown mode displays subset with human confirmation and rejects unknown format',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-review-md-'));
  try{
    const proposals=path.join(temp,'proposals.json'),previews=path.join(temp,'previews.json');
    fs.writeFileSync(proposals,JSON.stringify(set()));
    fs.writeFileSync(previews,JSON.stringify(previewSet));
    const script=new URL('../bin/wizard.mjs',import.meta.url).pathname;
    const run=args=>spawnSync(process.execPath,[script,'plan-repairs',proposals,'--previews',previews,...args],{encoding:'utf8'});
    const review=run(['--select','update-A','--format','md']);
    assert.equal(review.status,0,review.stderr);
    assert.match(review.stdout,/## \[x\] Correct an outdated TypeScript guideline/);
    assert.match(review.stdout,/## \[ \] Clarify documentation style/);
    assert.match(review.stdout,/Conferma finale richiesta: \*\*sì\*\*/);
    const invalid=run(['--format','html']);
    assert.notEqual(invalid.status,0);
    assert.equal(fs.readdirSync(temp).length,2);
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
