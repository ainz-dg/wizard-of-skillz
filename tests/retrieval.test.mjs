import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildRetrievalContext, retrieveForClaim} from '../src/retrieval.mjs';
import {analyzeClaimsWithLlm, mergeRetrievalCandidates} from '../src/semantic.mjs';
import {profileRepository} from '../src/profile.mjs';

async function fixture(run){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-retrieval-'));
  try{return await run(tmp);}finally{fs.rmSync(tmp,{recursive:true,force:true});}
}

test('snippet selection prefers bounded implementation context over an earlier comment/import',()=>fixture(tmp=>{
  const root=path.join(tmp,'repo');fs.mkdirSync(path.join(root,'src'),{recursive:true});
  const source=[
    '// fetchEntry is discussed in this comment',
    "import { fetchEntry } from './legacy.mjs';",
    ...Array.from({length:90},(_,i)=>`// unrelated note ${i}`),
    'export async function fetchEntry(id) {',
    '  return store.lookup(id);',
    '}'
  ].join('\n');
  fs.writeFileSync(path.join(root,'src/store.mjs'),source);
  const claim={id:'skill:1',statement:'Call fetchEntry for the record',identifiers:['fetchEntry']};
  const context=buildRetrievalContext({consumerRoot:root,providerRoot:root,claims:[claim]})[0];
  assert.equal(context.consumer_candidates.length,0);
  assert.equal(context.provider_candidates.length,1);
  const candidate=context.provider_candidates[0];
  assert.equal(candidate.path,'src/store.mjs');
  assert.equal(candidate.line,source.slice(0,source.indexOf(candidate.snippet)).split('\n').length);
  assert.match(candidate.snippet,/export async function fetchEntry/);
  assert.ok(candidate.snippet_score>=7);
  const repeated=buildRetrievalContext({consumerRoot:root,providerRoot:root,claims:[claim]})[0];
  assert.deepEqual(repeated.provider_candidates,context.provider_candidates);
}));

test('text-only retrieval keeps conservative first-match fallback and one snippet per document',()=>fixture(tmp=>{
  const root=path.join(tmp,'repo');fs.mkdirSync(root);
  const text='The fetchEntry workflow is documented here.\n'.repeat(100);
  fs.writeFileSync(path.join(root,'guide.md'),text);
  const index=[{path:'guide.md',text}];
  const result=retrieveForClaim(index,{statement:'Use fetchEntry for records',identifiers:['fetchEntry']},4);
  assert.equal(result.length,1);
  assert.equal(result[0].line,1);
  assert.ok(result[0].snippet.startsWith(text.slice(0,100)));
  assert.ok(result[0].snippet.length<=1500);
}));

test('batch merge retains the best snippet for a path, breaks ties by file score, and stays bounded',()=>{
  const merged=mergeRetrievalCandidates([
    {provider_candidates:[{path:'src/a.mjs',score:20,snippet_score:-5,snippet:'header'},
      {path:'src/b.mjs',score:3,snippet_score:2,snippet:'small'}]},
    {provider_candidates:[{path:'src/a.mjs',score:1,snippet_score:7,snippet:'implementation'},
      {path:'src/b.mjs',score:9,snippet_score:2,snippet:'better file match'}]}
  ],'provider_candidates',1);
  assert.equal(merged.length,1);
  assert.deepEqual(merged[0],{path:'src/a.mjs',score:1,snippet_score:7,snippet:'implementation'});
  const all=mergeRetrievalCandidates([
    {provider_candidates:[{path:'src/a.mjs',score:1,snippet_score:2},{path:'src/b.mjs',score:9,snippet_score:2}]}
  ],'provider_candidates');
  assert.deepEqual(all.map(x=>x.path),['src/b.mjs','src/a.mjs']);
});

test('same-root semantic path shares one candidate corpus and duplicate citations stay one source',async()=>fixture(async tmp=>{
  const root=path.join(tmp,'repo');fs.mkdirSync(path.join(root,'.agents/skills/rule'),{recursive:true});
  fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'.agents/skills/rule/SKILL.md'),'Use fetchEntry to open a record.');
  fs.writeFileSync(path.join(root,'src/store.mjs'),[
    '// fetchEntry is mentioned in this header',
    "import { fetchEntry } from './legacy.mjs';",
    'export function fetchEntry(id) { return store.lookup(id); }'
  ].join('\n'));
  const consumerProfile=profileRepository(root,'local/repo');
  const providerProfile=profileRepository(root,'local/repo');
  const claim={id:'rule:1',stable_id:'rule-hash',skill:'rule',section:'',statement:'Use fetchEntry to open a record',
    claim_kind:'domain-rule',atomicity:{status:'SINGLE_CANDIDATE'},source_path:'.agents/skills/rule/SKILL.md',
    source_line_start:1,identifiers:['fetchEntry']};
  let prompt;
  const client={provider:'fake',model:'test',completeJson:async ({user})=>{
    prompt=JSON.parse(user);
    return {claims:[{claim_id:'rule:1',verification:'NEEDS_REVIEW',knowledge_class:'repo-domain',owner:'local/repo',
      confidence:'low',reason:'Need a human to assess meaning.',evidence:[
        {repo:'local/repo',path:'src/store.mjs',symbol:'fetchEntry'},
        {repo:'local/repo',path:'src/store.mjs',symbol:'fetchEntry'}
      ]}]};
  }};
  const result=await analyzeClaimsWithLlm({client,extractedClaims:[claim],consumerProfile,providerProfile,
    consumerRoot:root,providerRoot:root,batchSize:1});
  assert.equal(prompt.shared_consumer_evidence_candidates.length,0);
  assert.equal(prompt.shared_provider_evidence_candidates.length,1);
  assert.match(prompt.shared_provider_evidence_candidates[0].snippet,/export function fetchEntry/);
  assert.equal(result.claims[0].verification,'NEEDS_REVIEW');
  assert.equal(result.claims[0].evidence.length,2);
  assert.equal(result.claims[0].evidence_integrity.independent_count,1);
  assert.equal(result.claims[0].verification_basis,'CITATION_ONLY');
}));
