import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAnalysis} from '../src/analysis.mjs';

test('analysis input requires the analysis envelope and rejects raw checkpoints',()=>{
  assert.deepEqual(validateAnalysis({schema_version:1,batches:{}},{}),[
    'analysis.claims must be an array (raw batch checkpoints are not audit analyses)'
  ]);
  assert.deepEqual(validateAnalysis({claims:{}},{}),[
    'analysis.claims must be an array (raw batch checkpoints are not audit analyses)'
  ]);
});

test('analysis identity declarations must match the requested CLI identities',()=>{
  const errors=validateAnalysis({consumer_repo:'org/other',provider_repo:'org/provider',claims:[]},{
    consumerRepo:'org/consumer',providerRepo:'org/provider'
  });
  assert.deepEqual(errors,['analysis.consumer_repo does not match requested identity org/consumer']);
});

test('analysis envelope accepts a valid empty same-repository result',()=>{
  assert.deepEqual(validateAnalysis({consumer_repo:'org/repo',provider_repo:'org/repo',claims:[]},{
    consumerRepo:'org/repo',providerRepo:'org/repo'
  }),[]);
});
