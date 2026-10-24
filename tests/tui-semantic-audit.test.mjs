import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {createLocalScan} from '../src/local-scan.mjs';
import {performSemanticAudit} from '../src/tui-semantic-audit.mjs';
import {buildReviewCatalog} from '../src/review-selection.mjs';
import {inspectUpdateDraft} from '../src/review-candidates.mjs';
import {runReviewTui} from '../src/review-tui.mjs';

const ROOTS=[
  {root:new URL('./fixtures/retrieval-typescript/',import.meta.url).pathname,
    incorrect:'parseResult',correct:'createRequestOptions',
    badPath:'src/parse-result.ts',badQuote:"return 'anonymous'",
    goodPath:'src/request-options.ts',goodQuote:"Authorization: 'Bearer '"},
  {root:new URL('./fixtures/retrieval-python/',import.meta.url).pathname,
    incorrect:'normalize_timeout',correct:'normalize_path',
    badPath:'src/timeouts.py',badQuote:'return max(0, seconds)',
    goodPath:'src/paths.py',goodQuote:'return value.strip()'}
];
function setup(t,fixture){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-semantic-pilot-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const out=path.join(temp,'audit');
  createLocalScan(fixture.root,{out});
  return out;
}
function client(fixture,{malicious=false}={}){
  const calls=[];
  return {
    calls,provider:'simulated-provider',model:'fixture-model',
    async completeJson({system,user}){
      const message=JSON.parse(user);calls.push(message);
      assert.match(system,/untrusted data/);
      assert.equal(message.source_candidates.some(c=>
        c.path===message.claim.skill),false,'skill must not serve as evidence');
      const incorrect=message.claim.statement.includes(fixture.incorrect);
      const expected=incorrect?fixture.badPath:fixture.goodPath;
      const quote=incorrect?fixture.badQuote:fixture.goodQuote;
      assert.ok(message.source_candidates.some(c=>c.path===expected),
        'Expected relevant source not retrieved: '+expected);
      return {
        verdict:incorrect?'SUSPECTED_CONTRADICTION':'SUPPORTED',
        reason:incorrect?'The code differs from the described behaviour.':
          'The implementation appears consistent with the instruction.',
        citation:{path:malicious?'../secret.py':expected,quote:malicious?'invented quote':quote}
      };
    }
  };
}

for(const fixture of ROOTS){
  test('semantic pilot: '+fixture.incorrect+' suspicious, '+fixture.correct+' apparently supported',async t=>{
    const audit=setup(t,fixture);
    const model=client(fixture);
    const sourcePaths=[fixture.badPath,fixture.goodPath].map(p=>path.join(fixture.root,p));
    const before=sourcePaths.map(p=>fs.readFileSync(p));
    const report=await performSemanticAudit(audit,{consumerRoot:fixture.root,client:model});
    assert.equal(report.mode,'LLM_SEMANTIC_TRIAGE');
    assert.equal(report.semantic_proof,false);
    assert.equal(report.write_authorized,false);
    assert.equal(report.claims_total,2);
    assert.equal(report.claims_checked,2);
    assert.equal(report.proposed_updates,1);
    assert.equal(model.calls.length,2);
    const bad=report.findings.find(f=>f.statement.includes(fixture.incorrect));
    const good=report.findings.find(f=>f.statement.includes(fixture.correct));
    assert.equal(bad.assessment,'SUSPECTED_CONTRADICTION');
    assert.equal(bad.evidence.path,fixture.badPath);
    assert.equal(bad.evidence.quote,fixture.badQuote);
    assert.equal(good.assessment,'SUPPORTED_CANDIDATE');
    const proposalSet=JSON.parse(fs.readFileSync(path.join(audit,'repair-proposals.json'),'utf8'));
    const sem=proposalSet.proposals.filter(p=>p.kind==='SEMANTIC_REVIEW_CANDIDATE');
    assert.equal(sem.length,1);
    assert.equal(sem[0].action,'UPDATE');
    assert.equal(sem[0].target.path,bad.skill);
    assert.ok(sem[0].limits.some(x=>x.includes('NON')));
    const catalog=buildReviewCatalog(proposalSet);
    assert.equal(catalog.items.find(x=>x.id===sem[0].id).readiness,'MANUAL_ONLY');
    const draft=inspectUpdateDraft(audit,{consumerRoot:fixture.root,proposalIds:[sem[0].id]});
    assert.ok(draft.evidence.some(e=>e.path===fixture.badPath&&e.content.includes(fixture.badQuote)));
    assert.equal(fs.existsSync(path.join(audit,'review-candidates.json')),false);
    for(let i=0;i<sourcePaths.length;i++)assert.deepEqual(fs.readFileSync(sourcePaths[i]),before[i]);
  });
}

