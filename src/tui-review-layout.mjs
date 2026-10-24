/**
 * Presentation-only review workspace. The audit, proposal catalog and guarded
 * Apply remain the single source of truth; rendering never alters them.
 */
import {wrapTuiLines,evidenceDetailLines} from './tui-readable.mjs';

export function reviewWindow(visible,focusedIndex,capacity){
  const size=Math.max(1,capacity);
  const cursor=Math.max(0,visible.indexOf(focusedIndex));
  const start=Math.max(0,Math.min(cursor-Math.floor(size/2),
    Math.max(0,visible.length-size)));
  const end=Math.min(visible.length,start+size);
  return {start,end,current:visible.length?cursor+1:0,total:visible.length};
}
export function reviewRow(item,index,{focused=false,selected=false,discarded=false,width=90}={}){
  const status=item.readiness==='PREVIEW_READY'?'DA RIVEDERE':
    item.readiness==='BLOCKED'?'BLOCCATA':'DA PREPAR.';
  const prefix=(focused?'❯ ':'  ')+(discarded?'×':selected?'✓':'○')+' '+
    String(index+1).padStart(3,' ')+' '+
    String(item.action||'?').padEnd(7)+' '+status.padEnd(11)+' ';
  const title=String(item.title||item.id||'');
  const available=Math.max(0,width-prefix.length);
  return prefix+(title.length>available?title.slice(0,Math.max(0,available-1))+'…':title);
}

export function draftInstructions({method='AI',selected=false}={}){
  const description=method==='AI'?'PROPOSTA DI MODIFICA GENERATA DALL’AI':
    method==='EDITOR'?'PROPOSTA DI MODIFICA PREPARATA NELL’EDITOR':
      'PROPOSTA DI MODIFICA PREPARATA';
  return [
    description+' · DA VERIFICARE',
    'Il file SKILL.md originale NON è stato modificato.',
    '1  Leggi il diff (↑↓): valuta ogni modifica, non fidarti del modello.',
    selected?'2  ESC torna alla lista · proposta già selezionata':
      '2  ESC torna alla lista · SPAZIO seleziona per il lotto.',
    '3  G verifica il lotto; solo Y conferma la scrittura nel progetto.'
  ];
}

const plain=(s,width)=>String(s??'').slice(0,width).padEnd(width,' ');
function paneLine(left,right,leftWidth,rightWidth){
  return '│'+plain(left,leftWidth)+'│'+plain(right,rightWidth)+'│';
}
/** 2-panel workspace for terminal widths >=100: row count never exceeds height. */
export function renderReviewWorkspace({items,visible,state,semanticAudit=null,previews=null,
  width=120,height=24}){
  const inner=width-5;
  const leftWidth=Math.max(39,Math.floor(inner*0.43));
  const rightWidth=inner-leftWidth;
  const focusedIndex=visible.includes(state.cursor)?state.cursor:visible[0];
  const selected=new Set(state.selected??[]),discarded=new Set(state.discarded??[]);
  const lines=[];
  const readySelected=[...selected].filter(i=>items[i]?.readiness==='PREVIEW_READY').length;
  const rows=Math.max(3,height-7);
  const win=reviewWindow(visible,focusedIndex,rows);
  const chosen=items[focusedIndex];
  const preview=previews?.previews?.find(p=>p.proposal_id===chosen?.id);
  const right=[];
  if(chosen){
    right.push('AZIONE: '+chosen.action+' · '+
      (chosen.readiness==='PREVIEW_READY'?'MODIFICA PROPOSTA · DIFF DA RIVEDERE':
        chosen.readiness==='BLOCKED'?'BLOCCATA':'MODIFICA DA PREPARARE'),
      'SKILL: '+(chosen.target?.path??chosen.source?.path??'nessun percorso'),
      'PROPOSTA:',
      chosen.title,'',
      ...evidenceDetailLines(chosen,semanticAudit));
    if(!semanticAudit || !evidenceDetailLines(chosen,semanticAudit).length)
      right.push('MOTIVO:',chosen.summary??'Non specificato');
    if(chosen.readiness==='PREVIEW_READY'&&preview?.diff)
      right.push('','MODIFICA PROPOSTA · DIFF DISPONIBILE (P apre il testo completo)',
        ...preview.diff.split('\n'));
    else if(chosen.action==='UPDATE')
      right.push('','Nessuna modifica preparata.',
        'M chiede al modello una versione completa rivista di SKILL.md.',
        'La proposta va confrontata col codice: non è una correzione verificata.');
    else if(chosen.action==='CREATE')
      right.push('','Nessuna modifica preparata. E apre l’editor per creare la skill.');
    else
      right.push('','Nessuna modifica preparata. R prepara MOVE/REMOVE per revisione.');
    right.push('','Una citazione non dimostra da sola un errore.');
  }else right.push('Nessuna proposta per i filtri correnti.',
    'F cambia il tipo · / cerca · X cancella.');
  const wrapped=wrapTuiLines(right,Math.max(20,rightWidth-3));
  const scroll=Math.max(0,Math.min(state.paneScroll??0,
    Math.max(0,wrapped.length-rows)));
  const content=wrapped.slice(scroll,scroll+rows);
  lines.push('┌'+'─'.repeat(leftWidth)+'┬'+'─'.repeat(rightWidth)+'┐');
  lines.push(paneLine(' PROPOSTE '+win.current+'/'+win.total+
      (state.paneFocus==='proposals'?' [ATTIVO]':''),
    ' REVISIONE'+(state.paneFocus==='evidence'?' [ATTIVO]':''),leftWidth,rightWidth));
  lines.push('├'+'─'.repeat(leftWidth)+'┼'+'─'.repeat(rightWidth)+'┤');
  for(let i=0;i<rows;i++){
    const index=visible[win.start+i],item=items[index];
    const left=item?reviewRow(item,index,{
      focused:index===focusedIndex,selected:selected.has(index),
      discarded:discarded.has(index),width:leftWidth}):'';
    lines.push(paneLine(left,content[i]??'',leftWidth,rightWidth));
  }
  lines.push('├'+'─'.repeat(leftWidth)+'┼'+'─'.repeat(rightWidth)+'┤');
  lines.push(paneLine(' Visibili '+(win.total?win.start+1:0)+'-'+win.end+'/'+win.total,
    ' Prove '+(wrapped.length?scroll+1:0)+'-'+
      Math.min(wrapped.length,scroll+rows)+'/'+wrapped.length,leftWidth,rightWidth));
  lines.push('└'+'─'.repeat(leftWidth)+'┴'+'─'.repeat(rightWidth)+'┘');
  return {
    lines,paneWidth:{left:leftWidth,right:rightWidth},
    selectedCount:selected.size,readySelected,window:win,detailLines:wrapped.length
  };
}
