import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

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
