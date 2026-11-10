import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inventorySkills} from '../src/skills.mjs';
import {extractClaims} from '../src/claims.mjs';

const bin=fileURLToPath(new URL('../bin/wizard.mjs',import.meta.url));
const version=JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json',import.meta.url)),'utf8')).version;
function run(...args){return spawnSync(process.execPath,[bin,...args],{encoding:'utf8'});}

test('generic CLI exposes documented version and commands',()=>{
  const a=run('--version'),b=run('--help');
  assert.equal(a.status,0,a.stderr);
  assert.equal(a.stdout.trim(),version);
  assert.equal(b.status,0,b.stderr);
  assert.match(b.stdout,/scan/);
  assert.doesNotMatch(b.stdout,/verify-preview|propose <consumer>/i);
});

test('structural scan preserves inspected project and does not call LLMs',()=>{
  const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'wizard-clean-'));
  try{
    const repo=path.join(tmp,'example');
    const file=path.join(repo,'.agents','skills','example','SKILL.md');
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const content='---\nname: example\ndescription: Synthetic fixture\n---\n# Example\n';
    fs.writeFileSync(file,content);
    const out=path.join(tmp,'report');
    const result=run('scan',repo,'--out',out);
    assert.equal(result.status,0,result.stderr);
    const summary=JSON.parse(result.stdout);
    assert.equal(summary.skill_count,1);
    assert.equal(summary.llm_used,false);
    assert.equal(summary.write_authorized,false);
    assert.equal(summary.applied_count,0);
    assert.equal(fs.readFileSync(file,'utf8'),content);
    assert.ok(fs.existsSync(path.join(out,'local-scan-summary.json')));
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('audit accepts matching identity and canonical root, writes reports, and keeps review hypotheses visible',()=>{
  const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'wizard-audit-same-'));
  try{
    const repo=path.join(tmp,'repo');
    const skill=path.join(repo,'.agents','skills','example','SKILL.md');
    fs.mkdirSync(path.dirname(skill),{recursive:true});
    fs.writeFileSync(skill,'---\nname: example\ndescription: Synthetic skill\n---\n# Example\n\nUse `loadEntry` to open a record.\n');
    fs.mkdirSync(path.join(repo,'src'),{recursive:true});
    fs.writeFileSync(path.join(repo,'src/store.mjs'),'export function loadEntry() { return null; }\n');
    const id='local/repo';
    const alias=path.join(tmp,'repo-alias');fs.symlinkSync(repo,alias,'dir');
    const analysis=path.join(tmp,'analysis.json');
    const extracted=extractClaims(inventorySkills(repo));
    assert.equal(extracted.length,1);
    fs.writeFileSync(analysis,JSON.stringify({consumer_repo:id,provider_repo:id,claims:[{
      claim_id:'example:1',verification:'NEEDS_REVIEW',knowledge_class:'repo-domain',owner:id,
      stable_id:extracted[0].stable_id,confidence:'low',reason:'synthetic unresolved hypothesis',evidence:[]
    }]}));
    const out=path.join(tmp,'audit');
    const result=run('audit',repo,'--provider',alias,'--consumer-id',id,'--provider-id',id,'--analysis',analysis,'--out',out);
    assert.equal(result.status,0,result.stderr);
    for(const file of ['analysis.json','findings.json','report.md','report-detailed.md','scope-hints.json'])
      assert.ok(fs.existsSync(path.join(out,file)),file);
    const summary=JSON.parse(fs.readFileSync(path.join(out,'triage-summary.json'),'utf8'));
    assert.equal(summary.headline.unresolved_nonpolicy_claims,1);
    assert.equal(summary.headline.confirmed_source_drift,0);
    const scope=JSON.parse(fs.readFileSync(path.join(out,'scope-hints.json'),'utf8'));
    assert.equal(scope.basis,'NOT_APPLICABLE_SINGLE_REPOSITORY');
    assert.equal(scope.write_authorized,false);
    assert.match(fs.readFileSync(path.join(out,'scope-hints.md'),'utf8'),/non applicabile/);
    assert.match(fs.readFileSync(path.join(out,'report.md'),'utf8'),/Other non-policy review hypotheses: \*\*1\*\*/);
    assert.match(fs.readFileSync(path.join(out,'report.md'),'utf8'),/No source-backed repair candidate found/);
    assert.equal(fs.readFileSync(skill,'utf8').includes('Use `loadEntry`'),true);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('audit identity and root matrix fails ambiguous pairs before constructing an LLM client',()=>{
  const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'wizard-audit-pairs-'));
  try{
    const a=path.join(tmp,'a'),b=path.join(tmp,'b'),alias=path.join(tmp,'a-alias');fs.mkdirSync(a);fs.mkdirSync(b);fs.symlinkSync(a,alias,'dir');
    const out=path.join(tmp,'out');
    const sameIdDifferentRoots=run('audit',a,'--provider',b,'--consumer-id','org/repo','--provider-id','org/repo',
      '--llm','--llm-provider','not-a-provider','--out',out);
    assert.notEqual(sameIdDifferentRoots.status,0);
    assert.match(sameIdDifferentRoots.stderr,/same identity but resolve to different repository roots/);
    assert.doesNotMatch(sameIdDifferentRoots.stderr,/unsupported.*provider|not-a-provider/i);
    const differentIdsSameRoot=run('audit',a,'--provider',alias,'--consumer-id','org/one','--provider-id','org/two',
      '--llm','--llm-provider','not-a-provider','--out',out);
    assert.notEqual(differentIdsSameRoot.status,0);
    assert.match(differentIdsSameRoot.stderr,/same repository root but have different identities/);
    assert.doesNotMatch(differentIdsSameRoot.stderr,/unsupported.*provider|not-a-provider/i);
    assert.equal(fs.existsSync(out),false);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('cross-repository audit remains valid for distinct identities and roots',()=>{
  const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'wizard-audit-cross-'));
  try{
    const consumer=path.join(tmp,'consumer'),provider=path.join(tmp,'provider');
    fs.mkdirSync(path.join(consumer,'.agents/skills/example'),{recursive:true});fs.mkdirSync(path.join(provider,'src'),{recursive:true});
    fs.writeFileSync(path.join(consumer,'.agents/skills/example/SKILL.md'),'---\nname: example\ndescription: Synthetic\n---\nUse `loadEntry` to open a record.\n');
    fs.writeFileSync(path.join(provider,'src/store.mjs'),'export function loadEntry() {}\n');
    const analysis=path.join(tmp,'analysis.json'),out=path.join(tmp,'audit');
    fs.writeFileSync(analysis,JSON.stringify({consumer_repo:'org/consumer',provider_repo:'org/provider',claims:[]}));
    const result=run('audit',consumer,'--provider',provider,'--consumer-id','org/consumer','--provider-id','org/provider','--analysis',analysis,'--out',out);
    assert.equal(result.status,0,result.stderr);
    const scope=JSON.parse(fs.readFileSync(path.join(out,'scope-hints.json'),'utf8'));
    assert.equal(scope.basis,'DIRECTIONAL_HINTS_FROM_EXISTING_AUDIT_CLASSIFICATIONS');
    assert.ok(fs.existsSync(path.join(out,'report.md')));
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('audit rejects raw batch checkpoints, mismatched identities, and mixed analysis modes',()=>{
  const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'wizard-audit-input-'));
  try{
    const repo=path.join(tmp,'repo');fs.mkdirSync(repo);
    const id='local/repo',out=path.join(tmp,'audit'),analysis=path.join(tmp,'raw.json');
    fs.writeFileSync(analysis,JSON.stringify({schema_version:1,batches:{}}));
    const raw=run('audit',repo,'--provider',repo,'--consumer-id',id,'--provider-id',id,'--analysis',analysis,'--out',out);
    assert.notEqual(raw.status,0);assert.match(raw.stderr,/analysis\.claims must be an array/);
    assert.equal(fs.existsSync(out),false);
    fs.writeFileSync(analysis,JSON.stringify({consumer_repo:'different',provider_repo:id,claims:[]}));
    const mismatch=run('audit',repo,'--provider',repo,'--consumer-id',id,'--provider-id',id,'--analysis',analysis,'--out',out);
    assert.notEqual(mismatch.status,0);assert.match(mismatch.stderr,/does not match requested identity/);
    const both=run('audit',repo,'--provider',repo,'--consumer-id',id,'--provider-id',id,'--analysis',analysis,'--llm','--out',out);
    assert.notEqual(both.status,0);assert.match(both.stderr,/choose exactly one of --llm or --analysis/);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
