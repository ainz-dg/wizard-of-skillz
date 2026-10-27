/**
 * Ollama provider. Reuses the existing OpenAI-compatible transport for
 * inference; adds a local-server default and model-discovery diagnostics.
 * No SDK, implicit model pull, daemon startup or filesystem access.
 */
import {OpenAICompatibleClient} from './llm-client.mjs';

const DEFAULT_URL='http://127.0.0.1:11434/v1';

function endpoints(value){
  const input=String(value??DEFAULT_URL).trim().replace(/\/+$/,'');
  let uri;
  try{uri=new URL(input);}catch{throw Error('Invalid Ollama URL; expected http(s)://host[:port]/v1');}
  if(!['http:','https:'].includes(uri.protocol)||uri.username||uri.password||
    uri.search||uri.hash)
    throw Error('Ollama URL must be http(s) without credentials, query or fragment');
  let prefix=uri.pathname.replace(/\/+$/,'');
  if(prefix===''||prefix==='/')prefix='';
  else if(prefix.endsWith('/v1'))prefix=prefix.slice(0,-3);
  else throw Error('Ollama URL must end in /v1 or be a server root');
  const host=uri.origin;
  return {chatUrl:host+prefix+'/v1',tagsUrl:host+prefix+'/api/tags'};
}

export class OllamaClient {
  constructor({
    baseUrl=DEFAULT_URL,model=null,timeoutMs=120000,
    temperature=0,jsonMode=true,reasoningEffort=null,apiKey=null,fetchImpl=globalThis.fetch
  }={}){
    if(typeof fetchImpl!=='function')throw Error('fetch is not available');
    const resolved=endpoints(baseUrl);
    this.provider='ollama';
    this.auth=apiKey?'api-key':'none';
    this.model=model??null;
    this.baseUrl=resolved.chatUrl;
    this.tagsUrl=resolved.tagsUrl;
    this.timeoutMs=Number(timeoutMs);
    this.fetchImpl=fetchImpl;
    if(!Number.isFinite(this.timeoutMs)||this.timeoutMs<=0)
      throw Error('Ollama timeout must be a positive number of milliseconds');
    this.transport=this.model?new OpenAICompatibleClient({
      baseUrl:this.baseUrl,model:this.model,apiKey,
      timeoutMs:this.timeoutMs,temperature,jsonMode,reasoningEffort,fetchImpl
    }):null;
    this.apiKey=apiKey;
  }

  async completeJson({system,user}){
    if(!this.transport)
      throw Error('Ollama requires --llm-model <name> (or WIZARD_LLM_MODEL). Run wizard doctor --llm-provider ollama to list installed models.');
    return this.transport.completeJson({system,user});
  }

  async doctor(){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    let response;
    try{
      response=await this.fetchImpl(this.tagsUrl,{
        method:'GET',
        headers:this.apiKey?{authorization:'Bearer '+this.apiKey}:{},
        signal:controller.signal
      });
      if(!response.ok)throw Error('HTTP '+response.status);
      const payload=await response.json();
      if(!Array.isArray(payload?.models))
        throw Error('Ollama returned an invalid /api/tags response');
      const models=payload.models.filter(m=>typeof m?.name==='string'&&m.name).map(m=>({
        name:m.name,model:typeof m.model==='string'?m.model:m.name,
        size:typeof m.size==='number'?m.size:null
      }));
      return {ok:true,provider:'ollama',auth:this.auth,
        base_url:this.baseUrl,requested_model:this.model,
        model_available:this.model?models.some(m=>m.name===this.model||m.model===this.model):null,
        models};
    }catch(error){
      throw Error('Cannot query Ollama models at '+this.tagsUrl+
        '. Check that Ollama is running and --llm-url is correct. ('+
        (controller.signal.aborted?'request timed out':error.message)+')');
    }finally{clearTimeout(timer);}
  }
}
