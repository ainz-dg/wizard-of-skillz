import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {createLocalScan} from '../src/local-scan.mjs';
import {CodexAgentAdapter,agentProviders,createAgentHarness,loadWizardSkill} from '../src/agent-harness.mjs';
import {agentReviewPrompt,parseAgentReview} from '../src/agent-review.mjs';
import {runReviewTui} from '../src/review-tui.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const fixture=path.join(here,'fixtures/agent-first-css-tokens');
const skillPath='.agents/skills/theme-tokens/SKILL.md';
const source=fs.readFileSync(path.join(fixture,skillPath),'utf8');
const line=source.split(/\r?\n/).findIndex(x=>x.includes('add or update its local token'))+1;
const initialReplacement=`---\nname: theme-tokens\ndescription: Use shared theme tokens.\n---\n\n# Theme tokens\n\nConsume the supported custom properties exported by @sample-foundation/theme-tokens.\nDo not add duplicate application color tokens to src/theme.css.\n`;
const revisedReplacement=`---\nname: theme-tokens\ndescription: Use shared theme tokens.\n---\n\n# Theme tokens\n\nUse the CSS custom properties exported by @sample-foundation/theme-tokens.\nDo not maintain local copies of shared colors in src/theme.css.\n`;
const footer=items=>'```wizard-proposals\n'+JSON.stringify({recommendations:items})+'\n```';
const recommendation=replacement=>({id:'theme-tokens-update',action:'UPDATE',
  title:'Use package-owned color tokens',priority:'MEDIUM',
  rationale:'The skill assigns token ownership to the app while the package documentation assigns it to the shared package.',
  evidence:[{path:skillPath,line,quote:'When a screen needs a color, add or update its local token'}],
  risks:['Review the package export before changing consumer guidance.'],
  target_path:skillPath,replacement});
const report=replacement=>'# Overall assessment\n\nThe skill should follow the package ownership model.\n\n'+
  footer([recommendation(replacement)]);

test("Codex adapter keeps the user's CLI account and requests read-only ephemeral execution",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-agent-adapter-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=[];
  const adapter=new CodexAgentAdapter({run:async(binary,args,options)=>{
    calls.push({binary,args,options});
    const output=args[args.indexOf('--output-last-message')+1];
    if(output)fs.writeFileSync(output,'# report\n');
    return {stdout:'codex-cli 1.0\n',stderr:''};
  }});
  const skillText=loadWizardSkill();
  const prompt=agentReviewPrompt({skillText,task:'Audit only; do not edit.'});
  await adapter.reviewWorkspace({workspaceRoot:root,skillText,prompt});
  assert.equal(calls[0].binary,'codex');
  assert.ok(calls[0].args.includes('--sandbox'));
  assert.equal(calls[0].args[calls[0].args.indexOf('--sandbox')+1],'read-only');
  assert.ok(calls[0].args.includes('--ephemeral'));
  assert.ok(calls[0].args.includes('--ask-for-approval'));
  assert.equal(fs.realpathSync(calls[0].args[calls[0].args.indexOf('--cd')+1]),fs.realpathSync(root));
  assert.equal(calls[0].options.cwd,fs.realpathSync(root));
  assert.match(calls[0].options.input,/Audit only/);
  assert.match(calls[0].options.input,/SPECIALIST SKILL/);
});

test('provider boundary exposes planned harnesses without claiming they are implemented',()=>{
  assert.deepEqual(agentProviders().map(x=>[x.id,x.implemented]),[
    ['codex',true],['claude-code',false],['copilot-cli',false],['opencode',false]
  ]);
  assert.throws(()=>createAgentHarness({provider:'opencode'}),/not part of this experimental slice/);
});

test('agent proposal parser binds evidence and UPDATE target to the current workspace bytes',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-agent-parse-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.dirname(path.join(root,skillPath)),{recursive:true});
  fs.writeFileSync(path.join(root,skillPath),source);
  const parsed=parseAgentReview(report(initialReplacement),{workspaceRoot:root,repositoryId:'local/sample'});
  assert.equal(parsed.total_recommendations,1);
  assert.equal(parsed.proposals.proposals[0].action,'UPDATE');
  assert.equal(parsed.proposals.proposals[0].evidence[0].line,line);
  assert.throws(()=>parseAgentReview(report(initialReplacement).replace(skillPath,'../secret/SKILL.md'),
    {workspaceRoot:root,repositoryId:'local/sample'}),/Unsafe evidence path|Missing or unsafe/);
});

