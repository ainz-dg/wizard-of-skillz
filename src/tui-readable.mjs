/**
 * Display-only line wrapping for human review. Never remove source content,
 * silently truncate a cited path, or depend on terminal color support.
 */
export function wrapTuiLines(input,width){
  const limit=Math.max(12,Math.floor(width));
  const result=[];
  for(const raw of input){
    const fragments=String(raw??'').split(/\r?\n/);
    for(const line of fragments){
      if(!line){result.push('');continue;}
      let rest=line;
      const leading=/^\s*/.exec(rest)[0];
      const continuation=leading+'  ';
      let prefix='';
      while(rest.length>limit-prefix.length){
        const max=limit-prefix.length;
        const segment=rest.slice(0,max+1);
        let split=segment.lastIndexOf(' ');
        // Prefer a nearby word break, but long source paths and code identifiers
        // must still be displayed in full, with no ellipsis.
        if(split<Math.max(10,max/3))split=max;
        result.push(prefix+rest.slice(0,split).trimEnd());
        rest=rest.slice(split).trimStart();
        prefix=continuation;
      }
      result.push(prefix+rest);
    }
  }
  return result;
}

export function evidenceDetailLines(item,semanticAudit){
  if(!item)return [];
  const evidence=semanticAudit?.findings?.find(f=>
    f.assessment==='SUSPECTED_CONTRADICTION' &&
    f.skill===item.target?.path &&
    (f.proposal_id===item.id ||
      (!f.proposal_id&&item.title==='Verificare: '+f.statement.slice(0,90))));
  if(!evidence)return [];
  return [
    '',
    'AFFERMAZIONE DELLA SKILL (da verificare)',
    evidence.statement,
    '',
    'CODICE CITATO (testo verificato, NON prova logica)',
    (evidence.evidence?.path??'Sorgente non disponibile')+
      (evidence.evidence?.line?':'+evidence.evidence.line:''),
    evidence.evidence?.quote??'Citazione non disponibile',
    '',
    'INTERPRETAZIONE DEL MODELLO (da valutare)',
    evidence.reason,
    'Giudizio LLM: '+evidence.assessment+' · Solo ipotesi, nessuna patch pronta.'
  ];
}
