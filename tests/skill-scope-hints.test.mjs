import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeSkillScope, skillScopeMarkdown, renderScopeReviewSection} from '../src/skill-scope-hints.mjs';

const skills=[{
  id:'testing-guidance',path:'.agents/skills/testing-guidance/SKILL.md',
  text:'---\nname: testing-guidance\ndescription: Testing guidance\n---\n'
}];
const ids={consumerRepo:'test/consumer',providerRepo:'test/provider'};
const claim=(id,overrides={})=>({
  id,stable_id:'stable-'+id,skill:'testing-guidance',
  skill_path:skills[0].path,source_path:skills[0].path,
  source_line_start:5,statement:'Claim '+id,
  verification:'SUPPORTED',knowledge_class:'sdk-contract',
  owner:'test/provider',applicability:'shared',
  verification_basis:'CITATION_ONLY',
  ...overrides
});
const inspect=(claims,skillSet=skills)=>analyzeSkillScope({skills:skillSet,claims,...ids});

test('provider-only classified claims suggest broader scope without inventing a destination',()=>{
  const result=inspect([claim('p1')]);
  assert.equal(result.hints.length,1);
  const h=result.hints[0];
  assert.equal(h.kind,'BROADER_SCOPE_CANDIDATE');
  assert.deepEqual(h.directions,['BROADER_FOR_PROVIDER_CLAIMS']);
  assert.equal(h.target,null);
  assert.equal(h.target_known,false);
  assert.equal(h.confidence,'TENTATIVE');
  assert.equal(h.proof,'AUDIT_CLASSIFICATION_ONLY');
  assert.equal(h.current.repo,'test/consumer');
  assert.match(h.current.sha256,/^[a-f0-9]{64}$/);
  assert.equal(h.provider_claims[0].verification_basis,'CITATION_ONLY');
  assert.equal(h.write_authorized,false);
  assert.equal(result.write_authorized,false);
  assert.match(skillScopeMarkdown(result),/scope più alto/);
  assert.match(skillScopeMarkdown(result),/non determinata/);
});

test('mixed provider and repo-local claims suggest split with narrower local scope, not whole-skill MOVE',()=>{
  const result=inspect([
    claim('p1'),
    claim('l1',{owner:'test/consumer',knowledge_class:'repo-domain',applicability:'repo-local'}),
    claim('u1',{verification:'NOT_CHECKED',owner:'test/provider'})
  ]);
  const h=result.hints[0];
  assert.equal(h.kind,'SPLIT_SCOPE_CANDIDATE');
  assert.deepEqual(h.directions,['BROADER_FOR_PROVIDER_CLAIMS','NARROWER_FOR_LOCAL_CLAIMS']);
  assert.equal(h.local_claims[0].claim_id,'l1');
  assert.equal(h.unresolved_claim_count,1);
  assert.equal(h.suggested_action,'REVIEW_SCOPE');
  assert.equal(h.target,null);
  assert.equal(h.write_authorized,false);
  assert.match(skillScopeMarkdown(result),/separare scope condiviso e scope locale/);
  assert.ok(h.limits.some(x=>x.includes('Moving the entire skill')));
});

test('no verified provider ownership abstains rather than guessing direction',()=>{
  assert.deepEqual(inspect([]).hints,[]);
  assert.deepEqual(inspect([claim('u',{verification:'NEEDS_REVIEW'})]).hints,[]);
  assert.deepEqual(inspect([claim('local',{
    owner:'test/consumer',knowledge_class:'repo-domain',applicability:'repo-local'
  })]).hints,[]);
  assert.deepEqual(inspect([claim('wrong',{owner:'test/provider',knowledge_class:'repo-domain'})]).hints,[]);
  assert.match(skillScopeMarkdown(inspect([])),/Nessun indizio/);
});

test('does not attribute claims to skills sharing a name at different paths',()=>{
  const other={...skills[0],path:'.github/skills/testing-guidance/SKILL.md',text:'other'};
  const report=inspect([claim('p1')],[...skills,other]);
  assert.equal(report.hints.length,1);
  assert.equal(report.hints[0].current.path,skills[0].path);
});

test('scope analysis rejects ambiguous repository and incomplete skill evidence',()=>{
  assert.throws(()=>analyzeSkillScope({skills,claims:[],consumerRepo:'same',providerRepo:'same'}),/distinct/);
  assert.throws(()=>inspect([], [{id:'test',path:'broken'}]),/exact skill text/);
  assert.throws(()=>skillScopeMarkdown({hints:[],schema_version:1,write_authorized:true}),/Invalid/);
});