test('fake/model-invented citations cannot produce UPDATE hypotheses',async t=>{
  const fixture=ROOTS[0],audit=setup(t,fixture),model=client(fixture,{malicious:true});
  const report=await performSemanticAudit(audit,{consumerRoot:fixture.root,client:model});
  assert.equal(report.proposed_updates,0);
  assert.ok(report.findings.every(f=>f.assessment==='NEEDS_REVIEW'));
  const set=JSON.parse(fs.readFileSync(path.join(audit,'repair-proposals.json'),'utf8'));
  assert.equal(set.proposals.filter(p=>p.kind==='SEMANTIC_REVIEW_CANDIDATE').length,0);
});

test('rerun does not accumulate the same hypothesis, and staged work blocks rerun',async t=>{
  const fixture=ROOTS[0],audit=setup(t,fixture);
  const first=await performSemanticAudit(audit,{consumerRoot:fixture.root,client:client(fixture)});
  const second=await performSemanticAudit(audit,{consumerRoot:fixture.root,client:client(fixture)});
  assert.equal(first.proposed_updates,second.proposed_updates);
  const set=JSON.parse(fs.readFileSync(path.join(audit,'repair-proposals.json'),'utf8'));
  assert.equal(set.proposals.filter(p=>p.kind==='SEMANTIC_REVIEW_CANDIDATE').length,1);
  const digestBefore=fs.readFileSync(path.join(audit,'repair-proposals.json'),'utf8');
  fs.writeFileSync(path.join(audit,'review-candidates.json'),
    JSON.stringify({candidates:[{proposal_id:'manual'}]}));
  await assert.rejects(()=>performSemanticAudit(audit,{consumerRoot:fixture.root,client:client(fixture)}),
    /Existing staged drafts/);
  assert.equal(fs.readFileSync(path.join(audit,'repair-proposals.json'),'utf8'),digestBefore);
});

test('incomplete model results do not modify audit artifacts',async t=>{
  const fixture=ROOTS[0],audit=setup(t,fixture);
  const before=fs.readFileSync(path.join(audit,'repair-proposals.json'));
  let invoked=0;
  const broken={provider:'test',model:'test',async completeJson(){
    invoked++;throw Error('network connection lost');
  }};
  await assert.rejects(()=>performSemanticAudit(audit,{consumerRoot:fixture.root,client:broken}),
    /network connection lost/);
  assert.equal(invoked,1);
  assert.deepEqual(fs.readFileSync(path.join(audit,'repair-proposals.json')),before);
  assert.equal(fs.existsSync(path.join(audit,'semantic-audit.json')),false);
});

