/**
 * Session-only provider selection for Wizard TUI.
 * Provider configuration is never a model invocation or Apply authorization.
 */
export const LOCAL_OLLAMA_URL='http://127.0.0.1:11434/v1';

export function initialProviderSelection(options={}){
  const provider=options.provider||'copilot';
  const model=options.model??(provider==='copilot'?'auto':'');
  return {provider,model,baseUrl:options.baseUrl??(provider==='ollama'?LOCAL_OLLAMA_URL:null)};
}

export function providerDescription(config){
  if(!config)return 'non configurato';
  if(config.provider==='copilot')return 'Copilot · '+(config.model||'auto');
  if(config.provider==='ollama'){
    const url=config.baseUrl||LOCAL_OLLAMA_URL;
    const local=url==='http://127.0.0.1:11434/v1'||
      url==='http://localhost:11434/v1'||url==='http://127.0.0.1:11434'||
      url==='http://localhost:11434';
    return 'Ollama '+(local?'locale':'remoto')+' · '+(config.model||'modello da scegliere')+
      (local?'':' · '+url);
  }
  return config.provider+' · '+(config.model||'modello da scegliere');
}

export function validateProviderSelection(config,{needsModel=true}={}){
  if(!config||!['copilot','ollama','openai-compatible'].includes(config.provider))
    throw Error('Provider non supportato');
  if(needsModel&&(!config.model||typeof config.model!=='string'||!config.model.trim()))
    throw Error('Seleziona un modello prima di usare M');
  if(config.provider==='ollama'||config.provider==='openai-compatible'){
    if(typeof config.baseUrl!=='string'||!config.baseUrl.trim())
      throw Error('Indica un endpoint http(s) valido');
    let url;
    try{url=new URL(config.baseUrl);}catch{throw Error('Endpoint non valido');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||
      url.search||url.hash)
      throw Error('Endpoint http(s) senza credenziali, query o fragment');
    if(config.provider==='ollama'){
      const path=url.pathname.replace(/\/+$/,'');
      if(path&&path!=='/'&&!path.endsWith('/v1'))
        throw Error('Endpoint Ollama: usa la radice del server oppure /v1');
    }
  }
  return config;
}