test('explicit shared deployment identifies an all-local skill as narrower even without provider promotion',()=>{
  const local=claim('local',{
    owner:'test/consumer',knowledge_class:'repo-domain',applicability:'repo-local'
  });
  assert.equal(inspect([local]).hints.length,0); // Normal repo install is already appropriately local.
  const shared=analyzeSkillScope({skills,claims:[local],...ids,installedScope:'shared'});
  assert.equal(shared.installed_scope,'shared');
  assert.equal(shared.hints.length,1);
  const hint=shared.hints[0];
  assert.equal(hint.kind,'NARROWER_SCOPE_CANDIDATE');
  assert.deepEqual(hint.directions,['NARROWER_FOR_LOCAL_CLAIMS']);
  assert.equal(hint.installed_scope,'shared');
  assert.equal(hint.installed_scope_basis,'EXPLICIT_SHARED_INSTALLATION');
  assert.equal(hint.target,null);
  assert.equal(hint.target_known,false);
  assert.equal(hint.suggested_action,'REVIEW_SCOPE');
  assert.equal(hint.provider_claims.length,0);
  assert.equal(hint.local_claims[0].claim_id,'local');
  assert.equal(hint.write_authorized,false);
  assert.match(skillScopeMarkdown(shared),/scope più specifico \/ locale/);
  assert.match(skillScopeMarkdown(shared),/non determinata/);
});

test('unclassified or stale claims prevent claiming a purely local scope',()=>{
  const local=claim('local',{
    owner:'test/consumer',knowledge_class:'repo-domain',applicability:'repo-local'
  });
  const nonLocal=claim('unknown',{verification:'NEEDS_REVIEW'});
  const shared=claims=>analyzeSkillScope({skills,claims,...ids,installedScope:'shared'});
  assert.deepEqual(shared([local,nonLocal]).hints,[]);
  assert.deepEqual(shared([claim('weak',{
    owner:'test/consumer',knowledge_class:'repo-domain',
    applicability:'repo-local',verification:'NOT_CHECKED'
  })]).hints,[]);
  assert.deepEqual(shared([]).hints,[]);
  assert.throws(()=>analyzeSkillScope({
    skills,claims:[local],...ids,installedScope:'global'
  }),/repo or shared/);
});

test('mixed ownership at shared installation remains SPLIT, not narrower-only',()=>{
  const all=analyzeSkillScope({skills,claims:[
    claim('provider'),
    claim('consumer',{owner:'test/consumer',knowledge_class:'repo-domain',applicability:'repo-local'})
  ],...ids,installedScope:'shared'});
  assert.equal(all.hints[0].kind,'SPLIT_SCOPE_CANDIDATE');
  assert.deepEqual(all.hints[0].directions,[
    'BROADER_FOR_PROVIDER_CLAIMS','NARROWER_FOR_LOCAL_CLAIMS'
  ]);
});


