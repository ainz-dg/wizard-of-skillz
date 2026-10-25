import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runDocumentedDomain,reviewDomainResponse} from '../src/documented-domain.mjs';

function fixture(){
  const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-domain-test-'));
  const root=path.join(sandbox,'app');
  fs.mkdirSync(path.join(root,'resources'),{recursive:true});
  const text=['# Order lifecycle',
    'Before reopening a confirmed order, verify the current order status in the official register.',
    'Only an authorized operator may approve reopening after recording the business reason.',
    'Inform the commercial user whether reopening was requested, approved, or remains pending.',
    'Never claim a request was approved until the approval was actually recorded.'].join('\n');
  fs.writeFileSync(path.join(root,'resources','orders.md'),text);
  return {sandbox,root,text};
}
function fakeClient(){
  return {async completeJson({system,user}){
    assert.match(system,/Do not invent tools/);
    const payload=JSON.parse(user),doc=payload.documents[0];
    return {candidates:[{name:'review-order-reopening',
      description:'Review an order reopening request against the documented steps',
      purpose:'Guide a reviewer without automatically changing an order',
      audience:'Commercial operator',
      steps:[
        {instruction:'Verify order status',evidence:[{source_id:doc.id,quote:'Before reopening a confirmed order, verify the current order status in the official register.'}]},
        {instruction:'Obtain authorized approval',evidence:[{source_id:doc.id,quote:'Only an authorized operator may approve reopening after recording the business reason.'}]}
      ],
      communication:{terminology:['order status','commercial user'],include:['approval state'],avoid:['claiming unrecorded approval']},
      risks:['Approval must remain human-controlled']
    }],existing_reviews:[]};
  }};
}
test('resources-only repository produces review-only domain skill drafts with quote provenance',async()=>{
  const {sandbox,root}=fixture();
  try{
    const result=await runDocumentedDomain({root,resources:'resources',out:path.join(sandbox,'audit'),client:fakeClient()});
    assert.equal(result.resources_count,1);
    assert.equal(result.existing_skill_count,0);
    assert.equal(result.proposal_count,1);
    assert.equal(result.write_authorized,false);
    assert.equal(result.semantic_truth_verified,false);
    const draft=fs.readFileSync(path.join(sandbox,'audit','skill-candidates','review-order-reopening','SKILL.md'),'utf8');
    assert.match(draft,/order status/);
    assert.match(draft,/commercial user/);
    assert.match(draft,/DRAFT — human review required/);
    assert.equal(fs.existsSync(path.join(root,'skills')),false);
    assert.equal(result.source_index[0].path,'orders.md');
  }finally{fs.rmSync(sandbox,{recursive:true,force:true});}
});
test('offline domain inspection never invents skills or touches its resource root',async()=>{
  const {sandbox,root,text}=fixture();
  try{
    const result=await runDocumentedDomain({root,resources:'resources',out:path.join(sandbox,'offline')});
    assert.equal(result.model_invoked,false);
    assert.equal(result.proposal_count,0);
    assert.equal(result.verdict,'REVIEW_REQUIRED');
    assert.equal(fs.readFileSync(path.join(root,'resources','orders.md'),'utf8'),text);
  }finally{fs.rmSync(sandbox,{recursive:true,force:true});}
});
test('reject unsupported model evidence and avoid unsupported skill generation',()=>{
  const raw={candidates:[{name:'unverified-action',description:'bad',
    steps:[{instruction:'Execute an imagined API',evidence:[{source_id:'R1',quote:'Not in the source file at all'}]},
           {instruction:'Change account state',evidence:[{source_id:'R1',quote:'Invented claim about a new API.'}]}]
  }]};
  const report=reviewDomainResponse(raw,[{id:'R1',path:'policy.md',sha256:'a'.repeat(64),content:'A documented policy.'}]);
  assert.equal(report.candidates.length,0);
  assert.ok(report.issues.length>0);
});
test('refuse audit output inside the inspected repository',async()=>{
  const {sandbox,root}=fixture();
  try{
    await assert.rejects(
      runDocumentedDomain({root,resources:'resources',out:path.join(root,'audit')}),
      /outside the inspected repository/
    );
    assert.equal(fs.existsSync(path.join(root,'audit')),false);
  }finally{fs.rmSync(sandbox,{recursive:true,force:true});}
});
