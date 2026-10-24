import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createLlmClient,closeLlmClient} from '../src/llm-provider.mjs';
import {OllamaClient} from '../src/ollama-client.mjs';

const exec=promisify(execFile);

async function fakeOllama(t,{models=['qwen3:8b'],status=200,delay=0}={}){
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    let body='';
    for await(const chunk of req)body+=chunk;
    requests.push({path:req.url,method:req.method,
      auth:req.headers.authorization??null,body:body?JSON.parse(body):null});
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    res.setHeader('content-type','application/json');
    if(status!==200){res.statusCode=status;res.end(JSON.stringify({error:'offline'}));return;}
    if(req.url==='/api/tags'){
      res.end(JSON.stringify({models:models.map(name=>({name,model:name,size:123}))}));
    }else if(req.url==='/v1/chat/completions'){
      res.end(JSON.stringify({choices:[{message:{content:'{"ping":"pong"}'}}]}));
    }else{res.statusCode=404;res.end('{"error":"not found"}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',requests};
}

test('Ollama provider reuses OpenAI-compatible JSON transport without Copilot SDK',async t=>{
  const {baseUrl,requests}=await fakeOllama(t);
  const client=createLlmClient({provider:'ollama',baseUrl,model:'qwen3:8b'});
  try{
    assert.equal(client.provider,'ollama');
    assert.equal(client.auth,'none');
    assert.equal(client.baseUrl,baseUrl);
    assert.deepEqual(await client.completeJson({system:'SYSTEM',user:'USER'}),{ping:'pong'});
    assert.equal(requests.length,1);
    assert.equal(requests[0].path,'/v1/chat/completions');
    assert.equal(requests[0].method,'POST');
    assert.equal(requests[0].auth,null);
    assert.equal(requests[0].body.model,'qwen3:8b');
    assert.equal(requests[0].body.response_format.type,'json_object');
    assert.equal(requests[0].body.messages[0].content,'SYSTEM');
    assert.equal(requests[0].body.messages[1].content,'USER');
  }finally{await closeLlmClient(client);}
});

test('Ollama doctor lists locally available models without requiring an LLM model',async t=>{
  const {baseUrl,requests}=await fakeOllama(t,{models:['qwen3:8b','gemma3:4b']});
  const client=createLlmClient({provider:'ollama',baseUrl});
  const report=await client.doctor();
  assert.equal(report.ok,true);
  assert.equal(report.provider,'ollama');
  assert.equal(report.requested_model,null);
  assert.deepEqual(report.models.map(x=>x.name),['qwen3:8b','gemma3:4b']);
  assert.equal(report.model_available,null);
  assert.deepEqual(requests.map(x=>x.path),['/api/tags']);
  await assert.rejects(()=>client.completeJson({system:'s',user:'u'}),
    /requires --llm-model/);
  assert.equal(requests.length,1);
});

test('Ollama model availability diagnostic is advisory and does not pull models',async t=>{
  const {baseUrl,requests}=await fakeOllama(t,{models:['installed:latest']});
  const client=createLlmClient({provider:'ollama',baseUrl,model:'another:latest'});
  const report=await client.doctor();
  assert.equal(report.model_available,false);
  assert.deepEqual(requests.map(x=>x.method),['GET']);
});

test('Ollama doctor supports server-root URL and reports errors instead of claiming healthy',async t=>{
  const {baseUrl}=await fakeOllama(t,{status:503});
  const client=new OllamaClient({baseUrl:baseUrl.slice(0,-3),model:'qwen3:8b'});
  await assert.rejects(()=>client.doctor(),/Cannot query Ollama models.*HTTP 503/);
});

test('Ollama rejects unsupported schemes and credential-bearing URLs',()=>{
  assert.throws(()=>new OllamaClient({baseUrl:'file:///tmp/model',model:'x'}),
    /Ollama URL must be http/);
  assert.throws(()=>new OllamaClient({baseUrl:'http://user:password@localhost:11434/v1',model:'x'}),
    /without credentials/);
  assert.throws(()=>new OllamaClient({baseUrl:'http://localhost:11434/api/generate',model:'x'}),
    /end in \/v1/);
});

test('OpenAI-compatible and Copilot remain independent choices',()=>{
  const openai=createLlmClient({provider:'openai-compatible',
    baseUrl:'http://127.0.0.1:1234/v1',model:'custom'});
  assert.equal(openai.provider,'openai-compatible');
  assert.equal(openai.model,'custom');
  const copilot=createLlmClient({provider:'copilot'});
  assert.equal(copilot.provider,'copilot');
  assert.equal(copilot.model,'auto');
});

test('Wizard CLI doctor and probe work with opt-in Ollama, without a Copilot login',async t=>{
  const {baseUrl,requests}=await fakeOllama(t);
  const cli=new URL('../bin/wizard.mjs',import.meta.url).pathname;
  const doctor=await exec(process.execPath,[cli,'doctor',
    '--llm-provider','ollama','--llm-url',baseUrl],{timeout:12000});
  const report=JSON.parse(doctor.stdout);
  assert.equal(report.provider,'ollama');
  assert.equal(report.models[0].name,'qwen3:8b');
  const probe=await exec(process.execPath,[cli,'probe',
    '--llm-provider','ollama','--llm-url',baseUrl,
    '--llm-model','qwen3:8b'],{timeout:12000});
  const result=JSON.parse(probe.stdout);
  assert.equal(result.provider,'ollama');
  assert.deepEqual(result.result,{ping:'pong'});
  assert.deepEqual(requests.map(r=>r.path),['/api/tags','/v1/chat/completions']);
});

test('Ollama doctor times out and names its endpoint in the diagnostic',async t=>{
  const {baseUrl}=await fakeOllama(t,{delay:90});
  const client=new OllamaClient({baseUrl,timeoutMs:15});
  await assert.rejects(()=>client.doctor(),/request timed out/);
});


test('Ollama gateway auth and JSON-mode opt-out are explicit',async t=>{
  const {baseUrl,requests}=await fakeOllama(t);
  const client=createLlmClient({
    provider:'ollama',baseUrl,model:'qwen3:8b',
    apiKey:'gateway-only',jsonMode:false
  });
  assert.equal(client.auth,'api-key');
  await client.completeJson({system:'s',user:'u'});
  assert.equal(requests[0].auth,'Bearer gateway-only');
  assert.equal(Object.hasOwn(requests[0].body,'response_format'),false);
  await client.doctor();
  assert.equal(requests[1].auth,'Bearer gateway-only');
});