test('K in the TUI triggers explicit triage and J opens evidence report; no implicit model calls',async t=>{
  const fixture=ROOTS[0],audit=setup(t,fixture),model=client(fixture);
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
  const output={isTTY:true,columns:150,rows:35,output:'',write(s){this.output+=s;}};
  const key=name=>input.emit('keypress',name==='return'?'\r':name,{name});
  const session=runReviewTui(audit,{consumerRoot:fixture.root,
    input,output,providerFactory:()=>model});
  assert.equal(model.calls.length,0);
  assert.match(output.output,/Audit semantico: non ancora eseguito/);
  key('k');
  for(let n=0;n<35 && model.calls.length<2;n++)
    await new Promise(resolve=>setImmediate(resolve));
  for(let n=0;n<15&&!output.output.includes('DIAGNOSI SEMANTICA');n++)
    await new Promise(resolve=>setImmediate(resolve));
  assert.equal(model.calls.length,2);
  assert.match(output.output,/DIAGNOSI SEMANTICA/);
  assert.match(output.output,/SOSPETTA/);
  assert.ok(!fs.existsSync(path.join(audit,'review-candidates.json')));
  key('return');
  assert.match(output.output,/DETTAGLIO SEMANTICO/);
  key('escape');key('escape');
  assert.match(output.output,/Audit LLM: 2 claim/);
  key('j');
  assert.match(output.output,/DIAGNOSI SEMANTICA/);
  key('q');
  await session;
  assert.equal(fs.existsSync(path.join(audit,'apply-result.json')),false);
});


test('source skill modified mid-audit fails closed without recording stale advice',async t=>{
  const fixture=ROOTS[0];
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-semantic-drift-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const project=path.join(temp,'project');
  fs.cpSync(fixture.root,project,{recursive:true});
  const audit=path.join(temp,'audit');
  createLocalScan(project,{out:audit});
  const proposalsBefore=fs.readFileSync(path.join(audit,'repair-proposals.json'));
  const model=client(fixture);
  const originalComplete=model.completeJson.bind(model);
  model.completeJson=async input=>{
    const answer=await originalComplete(input);
    if(model.calls.length===1){
      const modified=path.join(project,'.agents/skills/parsing-contract/SKILL.md');
      fs.appendFileSync(modified,'\nThe skill changed during model analysis.\n');
    }
    return answer;
  };
  await assert.rejects(()=>performSemanticAudit(audit,{consumerRoot:project,client:model}),
    /Skill source changed/);
  assert.deepEqual(fs.readFileSync(path.join(audit,'repair-proposals.json')),proposalsBefore);
  assert.equal(fs.existsSync(path.join(audit,'semantic-audit.json')),false);
});

test('K followed by M stages manual-only semantic UPDATE; no source write without G/Y',async t=>{
  const fixture=ROOTS[0],audit=setup(t,fixture);
  const skill=path.join(fixture.root,'.agents/skills/parsing-contract/SKILL.md');
  const before=fs.readFileSync(skill,'utf8');
  const model=client(fixture);
  let drafts=0;
  const previous=model.completeJson.bind(model);
  model.completeJson=async options=>{
    if(options.system.startsWith('You draft one consolidated')){
      drafts++;
      return {status:'READY',content:before.replace(
        'must throw a TypeError for blank input names.',
        'must return anonymous for blank input names.')};
    }
    return previous(options);
  };
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
  const output={isTTY:true,columns:150,rows:36,text:'',write(value){this.text+=value;}};
  const key=name=>input.emit('keypress',name==='return'?'\r':name,{name});
  const session=runReviewTui(audit,{consumerRoot:fixture.root,
    input,output,providerFactory:()=>model});
  key('k');
  for(let n=0;n<80&&!output.text.includes('DIAGNOSI SEMANTICA');n++)
    await new Promise(resolve=>setImmediate(resolve));
  assert.match(output.text,/DIAGNOSI SEMANTICA/);
  key('escape'); // overview
  key('down');key('return'); // highlight proposals then open inbox
  assert.match(output.text,/DA PREPARARE|DA PREPAR\./);
  key('m');
  for(let n=0;n<80&&drafts===0;n++)
    await new Promise(resolve=>setImmediate(resolve));
  assert.equal(drafts,1);
  for(let n=0;n<20&&!fs.existsSync(path.join(audit,'review-candidates.json'));n++)
    await new Promise(resolve=>setImmediate(resolve));
  assert.ok(fs.existsSync(path.join(audit,'review-candidates.json')));
  assert.equal(fs.readFileSync(skill,'utf8'),before);
  key('q');await session;
  assert.equal(fs.readFileSync(skill,'utf8'),before);
});
