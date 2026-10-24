import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkEvidenceReference, assessEvidence } from '../src/evidence-integrity.mjs';
import { applyQualityGates, qualitySummary } from '../src/quality-gates.mjs';

const consumerRepo='org/consumer', providerRepo='org/provider';
function fixture(run) {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-evidence-check-'));
  const consumerRoot=path.join(tmp,'consumer'), providerRoot=path.join(tmp,'provider');
  fs.mkdirSync(consumerRoot); fs.mkdirSync(providerRoot);
  fs.mkdirSync(path.join(consumerRoot,'skills'));
  fs.mkdirSync(path.join(providerRoot,'src'));
  fs.writeFileSync(path.join(consumerRoot,'skills/SKILL.md'),'You must call the service by name.');
  fs.writeFileSync(path.join(providerRoot,'src/Loader.java'), 'class Loader { void dispatch() {} }');
  try { return run({tmp,consumerRoot,providerRoot,consumerRepo,providerRepo,claimSourcePath:'skills/SKILL.md'}); }
  finally {fs.rmSync(tmp,{recursive:true,force:true});}
}

test('a real citation is still citation-only rather than proof of the claim',()=>fixture(options=>{
  const ev={repo:providerRepo,path:'src/Loader.java',symbol:'dispatch'};
  const check=checkEvidenceReference(ev,options);
  assert.equal(check.status,'REFERENCE_VALID');
  const integrity=assessEvidence([ev],options);
  assert.equal(integrity.status,'VALID_REFERENCES_ONLY');
  assert.equal(integrity.independent_count,1);
  assert.match(integrity.note,/no semantic entailment/);
}));

test('self-citation cannot independently establish a claim',()=>fixture(options=>{
  const x=assessEvidence([{repo:consumerRepo,path:'skills/SKILL.md',symbol:'service'}],options);
  assert.equal(x.status,'SELF_REFERENCE_ONLY');
  assert.equal(x.independent_count,0);
}));

test('rejects forged paths, nonexistent files and hallucinated symbols',()=>fixture(options=>{
  const cases=[
    [{repo:consumerRepo,path:'../provider/src/Loader.java'},'UNSAFE_PATH'],
    [{repo:consumerRepo,path:'/etc/passwd'},'UNSAFE_PATH'],
    [{repo:consumerRepo,path:'C:\\Windows\\system.ini'},'UNSAFE_PATH'],
    [{repo:consumerRepo,path:'src//File.java'},'UNSAFE_PATH'],
    [{repo:consumerRepo,path:'src/../skills/SKILL.md'},'UNSAFE_PATH'],
    [{repo:'other/repo',path:'skills/SKILL.md'},'UNKNOWN_REPOSITORY'],
    [{repo:providerRepo,path:'src/NotThere.java'},'FILE_NOT_FOUND'],
    [{repo:providerRepo,path:'src/Loader.java',symbol:'ImaginaryCall()'},'SYMBOL_NOT_FOUND'],
    [{repo:providerRepo,path:'src'},'NOT_A_FILE'],
  ];
  for(const [e,status] of cases) assert.equal(checkEvidenceReference(e,options).status,status,JSON.stringify(e));
}));

test('symlink cannot escape permitted repository root',()=>fixture(options=>{
  fs.symlinkSync(path.join(options.consumerRoot,'skills/SKILL.md'),path.join(options.providerRoot,'src/Internal.java'));
  assert.equal(checkEvidenceReference({repo:providerRepo,path:'src/Internal.java'},options).status,'OUTSIDE_REPOSITORY');
}));

test('reports missing repository roots as unavailable, not invalid',()=>{
  const x=assessEvidence([{repo:providerRepo,path:'src/Loader.java',symbol:'dispatch'}],{consumerRepo,providerRepo});
  assert.equal(x.status,'NOT_INSPECTED');
  assert.equal(x.invalid_count,0);
  assert.equal(x.unavailable_count,1);
});

test('quality gate flags invalid high-confidence supported claim rather than believing fabricated citation',()=>fixture(options=>{
  const analysis={consumer_repo:consumerRepo,provider_repo:providerRepo,claims:[{
    claim_id:'rule:1',verification:'SUPPORTED',confidence:'high',owner:providerRepo,knowledge_class:'sdk-contract',
    evidence:[{repo:providerRepo,path:'src/Loader.java',symbol:'invented'}]
  }]};
  const c=applyQualityGates(analysis,options).claims[0];
  assert.equal(c.verification,'NEEDS_REVIEW');
  assert.equal(c.confidence,'low');
  assert.equal(c.evidence_quality,'INVALID_CITATIONS');
  assert.equal(c.verification_basis,'UNVERIFIED');
  assert.ok(c.review_flags.includes('SUPPORTED_WITHOUT_VALID_CITATION'));
}));

test('valid reference does not imply semantic truth or automatic promotion',()=>fixture(options=>{
  const a=applyQualityGates({consumer_repo:consumerRepo,provider_repo:providerRepo,claims:[{
    claim_id:'rule:1',verification:'SUPPORTED',confidence:'high',knowledge_class:'sdk-contract',owner:providerRepo,
    evidence:[{repo:providerRepo,path:'src/Loader.java',symbol:'dispatch'}]
  }]},options);
  assert.equal(a.claims[0].verification,'SUPPORTED');
  assert.equal(a.claims[0].verification_basis,'CITATION_ONLY');
  assert.equal(a.claims[0].evidence_integrity.independent_count,1);
  assert.equal(qualitySummary(a).verification_basis.CITATION_ONLY,1);
}));

test('missing roots never silently downgrade a claim to contradiction',()=>{
  const a=applyQualityGates({consumer_repo:consumerRepo,provider_repo:providerRepo,claims:[{
    claim_id:'rule:1',verification:'SUPPORTED',confidence:'medium',knowledge_class:'sdk-contract',owner:providerRepo,
    evidence:[{repo:providerRepo,path:'src/Loader.java',symbol:'dispatch'}]
  }]});
  assert.equal(a.claims[0].verification,'SUPPORTED');
  assert.equal(a.claims[0].evidence_integrity.status,'NOT_INSPECTED');
  assert.ok(a.claims[0].review_flags.some(x=>x.startsWith('EVIDENCE_ROOT_UNAVAILABLE')));
});
