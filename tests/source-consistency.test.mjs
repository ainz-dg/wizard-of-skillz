import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inspectSourceConsistency,sourceConsistencyMarkdown,consistencyUpdateProposals} from '../src/source-consistency.mjs';
import {buildReviewCatalog,planHumanSelection} from '../src/review-selection.mjs';
import {inspectSkillAdapters} from '../src/skill-adapters.mjs';
import {extractClaims} from '../src/claims.mjs';

const t=String.fromCharCode(96);
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-consistency-'));
  const write=(rel,body)=>{
    const file=path.join(root,rel);
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);
  };
  return {root,write,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
function skill(id,content,scope='.agents'){
  return {id,path:scope+'/skills/'+id+'/SKILL.md',text:content};
}
test('generic TypeScript shape instruction with absent field yields manual UPDATE review only',()=>{
  const f=fixture();
  try{
    f.write('src/config/shapes.ts',[
      'export type ShapesInfoMap = Record<Shape, {',
      '  isVisual: boolean;',
      '  name: string;',
      '}>;',
      'export const ShapesInfo: ShapesInfoMap = {} as ShapesInfoMap;'
    ].join('\n'));
    const instruction=skill('new-widget',[
      '# Declaration','**File:** '+t+'src/config/shapes.ts'+t,
      '- Add an entry to '+t+'ShapesInfo'+t+' with at minimum '+
      t+'{ isK2: true }'+t+'.'
    ].join('\n'));
    const result=inspectSourceConsistency(f.root,[instruction]);
    assert.equal(result.summary.source_mismatches,1);
    const item=result.observations[0];
    assert.equal(item.kind,'TYPE_PROPERTY_MISMATCH');
    assert.equal(item.source.path,'src/config/shapes.ts');
    assert.match(item.source.sha256,/^[a-f0-9]{64}$/);
    assert.equal(item.suggested_action,'REVIEW_UPDATE');
    assert.equal(item.target,null);
    assert.equal(item.write_authorized,false);
    assert.ok(sourceConsistencyMarkdown(result).includes('TYPE'+String.fromCharCode(92)+'_PROPERTY'+String.fromCharCode(92)+'_MISMATCH'));
    f.write('src/config/shapes.ts','export type ShapesInfoMap = Record<Shape, { isK2: boolean; name: string }>; '+
      'export const ShapesInfo: ShapesInfoMap = {} as ShapesInfoMap;');
    assert.equal(inspectSourceConsistency(f.root,[instruction]).observations.length,0);
  }finally{f.cleanup();}
});

test('Java package instructions compare with local Java sources without fabricating a MOVE',()=>{
  const f=fixture();
  try{
    f.write('src/main/java/com/acme/service/Task.java','package com.acme.service;\nclass Task {}');
    const s=skill('service', '# Rules\n- Follow the package naming convention: '+
      t+'com.acme.sdk.<module-area>'+t+'.');
    const result=inspectSourceConsistency(f.root,[s]);
    assert.equal(result.observations[0].kind,'PACKAGE_CONVENTION_MISMATCH');
    assert.equal(result.observations[0].source.path,'src/main/java/com/acme/service/Task.java');
    assert.equal(result.observations[0].confidence,'SOURCE_STRUCTURE_ONLY');
    assert.equal(result.observations[0].target,null);
    assert.equal(result.write_authorized,false);
  }finally{f.cleanup();}
});

test('alternative JUnit lifecycle is a contextual check rather than an automatic fix',()=>{
  const f=fixture();
  try{
    f.write('src/test/java/com/acme/ThingTest.java',
      'package com.acme;\nclass ThingTest { @Before void setUp() {} @After void tearDown() {} }');
    const s=skill('testing','# Fixtures\nSet up test fixtures in a '+
      t+'static {}'+t+' block:');
    const result=inspectSourceConsistency(f.root,[s]);
    assert.equal(result.observations[0].kind,'ALTERNATIVE_TEST_SETUP');
    assert.equal(result.observations[0].suggested_action,'CHECK_USAGE');
    assert.equal(result.observations[0].confidence,'ALTERNATIVE_PRACTICE_ONLY');
  }finally{f.cleanup();}
});

test('thin Claude adapters do not create duplicate canonical claims or REMOVE recommendations',()=>{
  const canonical=skill('router','# Policy\n- Always verify the source before changing code.');
  const adapter=skill('router',[
    '---','name: router','description: Claude adapter','---',
    '# Router Claude Adapter',
    'Canonical skill: ['+t+'.agents/skills/router/SKILL.md'+t+'](../../../.agents/skills/router/SKILL.md)',
    'Read the canonical skill, then use its rules.'
  ].join('\n'),'.claude');
  const report=inspectSkillAdapters([canonical,adapter]);
  assert.equal(report.summary.valid,1);
  assert.equal(report.adapters[0].status,'THIN_ADAPTER');
  assert.equal(report.adapters[0].remove_recommended,false);
  const fromBoth=extractClaims([canonical,adapter]);
  const fromCanonical=extractClaims([canonical]);
  assert.deepEqual(fromBoth,fromCanonical);
  const missing=inspectSkillAdapters([adapter]);
  assert.equal(missing.adapters[0].status,'BROKEN_CANONICAL_POINTER');
  assert.equal(missing.write_authorized,false);
});

test('ordinary repeated skill name across paths is not implicitly an adapter',()=>{
  const root=skill('feature','# Feature\nAlways inspect local data.');
  const other=skill('feature','# Different\nAlways inspect this other source.','.claude');
  assert.equal(inspectSkillAdapters([root,other]).adapters.length,0);
  assert.equal(extractClaims([root,other]).length,2);
});


test('only structural source discrepancies become manual-only selectable UPDATEs',()=>{
  const f=fixture();
  try {
    f.write('src/config/shapes.ts',[
      'export type Info = Record<Shape, {label: string}>;',
      'export const Items: Info = {} as Info;'
    ].join('\n'));
    f.write('src/test/java/com/acme/ThingTest.java',
      'package com.acme;\nclass ThingTest { @Before void setUp() {} @After void tearDown() {} }');
    const target=skill('sample',[
      '**File:** '+t+'src/config/shapes.ts'+t,
      'Add an entry to '+t+'Items'+t+' with at minimum '+t+'{ isNew: true }'+t+'.',
      'Set up test fixtures in a '+t+'static {}'+t+' block:'
    ].join('\n'));
    const findings=inspectSourceConsistency(f.root,[target]);
    assert.equal(findings.observations.length,2);
    const proposals=consistencyUpdateProposals(findings,'example/repo');
    assert.equal(proposals.proposals.length,1);
    const proposed=proposals.proposals[0];
    assert.equal(proposed.action,'UPDATE');
    assert.equal(proposed.kind,'SOURCE_CONSISTENCY_REVIEW');
    assert.equal(proposed.auto_apply,false);
    assert.equal(proposed.evidence.length,2);
    assert.ok(proposed.evidence.every(x=>/^[a-f0-9]{64}$/.test(x.sha256)));
    assert.deepEqual(proposed.source,proposed.target);
    const catalog=buildReviewCatalog(proposals);
    assert.equal(catalog.items[0].readiness,'MANUAL_ONLY');
    const plan=planHumanSelection(catalog,{mode:'ALL'});
    assert.equal(plan.write_authorized,false);
    assert.equal(plan.ready_for_final_confirmation,false);
    assert.ok(plan.blockers.some(x=>x.type==='MANUAL_PREPARATION_REQUIRED'));
  }finally{f.cleanup();}
});

test('invalid or absent source hashes cannot become a selectable UPDATE proposal',()=>{
  const f=fixture();
  try {
    const found=inspectSourceConsistency(f.root,[skill('none','# Title\nAlways review before coding.')]);
    assert.deepEqual(consistencyUpdateProposals(found,'example/repo').proposals,[]);
    assert.throws(()=>consistencyUpdateProposals({...found,observations:[{
      kind:'TYPE_PROPERTY_MISMATCH',skill:'x',skill_path:'../escape',skill_line:1,
      suggested_action:'REVIEW_UPDATE',source:{path:'a.ts',sha256:'nonsense'}
    }]},'example/repo'),/Missing source snapshot/);
  }finally{f.cleanup();}
});