function setup(t){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-agent-tui-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const root=path.join(home,'sample');fs.cpSync(fixture,root,{recursive:true});
  const audit=path.join(home,'audit');createLocalScan(root,{out:audit});
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
  let screen='';const output={isTTY:true,rows:32,columns:100,write(value){screen=value;}};
  const key=(name)=>input.emit('keypress',name==='return'? '\r':name,{name});
  const type=value=>{for(const ch of value)input.emit('keypress',ch,{name:ch});};
  return {home,root,audit,input,output,key,type,screen:()=>screen};
}
const waitFor=async(predicate,label)=>{
  const until=Date.now()+5000;
  while(Date.now()<until){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail('Timed out waiting for '+label);
};
async function runAgentThroughReview(t,{apply=false}={}){
  const x=setup(t);let reviewCalls=0;
  const task=runReviewTui(x.audit,{consumerRoot:x.root,input:x.input,output:x.output,
    agentFactory:()=>({
      doctor:async()=>({ok:true,version:'codex 0.163.0',auth:'configured local CLI'}),
      reviewWorkspace:async()=>({provider:'codex',model:'fixture-agent',skill_sha256:'test',
        report:++reviewCalls===1?report(initialReplacement):
          '# Follow-up\n\nPackage export was confirmed from the fixture.\n\n'+
            '```wizard-revision\n'+JSON.stringify({rationale:'Confirmed.',replacement:revisedReplacement})+'\n```'})
    })});
  try{
    assert.match(x.screen(),/COSA VUOI FARE/);
    assert.match(x.screen(),/Revisione agent-first/);
    assert.match(x.screen(),/❯ Revisione agent-first/);
    x.key('return');
    assert.match(x.screen(),/Scegli un harness disponibile/);
    x.key('1');await waitFor(()=>x.screen().includes('Modello Codex'), 'Codex doctor');
    x.key('return');assert.match(x.screen(),/Provider: Codex CLI/);
    x.key('y');await waitFor(()=>x.screen().includes('REPORT AGENT-FIRST'),'agent report');
    assert.equal(reviewCalls,1);
    x.key('return');assert.match(x.screen(),/REVISIONE ·/);
    assert.match(x.screen(),/Use package-owned color tokens/);
    x.key('c');assert.match(x.screen(),/CHIARIMENTO \/ REVISIONE/);
    x.type('Confirm the package export and tighten the replacement.');x.key('return');
    await waitFor(()=>x.screen().includes('diff.'),'agent follow-up diff');
    assert.equal(reviewCalls,2);
    for(let i=0;i<14;i++)x.key('down');
    assert.match(x.screen(),/ANTEPRIMA/);
    assert.match(x.screen(),/Do not maintain local copies/);
    x.key('escape');
    if(apply){
      x.key('space');x.key('g');
      await waitFor(()=>x.screen().includes('Y APPLICA'),'Apply confirmation');
      x.key('y');await waitFor(()=>x.screen().includes('APPLICATE')||x.screen().includes('Applicate'),
        'guarded Apply completion');
      assert.match(fs.readFileSync(path.join(x.root,skillPath),'utf8'),/Do not maintain local copies/);
    }else{
      x.key('space');x.key('g');await waitFor(()=>x.screen().includes('Y APPLICA'),'Apply confirmation');
      x.key('escape');assert.equal(fs.readFileSync(path.join(x.root,skillPath),'utf8'),source);
    }
    assert.equal(reviewCalls,2);
    assert.equal(fs.readFileSync(path.join(x.root,'src/theme.css'),'utf8'),
      fs.readFileSync(path.join(fixture,'src/theme.css'),'utf8'));
  }finally{x.key('escape');x.key('q');await task;}
}

test('agent-first TUI: audit, focused revision, diff, then cancel with no source writes',async t=>{
  await runAgentThroughReview(t,{apply:false});
});

test('agent-first TUI: explicit guarded Apply updates only the synthetic skill',async t=>{
  await runAgentThroughReview(t,{apply:true});
});
