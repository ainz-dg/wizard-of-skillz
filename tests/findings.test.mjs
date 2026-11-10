import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveFindings} from '../src/findings.mjs';

function claims(consumer,provider){
  return [
    {id:'rule:sdk',skill:'mixed-rule',statement:'The SDK exposes `loadEntry`.',
      verification:'SUPPORTED',knowledge_class:'sdk-contract',owner:provider,
      applicability:'sdk-consumer',evidence:[{repo:provider,path:'src/api.mjs'}]},
    {id:'rule:local',skill:'mixed-rule',statement:'Use the local wrapper for UI calls.',
      verification:'SUPPORTED',knowledge_class:'repo-domain',owner:consumer,
      applicability:'repo-local',evidence:[{repo:consumer,path:'src/ui.mjs'}]}
  ];
}

test('same-repository supported claims do not produce directional promotion or split recommendations',()=>{
  const repo='org/repo';
  const result=deriveFindings(claims(repo,repo),{consumerRepo:repo,providerRepo:repo});
  assert.deepEqual(result.map(x=>x.type),['REVIEW_REQUIRED','LOCAL_CONVENTION']);
  assert.equal(result.some(x=>x.type==='PROMOTION_CANDIDATE'||x.type==='SPLIT_CANDIDATE'),false);
  assert.ok(result[0].review_flags.includes('SINGLE_REPOSITORY_PROVIDER_NOT_DISTINCT'));
  assert.equal(result[0].recommendation,'VERIFY_BEFORE_EDIT');
});

test('cross-repository promotion and split findings retain existing behavior',()=>{
  const result=deriveFindings(claims('org/consumer','org/provider'),{
    consumerRepo:'org/consumer',providerRepo:'org/provider'
  });
  assert.deepEqual(result.map(x=>x.type),['PROMOTION_CANDIDATE','LOCAL_CONVENTION','SPLIT_CANDIDATE']);
  assert.equal(result[0].recommendation,'VERIFY_SDK_OWNER_BEFORE_PROMOTE');
  assert.equal(result[2].recommendation,'SPLIT');
});
