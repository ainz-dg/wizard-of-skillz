import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {AccountCliClient} from '../src/account-cli-client.mjs';
import {createLlmClient} from '../src/llm-provider.mjs';
import {validateProviderSelection,providerDescription} from '../src/tui-provider.mjs';

test('Codex account provider uses unmodified CLI with read-only sandbox and temp cwd',async()=>{
  let temp=null;
  const run=async(binary,args,{input,cwd})=>{
    assert.equal(binary,'codex');assert.ok(args.includes('read-only'));
    assert.ok(args.includes('--skip-git-repo-check'));
    assert.ok(args.includes('--ask-for-approval'));
    assert.ok(args.includes('never'));
    assert.equal(args.at(-1),'-');
    assert.match(input,/Return machine-readable JSON only/);
    temp=cwd;
    fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'{"accepted":true}');
    return {stdout:'',stderr:''};
  };
  const client=new AccountCliClient({provider:'codex-account',run});
  assert.deepEqual(await client.completeJson({system:'Follow constraints',user:'Test'}),{accepted:true});
  assert.equal(fs.existsSync(temp),false);
});
test('Claude Code account provider explicitly removes tools, MCP and session persistence',async()=>{
  let temp;
  const run=async(binary,args,{cwd,input})=>{
    assert.equal(binary,'claude');
    assert.ok(args.includes('--bare'));
    assert.equal(args[args.indexOf('--tools')+1],'');
    assert.equal(args[args.indexOf('--disallowedTools')+1],'mcp__*');
    assert.ok(args.includes('--no-session-persistence'));
    assert.ok(args.includes('--disable-slash-commands'));
    assert.match(input,/Follow constraints/);
    temp=cwd;
    return {stdout:'{"accepted":true}',stderr:''};
  };
  const client=new AccountCliClient({provider:'claude-code-account',run});
  assert.deepEqual(await client.completeJson({system:'Follow constraints',user:'Test'}),{accepted:true});
  assert.equal(fs.existsSync(temp),false);
});
test('factory and TUI accept optional account providers without a model or API key',()=>{
  for(const provider of ['codex-account','claude-code-account']){
    const c=createLlmClient({provider,cliRun:async()=>({stdout:'ok',stderr:''})});
    assert.equal(c.provider,provider);
    assert.equal(c.auth,'local-cli-user-account');
    assert.equal(validateProviderSelection({provider,model:''}).provider,provider);
    assert.match(providerDescription({provider}),/account locale/);
  }
});
test('doctor only inspects existing CLI authentication status',async()=>{
  let seen;
  const c=new AccountCliClient({provider:'claude-code-account',run:async(binary,args)=>{
    seen={binary,args};return {stdout:'{}',stderr:''};
  }});
  const result=await c.doctor();
  assert.deepEqual(seen,{binary:'claude',args:['auth','status']});
  assert.equal(result.ok,true);
  assert.equal(result.auth,'local-cli-user-account');
});