test('pending review summarizes scope direction, provenance, claim IDs and human next step without checkboxes',()=>{
  const report=inspect([claim('provider')]);
  const section=renderScopeReviewSection(report);
  assert.match(section,/## Diagnosi di scope — non selezionabili/);
  assert.match(section,/Valutare uno scope più alto/);
  assert.match(section,/test\/consumer:.agents\/skills\/testing-guidance\/SKILL.md/);
  assert.match(section,/SHA-256 [a-f0-9]{64}/);
  assert.match(section.replaceAll(String.fromCharCode(92),''),/DEFAULT_REPOSITORY_INSTALLATION/);
  assert.match(section,/Claim provider: provider/);
  assert.match(section,/Claim locali: nessuno/);
  assert.match(section,/Verificare ownership dei contratti/);
  assert.match(section,/scope-hints.md/);
  assert.match(section,/destinazione resta sconosciuta/i);
  assert.doesNotMatch(section,/\[[ x]\]/);
  assert.doesNotMatch(section,/^## \[.\]/m);
});

test('mixed and narrower reviews explain different checks without inventing MOVE',()=>{
  const mixed=inspect([
    claim('shared'),claim('local',{owner:'test/consumer',
      knowledge_class:'repo-domain',applicability:'repo-local'}),
    claim('unknown',{verification:'NOT_CHECKED'})
  ]);
  const mixedText=renderScopeReviewSection(mixed);
  assert.match(mixedText,/Valutare la separazione condiviso \/ locale/);
  assert.match(mixedText,/Claim provider: shared/);
  assert.match(mixedText,/Claim locali: local/);
  assert.match(mixedText,/Claim non risolti: 1/);
  assert.match(mixedText,/non spostare l’intera skill/);
  const narrow=analyzeSkillScope({skills,claims:[
    claim('local',{owner:'test/consumer',knowledge_class:'repo-domain',
      applicability:'repo-local'})
  ],...ids,installedScope:'shared',installedScopeBasis:'USER_LEVEL_INSTALL_PATH'});
  const text=renderScopeReviewSection(narrow);
  assert.match(text,/Valutare uno scope più specifico/);
  assert.match(text.replaceAll(String.fromCharCode(92),''),/USER_LEVEL_INSTALL_PATH/);
  assert.match(text,/Verificare installazione e consumatori/);
  assert.doesNotMatch(text,/^## \[.\]/m);
});

test('no hints add no review clutter; executable-looking scope hints fail closed',()=>{
  const empty=inspect([]);
  assert.equal(renderScopeReviewSection(empty),'');
  assert.throws(()=>renderScopeReviewSection({...empty,write_authorized:true}),/Invalid/);
  const real=inspect([claim('provider')]);
  assert.throws(()=>renderScopeReviewSection({...real,hints:[
    {...real.hints[0],target:{repo:'test/provider',path:'some/SKILL.md'}}
  ]}),/Invalid/);
  assert.throws(()=>renderScopeReviewSection({...real,hints:[
    {...real.hints[0],suggested_action:'MOVE'}
  ]}),/Invalid/);
  assert.throws(()=>renderScopeReviewSection({...real,hints:[
    {...real.hints[0],write_authorized:true}
  ]}),/Invalid/);
});

test('untrusted skill headings and claim IDs cannot break review Markdown structure',()=>{
  const malicious=inspect([claim('provider')]);
  malicious.hints[0].skill='unexpected\n## [x] Approved';
  malicious.hints[0].provider_claims[0].claim_id='claim\n## [x] Approved';
  const out=renderScopeReviewSection(malicious);
  assert.doesNotMatch(out,/^## \[x\] Approved/m);
  assert.ok(out.includes('### unexpected \\#\\# \\[x\\] Approved'));
});


test('classification-only scope signals are explicitly weaker than checked source references',()=>{
  const base=inspect([claim('p')]);
  assert.equal(base.hints[0].evidence_review.status,'CLASSIFICATION_ONLY');
  assert.equal(base.summary.classification_only,1);
  assert.equal(base.summary.with_checked_references,0);
  assert.match(renderScopeReviewSection(base),/CLASSIFICATION\\_ONLY/);
  assert.match(renderScopeReviewSection(base),/Controllare le fonti dei claim/);
  const validRef={status:'VALID_REFERENCES_ONLY',independent_count:1};
  const grounded=inspect([claim('p',{evidence_integrity:validRef})]);
  assert.equal(grounded.hints[0].evidence_review.status,'SOURCE_REFERENCES_CHECKED');
  assert.equal(grounded.hints[0].evidence_review.checked_claims,1);
  assert.equal(grounded.summary.with_checked_references,1);
  assert.equal(grounded.hints[0].confidence,'TENTATIVE');
  assert.equal(grounded.hints[0].write_authorized,false);
  assert.match(renderScopeReviewSection(grounded),/SOURCE\\_REFERENCES\\_CHECKED/);
  assert.doesNotMatch(renderScopeReviewSection(grounded),/Controllare le fonti dei claim/);
  assert.match(skillScopeMarkdown(grounded),/non è prova semantica/);
});

test('partially source-linked split diagnoses do not pretend complete corroboration',()=>{
  const linked={status:'VALID_REFERENCES_ONLY',independent_count:1};
  const mixed=inspect([
    claim('p',{evidence_integrity:linked}),
    claim('l',{owner:'test/consumer',knowledge_class:'repo-domain',applicability:'repo-local'})
  ]);
  assert.equal(mixed.hints[0].kind,'SPLIT_SCOPE_CANDIDATE');
  assert.deepEqual(mixed.hints[0].evidence_review,{
    status:'PARTIAL_SOURCE_REFERENCES',checked_claims:1,total_classified_claims:2,
    note:'Verified reference existence is not proof of semantic correctness or ownership.'
  });
  assert.match(renderScopeReviewSection(mixed),/Controllare le fonti dei claim/);
});

test('conflicting classifications and invalid citations lead to explicit abstention',()=>{
  const invalid=inspect([claim('p',{
    review_flags:['INVALID_EVIDENCE_REFERENCE'],
    evidence_integrity:{status:'PARTIALLY_VALID',independent_count:1}
  })]);
  assert.deepEqual(invalid.hints,[]);
  assert.equal(invalid.summary.abstained,1);
  assert.equal(invalid.abstentions[0].reason,'INSUFFICIENT_SCOPE_EVIDENCE');
  const local=claim('local',{
    owner:'test/consumer',knowledge_class:'repo-domain',applicability:'repo-local'
  });
  const conflicting=analyzeSkillScope({skills,claims:[local,claim('c',{
    owner:'test/consumer',knowledge_class:'shared-domain',
    applicability:'repo-local',review_flags:['CLASS_SCOPE_CONFLICT']
  })],...ids,installedScope:'shared'});
  assert.deepEqual(conflicting.hints,[]);
  assert.equal(conflicting.abstentions[0].reason,'INCOMPLETE_SCOPE_EVIDENCE');
  assert.match(skillScopeMarkdown(conflicting),/INCOMPLETE_SCOPE_EVIDENCE/);
});

test('healthy repo-local classifications abstain with explicit reason',()=>{
  const report=inspect([claim('local',{
    owner:'test/consumer',knowledge_class:'repo-domain',applicability:'repo-local'
  })]);
  assert.equal(report.hints.length,0);
  assert.equal(report.summary.inspected_skills,1);
  assert.equal(report.summary.abstained,1);
  assert.equal(report.abstentions[0].reason,'ALREADY_REPOSITORY_LOCAL');
  assert.equal(renderScopeReviewSection(report),'');
});
