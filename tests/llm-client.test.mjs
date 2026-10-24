import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenAICompatibleClient, parseJsonContent } from '../src/llm-client.mjs';

test('parseJsonContent accepts fenced JSON', () => {
  assert.deepEqual(parseJsonContent('```json\n{"ok":true}\n```'), {ok:true});
});

test('OpenAI-compatible client calls chat/completions and parses JSON content', async (t) => {
  let seen;
  const server = http.createServer(async (req,res) => {
    let body='';
    for await (const chunk of req) body += chunk;
    seen = { url:req.url, auth:req.headers.authorization, body:JSON.parse(body) };
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({ choices:[{ message:{ content:'{"claims":[]}' } }] }));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => server.close());
  const {port} = server.address();
  const client = new OpenAICompatibleClient({baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:'x',model:'test-model'});
  const result = await client.completeJson({system:'s',user:'u'});
  assert.deepEqual(result,{claims:[]});
  assert.equal(seen.url,'/v1/chat/completions');
  assert.equal(seen.auth,'Bearer x');
  assert.equal(seen.body.model,'test-model');
  assert.equal(seen.body.messages[1].content,'u');
});
