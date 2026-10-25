/**
 * Tiny, state-derived menu for the guided overview.
 * Navigation changes only the focused action; it never invokes an LLM or writes files.
 */
export function overviewActions({hasSemanticReport=false,modelConfigured=false,
  providerPickerEnabled=false,proposalCount=0,modelLabel='not configured',
  canChooseProject=false,canUseDomain=false,projectLabel='current directory'}={}){
  const actions=[];
  if(hasSemanticReport){
    actions.push({
      id:'results',title:'Esamina i risultati dell’analisi',
      description:'Leggi le ipotesi del modello e le citazioni verificabili.'
    });
  }else if(modelConfigured){
    actions.push({
      id:'audit',title:'Analizza le skill con l’AI',
      description:'Invia le istruzioni e frammenti di codice al modello: '+modelLabel+'.'
    });
  }
  actions.push({
    id:'proposals',title:'Esamina le proposte locali ('+proposalCount+')',
    description:proposalCount?
      'Prepara e revisiona le modifiche senza applicarle automaticamente.':
      'Nessuna proposta strutturale: puoi comunque aprire l’elenco.'
  });
  if(providerPickerEnabled)actions.push({
    id:'provider',title:'Cambia modello',
    description:'Seleziona Copilot, Ollama, Codex o Claude Code per questa sessione.'
  });
  if(canUseDomain)actions.push({
    id:'domain',title:'Crea e verifica skill dalle risorse documentali',
    description:'Leggi fonti, prepara bozze con citazioni e revisionale prima di installarle.'
  });
  if(canChooseProject)actions.push({
    id:'project',title:'Scegli il progetto da analizzare',
    description:'Repository attivo: '+projectLabel+'. Nessuna modifica ai file.'
  });
  return actions;
}
export function activeOverviewChoice(actions,chosen=null){
  return actions.find(a=>a.id===chosen)??actions[0]??null;
}
export function moveOverviewChoice(actions,chosen,delta){
  if(!actions.length)return null;
  const active=activeOverviewChoice(actions,chosen);
  const next=Math.max(0,Math.min(actions.length-1,
    actions.findIndex(a=>a.id===active.id)+delta));
  return actions[next].id;
}
