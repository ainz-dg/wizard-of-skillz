import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {runReviewTui} from '../src/review-tui.mjs';
import {initialProviderSelection,providerDescription,validateProviderSelection}
  from '../src/tui-provider.mjs';

function project(){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-tui-provider-'));
  const root=path.join(home,'source'),folder=path.join(home,'audit');
  fs.mkdirSync(path.join(root,'.agents/skills/demo'),{recursive:true});
  fs.mkdirSync(folder);
  const relative='.agents/skills/demo/SKILL.md';
  const original='---\nname: demo\ndescription: test\n---\nOld rule.\n';
  const revised=original.replace('Old rule.','New rule.');
  fs.writeFileSync(path.join(root,relative),original);
  fs.writeFileSync(path.join(folder,'repair-proposals.json'),JSON.stringify({
    consumer_repo:'example/source',
    proposals:[{id:'repair-1',action:'UPDATE',title:'Replace old rule',
      source:{repo:'example/source',path:relative},
      target:{repo:'example/source',path:relative},evidence:[],reason:'Old wording'}]
  }));
  return {home,root,folder,relative,original,revised};
}
function terminal(){
  const input=new PassThrough();
  input.isTTY=true;const raw=[];
  input.setRawMode=v=>raw.push(v);
  const output={isTTY:true,columns:120,rows:32,text:'',
    write(s){this.text+=s;}};
  const key=(name,value)=>{
    const ch=value??(name==='return'?'\r':name==='space'?' ':name);
    input.emit('keypress',ch,{name});
  };
  const type=(value)=>{for(const ch of value)key(ch);};
  return {input,output,raw,key,type};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const cleanup=p=>fs.rmSync(p.home,{force:true,recursive:true});

test('default Copilot selection is visible, no provider invoked on TUI startup',async()=>{
  const p=project(),t=terminal();const created=[];
  try{
    const session=runReviewTui(p.folder,{consumerRoot:p.root,
      input:t.input,output:t.output,providerFactory:options=>{
        created.push(options);return {};
      }});
    assert.match(t.output.text,/Copilot · auto/);
    assert.equal(created.length,0);
    t.key('l');
    assert.match(t.output.text,/1  GitHub Copilot/);
    assert.match(t.output.text,/2  Ollama locale/);
    assert.match(t.output.text,/3  Ollama remoto/);
    t.key('1');
    assert.match(t.output.text,/Modello Copilot/);
    assert.equal(created.length,0);
    t.key('return');
    assert.match(t.output.text,/Provider scelto: Copilot/);
    assert.equal(created.length,0);
    t.key('q');await session;
    assert.deepEqual(created,[]);
    assert.equal(fs.readFileSync(path.join(p.root,p.relative),'utf8'),p.original);
  }finally{cleanup(p);}
});

test('L → Ollama local → enter model, M sends only after separate human keypress',async()=>{
  const p=project(),t=terminal();const configs=[],calls=[];
  try{
    const session=runReviewTui(p.folder,{consumerRoot:p.root,
      input:t.input,output:t.output,providerFactory:opts=>{
        configs.push(opts);
        return {completeJson:async payload=>{
          calls.push(payload);return {status:'READY',content:p.revised};
        },close:async()=>{}};
      }});
    t.key('l');t.key('2');
    t.type('qwen3:8b');t.key('return');
    assert.match(t.output.text,/Ollama locale/);
    assert.match(t.output.text,/qwen3:8b/);
    assert.equal(configs.length,0);
    t.key('down');t.key('return');
    assert.equal(calls.length,0);
    t.key('m');await tick();await tick();
    assert.equal(configs.length,1);
    assert.equal(configs[0].provider,'ollama');
    assert.equal(configs[0].model,'qwen3:8b');
    assert.equal(configs[0].baseUrl,'http://127.0.0.1:11434/v1');
    assert.equal(calls.length,1);
    assert.equal(fs.readFileSync(path.join(p.root,p.relative),'utf8'),p.original);
    t.key('q');await session;
  }finally{cleanup(p);}
});

test('remote server URL and model are edited inline; TAB lists models on demand only',async()=>{
  const p=project(),t=terminal();const configs=[];let doctors=0,generated=0;
  try{
    const session=runReviewTui(p.folder,{consumerRoot:p.root,
      input:t.input,output:t.output,providerFactory:opts=>{
        configs.push({...opts});
        return {doctor:async()=>{doctors++;return {
          models:[{name:'gemma3:4b'},{name:'qwen3:8b'}]};},
        completeJson:async()=>{generated++;return {status:'READY',content:p.revised};},
        close:async()=>{}};
      }});
    t.key('l');t.key('3');
    assert.match(t.output.text,/Indirizzo server Ollama remoto/);
    t.type('ai-box:11434/v1');t.key('return');
    assert.match(t.output.text,/Modello Ollama/);
    assert.equal(doctors,0);
    t.key('tab');await tick();await tick();
    assert.equal(doctors,1);
    assert.equal(generated,0);
    assert.equal(configs.length,1);
    assert.equal(configs[0].baseUrl,'http://ai-box:11434/v1');
    assert.match(t.output.text,/gemma3:4b/);
    t.key('down');t.key('return');
    assert.match(t.output.text,/Ollama remoto/);
    assert.match(t.output.text,/qwen3:8b/);
    assert.equal(generated,0);
    t.key('down');t.key('return');t.key('m');await tick();await tick();
    assert.equal(generated,1);
    assert.equal(configs[1].baseUrl,'http://ai-box:11434/v1');
    assert.equal(configs[1].model,'qwen3:8b');
    assert.equal(fs.readFileSync(path.join(p.root,p.relative),'utf8'),p.original);
    t.key('q');await session;
  }finally{cleanup(p);}
});

test('escape cancels pending provider; invalid URL is not activated and no models called',async()=>{
  const p=project(),t=terminal();let created=0;
  try{
    const session=runReviewTui(p.folder,{consumerRoot:p.root,
      input:t.input,output:t.output,providerFactory:()=>{created++;return {};}});
    t.key('l');t.key('3');
    t.type('user:pass@host/v1');t.key('return');
    assert.match(t.output.text,/LLM: Endpoint/);
    assert.match(t.output.text,/senza credenziali/);
    t.key('escape');
    assert.match(t.output.text,/Copilot · auto/);
    assert.equal(created,0);
    t.key('q');await session;
  }finally{cleanup(p);}
});

test('pure selection validation distinguishes default, local, remote, malformed',()=>{
  const defaultConfig=initialProviderSelection({});
  assert.deepEqual(defaultConfig,{provider:'copilot',model:'auto',baseUrl:null});
  const ollama=initialProviderSelection({provider:'ollama',model:'qwen3:8b'});
  assert.match(providerDescription(ollama),/Ollama locale/);
  assert.equal(validateProviderSelection(ollama),ollama);
  assert.throws(()=>validateProviderSelection({...ollama,model:''}),/modello/);
  assert.throws(()=>validateProviderSelection({...ollama,baseUrl:'file:///etc/passwd'}),
    /Endpoint http/);
  assert.throws(()=>validateProviderSelection({...ollama,
    baseUrl:'https://user:secret@example.com/v1'}),/senza credenziali/);
});


test('Copilot TAB discovers SDK model IDs including auto, without generating',async()=>{
  const p=project(),t=terminal();const configs=[];let doctors=0,generated=0;
  try{
    const session=runReviewTui(p.folder,{consumerRoot:p.root,
      input:t.input,output:t.output,providerFactory:opts=>{
        configs.push({...opts});
        return {doctor:async()=>{
          doctors++;
          return {provider:'copilot',models:[
            {id:'gpt-5.6',name:'GPT 5.6'},
            {id:'claude-sonnet-test',name:'Claude Sonnet test'}]};
        },completeJson:async()=>{generated++;return {status:'READY',content:p.revised};},
        close:async()=>{}};
      }});
    t.key('l');t.key('1');
    assert.match(t.output.text,/Modello Copilot/);
    assert.equal(doctors,0);
    assert.equal(configs.length,0);
    t.key('tab');await tick();await tick();
    assert.equal(doctors,1);
    assert.equal(generated,0);
    assert.match(t.output.text,/Modelli disponibili tramite il tuo account Copilot/);
    assert.match(t.output.text,/gpt-5\.6/);
    assert.match(t.output.text,/claude-sonnet-test/);
    assert.equal(configs[0].provider,'copilot');
    assert.equal(configs[0].model,'');
    // auto is index 0, the SDK model ID is index 1
    t.key('down');t.key('return');
    assert.match(t.output.text,/Copilot · gpt-5\.6/);
    assert.equal(generated,0);
    t.key('down');t.key('return');t.key('m');await tick();await tick();
    assert.equal(generated,1);
    assert.equal(configs[1].provider,'copilot');
    assert.equal(configs[1].model,'gpt-5.6');
    assert.equal(fs.readFileSync(path.join(p.root,p.relative),'utf8'),p.original);
    t.key('q');await session;
  }finally{cleanup(p);}
});

test('Copilot auto remains selectable even without a model-list lookup',async()=>{
  const p=project(),t=terminal();let calls=0;
  try{
    const session=runReviewTui(p.folder,{consumerRoot:p.root,input:t.input,
      output:t.output,providerFactory:()=>{calls++;return {};}});
    t.key('l');t.key('1');
    assert.match(t.output.text,/auto/);
    t.key('return');
    assert.match(t.output.text,/Copilot · auto/);
    assert.equal(calls,0);
    t.key('q');await session;
  }finally{cleanup(p);}
});

test('Copilot model lookup failure preserves user-selected provider and never generates',async()=>{
  const p=project(),t=terminal();let generated=0,doctors=0;
  try{
    const session=runReviewTui(p.folder,{consumerRoot:p.root,input:t.input,
      output:t.output,providerFactory:()=>({
        doctor:async()=>{doctors++;throw Error('Not signed in');},
        completeJson:async()=>{generated++;return {};},
        close:async()=>{}
      })});
    t.key('l');t.key('1');t.key('tab');
    await tick();await tick();
    assert.equal(doctors,1);
    assert.match(t.output.text,/Not signed in/);
    t.key('return');
    assert.match(t.output.text,/Copilot · auto/);
    assert.equal(generated,0);
    t.key('q');await session;
  }finally{cleanup(p);}
});
