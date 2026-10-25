/**
 * Wizard review TUI. Zero external UI dependencies.
 * Draft preparation is separate from final user-confirmed batch Apply.
 * No implicit LLM invocation or write authorization.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {buildReviewCatalog,planHumanSelection} from './review-selection.mjs';
import {readReviewSession,restoreReviewSession,saveReviewSession} from './review-session.mjs';
import {prepareReviewedApply,commitReviewedApply} from './guarded-apply.mjs';
import {loadReviewPreviews} from './review-candidates.mjs';
import {editUpdateDraft,generateUpdateDraft} from './update-drafting.mjs';
import {performSemanticAudit} from './tui-semantic-audit.mjs';
import {closeLlmClient} from './llm-provider.mjs';
import {runDocumentedDomain} from './documented-domain.mjs';
import {stageLifecycle,editCreateSkill} from './skill-lifecycle.mjs';
import {initialProviderSelection,providerDescription,validateProviderSelection,
  LOCAL_OLLAMA_URL} from './tui-provider.mjs';
import {commandHints,HELP_LINES,contextualHelp,pinCommandHints} from './tui-help.mjs';
import {overviewActions,activeOverviewChoice,moveOverviewChoice} from './tui-menu.mjs';
import {wrapTuiLines,evidenceDetailLines} from './tui-readable.mjs';
import {reviewWindow,reviewRow,draftInstructions,renderReviewWorkspace} from './tui-review-layout.mjs';
import {decorateWizardOverview} from './tui-brand.mjs';

const CSI='\x1b[';
const palette={cyan:'96',green:'92',yellow:'93',red:'91',blue:'94',magenta:'95',gray:'37',bold:'1',dim:'37'};
const safe=x=>String(x??'').replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))|\x1b./g,'')
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'?');
const shorten=(x,width)=>safe(x).length>width ? safe(x).slice(0,Math.max(0,width-1))+'…':safe(x);
const color=(name,s,enabled)=>enabled ? CSI+palette[name]+'m'+s+CSI+'0m':s;


const FILTERS=['ALL','UPDATE','CREATE','MOVE','REMOVE'];
export function visibleProposalIndices(items,state){
  const filter=state.filter??'ALL',query=String(state.search??'').trim().toLowerCase();
  return items.flatMap((item,i)=>{
    if(filter!=='ALL' && item.action!==filter)return [];
    const searchable=[
      item.id,item.title,item.summary,item.action,item.priority,item.readiness,item.skill,
      item.source?.repo,item.source?.path,item.target?.repo,item.target?.path
    ].map(x=>String(x??'')).join(' ').toLowerCase();
    return !query||searchable.includes(query)?[i]:[];
  });
}

export function diagnosticEntries(kind,{scopeHints=null,sourceChecks=null}={}){
  if(kind==='scope')return [
    ...(scopeHints?.hints??[]).map(item=>({type:'HINT',item})),
    ...(scopeHints?.abstentions??[]).map(item=>({type:'ASTENSIONE',item}))
  ];
  if(kind==='consistency')return (sourceChecks?.observations??[])
    .map(item=>({type:'CHECK',item}));
  return [];
}

export function initialTuiState({guided=false}={}){
  return {cursor:0,selected:[],discarded:[],view:guided?'overview':'list',
    guided,scroll:0,paneScroll:0,paneFocus:'proposals',semanticCursor:0,overviewChoice:null,helpReturnView:null,draftResult:null,notice:'',filter:'ALL',search:'',searchDraft:'',
    searching:false,diagnosticKind:'scope',diagnosticCursor:0,returnView:'overview'};
}

export function updateTuiState(state,command,count,context={}){
  const next={...state,selected:[...state.selected],discarded:[...state.discarded]};
  const selected=new Set(next.selected),discarded=new Set(next.discarded);
  const indices=context.items?visibleProposalIndices(context.items,state):
    Array.from({length:count},(_,i)=>i);
  const current=indices.includes(state.cursor)?state.cursor:(indices[0]??0);
  const currentPosition=indices.indexOf(current);
  const diagnosticCount=state.diagnosticKind==='scope'?(context.scopeCount??0):
    (context.consistencyCount??0);

  if(state.searching){
    if(command==='escape'){next.searching=false;next.searchDraft=state.search;}
    else if(command==='enter'){
      next.searching=false;next.search=state.searchDraft.trim();next.cursor=0;
      const matches=context.items?visibleProposalIndices(context.items,next):indices;
      next.cursor=matches[0]??0;next.notice='';
    }else if(command==='backspace')next.searchDraft=state.searchDraft.slice(0,-1);
    else if(command==='text' && typeof context.text==='string' &&
      context.text.length===1 && context.text.charCodeAt(0)>=32 &&
      context.text.charCodeAt(0)!==127)
      next.searchDraft=(state.searchDraft+context.text).slice(0,80);
    return next;
  }
  if(command==='h'||command==='c'){
    if(['overview','list','diagnostics','diagnostic-detail'].includes(state.view)){
      if(state.view==='overview'||state.view==='list')next.returnView=state.view;
      next.view='diagnostics';next.diagnosticKind=command==='h'?'scope':'consistency';
      next.diagnosticCursor=0;next.scroll=0;next.notice='';
    }
    return next;
  }
  if(state.view==='diagnostics'){
    if(command==='up'||command==='down')next.diagnosticCursor=Math.max(0,
      Math.min(Math.max(0,diagnosticCount-1),state.diagnosticCursor+(command==='up'?-1:1)));
    else if((command==='enter'||command==='v') && diagnosticCount){
      next.view='diagnostic-detail';next.scroll=0;
    }else if(command==='escape')next.view=state.returnView;
    return next;
  }
  if(state.view==='diagnostic-detail'){
    if(command==='up'||command==='down')next.scroll=Math.max(0,
      state.scroll+(command==='up'?-1:1));
    else if(command==='escape'||command==='enter'||command==='v'){
      next.view='diagnostics';next.scroll=0;
    }
    return next;
  }
  if(state.view==='overview'){
    if(command==='enter'||command==='v'||command==='l'){
      next.view='list';next.notice='';
    }
    return next;
  }
  if(state.view==='list' && command==='f'){
    next.filter=FILTERS[(FILTERS.indexOf(state.filter??'ALL')+1)%FILTERS.length];
    const filtered=context.items?visibleProposalIndices(context.items,next):indices;
    next.cursor=filtered[0]??0;next.notice='';
  }else if(state.view==='list' && command==='/'){
    next.searching=true;next.searchDraft=state.search;
  }else if(state.view==='list' && command==='x'){
    next.search='';next.searchDraft='';
    const filtered=context.items?visibleProposalIndices(context.items,next):indices;
    next.cursor=filtered[0]??0;next.notice='';
  }else if(command==='up'||command==='down'){
    if(state.view==='list'&&state.paneFocus==='evidence'&&context.twoPane){
      next.paneScroll=Math.max(0,(state.paneScroll??0)+(command==='up'?-1:1));
    }else if(state.view==='list' && indices.length){
      const pos=Math.max(0,currentPosition);
      next.cursor=indices[Math.max(0,Math.min(indices.length-1,
        pos+(command==='up'?-1:1)))];
      next.paneScroll=0;
    }else if(state.view!=='list')next.scroll=Math.max(0,
      state.scroll+(command==='up'?-1:1));
  }else if(command==='space' && indices.length && state.view==='list'){
    if(discarded.has(current))next.notice='Ripristina la proposta prima di selezionarla (u).';
    else if(selected.has(current))selected.delete(current);else selected.add(current);
  }else if(command==='a' && state.view==='list'){
    for(const i of indices)if(!discarded.has(i))selected.add(i);
    next.notice='Selezionate le proposte visibili non scartate.';
  }else if(command==='i' && state.view==='list'){
    for(const i of indices){
      if(discarded.has(i))continue;
      if(selected.has(i))selected.delete(i);else selected.add(i);
    }
    next.notice='Selezione invertita solo per le proposte visibili.';
  }else if(command==='b' && state.view==='list'){
    for(const i of indices){selected.delete(i);discarded.add(i);}
    next.notice='Scartate '+indices.length+' proposte visibili (solo sessione).';
  }else if(command==='t' && state.view==='list'){
    for(const i of indices)discarded.delete(i);
    next.notice='Ripristinate le proposte visibili scartate (solo sessione).';
  }else if(command==='n' && state.view==='list'){
    selected.clear();
  }else if(command==='d' && indices.length && state.view==='list'){
    selected.delete(current);discarded.add(current);
    next.notice='Proposta scartata nella sessione (non dal repository).';
  }else if(command==='u' && indices.length && state.view==='list'){
    discarded.delete(current);next.notice='Proposta ripristinata.';
  }else if((command==='enter'||command==='v') &&
    (state.view!=='list'||indices.length)){
    next.cursor=current;
    next.view=state.view==='detail'?'list':'detail';next.scroll=0;
  }else if(command==='p' && (state.view!=='list'||indices.length)){
    next.cursor=current;
    next.view=state.view==='preview'?'list':'preview';next.scroll=0;
  }else if(command==='escape'){
    next.view=state.view==='list' && state.guided?'overview':'list';
    next.scroll=0;next.paneFocus='proposals';next.paneScroll=0;
  }
  next.selected=[...selected].sort((a,b)=>a-b);
  next.discarded=[...discarded].sort((a,b)=>a-b);
  return next;
}


function confirmationDetails(pending,width){
  const details=[];
  for(const entry of pending){
    const action=entry.operation??'UPDATE';
    const origin=action==='CREATE'?'NUOVO FILE':'ORIGINE';
    details.push(...wrapDetail([action+' '+origin+' '+entry.repo+':'+entry.path],width-2));
    if(entry.destination_absolute||entry.dest_path){
      details.push(entry.destination_absolute?'DESTINAZIONE ASSOLUTA':'DESTINAZIONE RELATIVA',
        ...wrapDetail([entry.destination_absolute??entry.dest_path],width-2));
    }
    const summary=action==='CREATE'?'Nuovo SHA '+entry.after_sha256.slice(0,16):
      (action==='MOVE'||action==='REMOVE')?
        'Cartella completa: '+entry.package_files.length+' file verificati':
        'SHA origine '+entry.before_sha256.slice(0,16)+
        '  → nuovo '+entry.after_sha256.slice(0,16);
    details.push(...wrapDetail([summary],width-2),'');
  }
  return details;
}
const source=loc=>loc?loc.repo+':'+loc.path:'destinazione non specificata';
const wrapDetail=(lines,width)=>lines.flatMap(line=>{
  const value=safe(line);
  if(!value)return [''];
  const out=[];
  for(let i=0;i<value.length;i+=width)out.push(value.slice(i,i+width));
  return out;
});
export function renderReviewTui(catalog,state,{previews=null,scopeHints=null,sourceChecks=null,localScan=null,semanticAudit=null,
  columns=90,rows=28,colors=true,applyConfigured=false,
  editorConfigured=false,modelConfigured=false,
  providerPickerEnabled=false,providerSelection=null,providerWizard=null,domainWizard=null}={}){
  // Honor the reported viewport height, including blank padding and footer.
  const items=catalog.items||[],width=Math.max(40,columns);
  const height=Number.isInteger(rows)&&rows>0?rows:28;
  const c=state.cursor,selected=new Set(state.selected),discarded=new Set(state.discarded);
  const visible=visibleProposalIndices(items,state);
  const scope=diagnosticEntries('scope',{scopeHints}),consistency=diagnosticEntries('consistency',{sourceChecks});
  const fmt=(value,name)=>color(name,shorten(value,width-2),colors);
  const guidedOverview=state.view==='overview'&&!providerWizard&&!domainWizard;
  // A 12-row terminal, retain the preview title, progress and safety footer.
  // Omit two decorative/status rows rather than starving diff navigation.
  const tinyDetail=height<=12 && ['detail','preview'].includes(state.view);
  const lines=guidedOverview?[
    fmt('🪄  WIZARD OF SKILLZ','cyan'),
    fmt('─'.repeat(width-2),'gray')
  ]:tinyDetail?[
    fmt('🪄  WIZARD OF SKILLZ  ·  HUMAN REVIEW','cyan')
  ]:[
    fmt('🪄  WIZARD OF SKILLZ  ·  HUMAN REVIEW','cyan'),
    fmt('─'.repeat(width-2),'gray'),
    fmt('Proposte '+items.length+'   Selezionate '+selected.size+
      '   Scartate '+discarded.size,'bold')
  ];
  if(state.notice)lines.push(fmt(state.notice,'yellow'));
  if(providerPickerEnabled&&!guidedOverview&&!tinyDetail)
    lines.push(fmt('Modello: '+providerDescription(providerSelection),'gray'));
  if(providerWizard){
    lines.push('',fmt('SCELTA PROVIDER LLM — Nessuna richiesta al modello','cyan'));
    if(providerWizard.step==='menu'){
      lines.push(fmt('1  GitHub Copilot (login federato)','bold'),
        fmt('2  Ollama locale · http://127.0.0.1:11434','bold'),
        fmt('3  Ollama remoto · server scelto da te','bold'),
        fmt('4  OpenAI · account Codex CLI già autenticato','bold'),
        fmt('5  Anthropic · Claude Code CLI già autenticato','bold'),
        '');
    }else if(providerWizard.step==='url'){
      lines.push(fmt('Indirizzo server Ollama remoto (es. http://host:11434/v1)','bold'),
        fmt('> '+providerWizard.text,'cyan'),
        '');
    }else if(providerWizard.step==='model'){
      const copilot=providerWizard.draft.provider==='copilot';
      lines.push(fmt(copilot?'Modello Copilot (auto oppure ID modello)':
        'Modello Ollama (nome esatto mostrato da ollama list)','bold'));
      if(!copilot)lines.push(fmt('Endpoint: '+providerWizard.draft.baseUrl,'gray'));
      lines.push(fmt('> '+providerWizard.text,'cyan'));
    }else if(providerWizard.step==='models'){
      lines.push(fmt(providerWizard.draft.provider==='copilot'?
        'Modelli disponibili tramite il tuo account Copilot':
        'Modelli disponibili su '+providerWizard.draft.baseUrl,'cyan'));
      const avail=providerWizard.models??[];
      const idx=providerWizard.modelCursor??0;
      for(const [i,model] of avail.slice(Math.max(0,idx-8),idx+Math.max(8,Math.floor((height-14)/2))).entries()){
        const offset=Math.max(0,idx-8)+i;
        lines.push(fmt((offset===idx?' ❯ ':'   ')+model,
          offset===idx?'cyan':'bold'));
      }

    }
    return pinCommandHints(lines,commandHints(state.view,{
      wizardStep:providerWizard.step
    }),{height,width,fmt});
  }
  if(domainWizard){
    const w=domainWizard;
    const domainLines=[
      fmt('🪄  WIZARD OF SKILLZ  ·  DOCUMENTED DOMAIN','cyan'),
      fmt('─'.repeat(width-2),'gray'),
      fmt('Solo bozze: nessuna modifica alle skill o ai documenti.','gray')
    ];
    if(w.notice)domainLines.push(fmt(w.notice,'yellow'));
    if(w.step==='resources'){
      domainLines.push('',fmt('1/2  Dove sono le resources del dominio?','bold'),
        fmt('Percorso relativo al repository o assoluto:','gray'),
        fmt('> '+w.text,'cyan'));
    }else if(w.step==='skills'){
      domainLines.push('',fmt('2/2  Dove si trovano le skills esistenti?','bold'),
        fmt('La directory può non esistere ancora.','gray'),
        fmt('> '+w.text,'cyan'));
    }else if(w.step==='review'||w.step==='confirm'){
      domainLines.push('',fmt('Resources: '+w.resources,'bold'),
        fmt('Skills: '+w.skills,'bold'),
        fmt('Documenti individuati: '+(w.inventory?.resources_count??0),'cyan'),
        fmt('Skill esistenti: '+(w.inventory?.existing_skill_count??0),'cyan'),
        fmt('Provider: '+providerDescription(providerSelection),'gray'),
        fmt('I file supportati sono md, txt, yaml, yml, json.','gray'),
        '');
      if(w.step==='confirm')
        domainLines.push(fmt('ATTENZIONE: il modello riceverà contenuti delle resources','yellow'),
          fmt('e frammenti delle skill esistenti.','yellow'),
          fmt('Y Conferma invio e genera bozze · ESC Annulla','bold'));
      else domainLines.push(fmt('M Proponi bozze con il modello · L Cambia provider','bold'),
        fmt('Nessuna chiamata al modello è stata eseguita.','gray'));
    }else if(w.step==='result'){
      const drafts=w.result?.draft_skills??[];
      domainLines.push('',fmt('Bozze proposte: '+drafts.length,'bold'),
        fmt('Documentazione analizzata: '+(w.result?.resources_count??0)+' documenti','gray'),
        fmt('Report: '+(w.result?.output_directory??''),'gray'),
        fmt('↑↓ Scegli · INVIO Leggi la bozza · ESC Torna','cyan'));
      drafts.forEach((draft,i)=>domainLines.push(fmt(
        (i===(w.cursor??0)?' ❯ ':'   ')+draft.name,
        i===(w.cursor??0)?'cyan':'bold')));
      if(!drafts.length)domainLines.push(fmt('Nessuna skill proposta: verificare le fonti o il report.','yellow'));
    }else if(w.step==='draft'){
      const drafts=w.result?.draft_skills??[];
      const current=drafts[w.cursor??0];
      const body=wrapTuiLines(String(w.draftText??'').split(/\r?\n/),Math.max(20,width-4));
      const visible=Math.max(1,height-domainLines.length-5);
      const pos=Math.min(w.scroll??0,Math.max(0,body.length-visible));
      domainLines.push('',fmt('BOZZA: '+(current?.name??'?'),'bold'),
        fmt('Righe '+(body.length?pos+1:0)+'-'+Math.min(body.length,pos+visible)+'/'+body.length,'gray'));
      for(const row of body.slice(pos,pos+visible))domainLines.push(fmt(row,'bold'));
    }
    const hints=w.step==='resources'||w.step==='skills'?
      ['Digita percorso  INVIO Conferma  BACKSPACE Cancella','ESC Indietro · Q Esci']:
      w.step==='review'?['M Genera bozze  L Provider  ESC Percorsi','Nessuna scrittura nelle skill · Q Esci']:
      w.step==='confirm'?['Y Invia le fonti al modello  ESC Annulla','Non inviare dati riservati a provider non autorizzati']:
      w.step==='result'?['↑↓ Scegli  INVIO Leggi bozza  ESC Menu','Bozze da approvare, non installate']:
      ['↑↓ Scorri la bozza · ESC Torna ai risultati','Nessuna Apply automatica · Q Esci'];
    return pinCommandHints(domainLines,hints,{height,width,fmt});
  }
  if(state.view==='overview'){
    const options=overviewActions({
      hasSemanticReport:Boolean(semanticAudit),modelConfigured,providerPickerEnabled,
      proposalCount:items.length,modelLabel:providerDescription(providerSelection)
    });
    const active=activeOverviewChoice(options,state.overviewChoice);
    const compact=height<20;
    // At 12 rows, reserve the footer and keep all menu choices visible.
    if(height<=12){
      lines.push(fmt((localScan?localScan.skill_count+' skill individuate':
        'Proposte strutturali: '+items.length)+' · Proposte: '+items.length,'bold'),
        fmt('COSA VUOI FARE?   ↑↓ e INVIO','cyan'));
      for(const option of options)
        lines.push(fmt((option.id===active?.id?'  ❯ ':'    ')+option.title,
          option.id===active?.id?'cyan':'bold'));
      if(active)lines.push('',fmt('  '+active.description,'gray'));
      return pinCommandHints(lines,commandHints(state.view,{
        narrow:true,providerPickerEnabled,modelConfigured,applyConfigured,
        proposalCount:items.length,hasSemanticReport:Boolean(semanticAudit)
      }),{height,width,fmt});
    }
    lines.push(
      fmt('Repository: '+(catalog.source_repositories?.consumer??'locale'),'gray'),
      fmt((localScan?localScan.skill_count+' skill individuate':'Proposte strutturali: '+items.length)+
        '  ·  Proposte: '+items.length,'bold')
    );
    if(!compact)lines.push('');
    lines.push(fmt('Scansione strutturale completata · verifica semantica non inclusa.','gray'));
    if(semanticAudit)
      lines.push(fmt('Audit LLM: '+semanticAudit.claims_checked+' claim, '+
        semanticAudit.proposed_updates+' ipotesi UPDATE · NON sono prove.','yellow'));
    else
      lines.push(fmt('Audit semantico: non ancora eseguito.','yellow'));
    if(!compact)lines.push('');
    lines.push(fmt('COSA VUOI FARE?   ↑↓ e INVIO','cyan'));
    for(const option of options)
      lines.push(fmt((option.id===active?.id?'  ❯ ':'    ')+option.title,
        option.id===active?.id?'cyan':'bold'));
    if(active)lines.push('',fmt('  '+active.description,'gray'));
    if(!compact)lines.push('',
      fmt('Le modifiche si preparano separatamente e si applicano solo con G → Y.','yellow'));
  }else if(state.view==='list'){
    const query=state.searching?state.searchDraft:state.search;
    const ready=items.filter(item=>item.readiness==='PREVIEW_READY').length;
    lines.push(fmt('REVISIONE · Filtro '+(state.filter??'ALL')+
      ' · '+visible.length+'/'+items.length+' visibili · Diff da rivedere '+ready,'cyan'));
    if(state.searching||query)
      lines.push(fmt('Ricerca '+(query||'—')+(state.searching?' [scrivi e premi INVIO]':''),'gray'));
    if(width>=100&&height>=20){
      const workspace=renderReviewWorkspace({
        items,visible,state,semanticAudit,previews,width,
        height:Math.max(10,height-lines.length-4)
      });
      lines.push(...workspace.lines.map(line=>fmt(line,
        line.includes('❯')?'cyan':'bold')));
      lines.push(fmt('LOTTO: '+selected.size+' selezionate · '+
        workspace.readySelected+' con diff da rivedere · G verifica, Y applica.','gray'));
    }else{
      const viewHeight=Math.max(1,height-lines.length-9);
      const window=reviewWindow(visible,c,viewHeight);
      lines.push(fmt('Visibili '+(window.total?window.start+1:0)+'–'+window.end+'/'+window.total+
        ' · Totali '+items.length+' · Selezionate '+selected.size,'bold'),
        fmt('Filtro '+(state.filter??'ALL')+' · Cerca '+(query||'—'),'gray'),'');
      lines.push(fmt('    N. TIPO    STATO    PRIORITÀ  PROPOSTA','gray'));
      for(const index of visible.slice(window.start,window.end)){
        const item=items[index],active=index===c,discardedItem=discarded.has(index);
        lines.push(fmt(reviewRow(item,index,{
          focused:active,selected:selected.has(index),discarded:discardedItem,
          width:width-2
        }),discardedItem?'gray':active?'cyan':selected.has(index)?'green':'bold'));
      }
      if(!visible.length)lines.push(fmt('Nessuna proposta con il filtro attuale. / Cerca · F Filtra · X Pulisci','gray'));
    }
  }else if(state.view==='semantic-list'){
    const findings=semanticAudit?.findings??[];
    const cursor=Math.max(0,Math.min(state.semanticCursor??0,Math.max(0,findings.length-1)));
    const visibleCount=Math.max(2,height-lines.length-10);
    const start=Math.max(0,Math.min(cursor-Math.floor(visibleCount/2),
      Math.max(0,findings.length-visibleCount)));
    const end=Math.min(findings.length,start+visibleCount);
    lines.push(fmt('DIAGNOSI SEMANTICA · IPOTESI LLM · NON È UNA PROVA','yellow'),
      fmt('Esiti '+(findings.length?start+1:0)+'–'+end+'/'+findings.length+
        '  ·  Proposte UPDATE '+(semanticAudit?.proposed_updates??0),'bold'),
      '',fmt('    ESITO      SKILL / RIGA','gray'));
    for(let i=start;i<end;i++){
      const item=findings[i],active=i===cursor;
      const status=item.assessment==='SUSPECTED_CONTRADICTION'?'SOSPETTA':
        item.assessment==='SUPPORTED_CANDIDATE'?'COERENTE?':'INCERTA';
      lines.push(fmt((active?' ❯ ':'   ')+status.padEnd(10)+item.skill+':'+item.skill_line,
        active?'cyan':'bold'));
    }
    if(!findings.length)lines.push(fmt('Nessuna claim analizzata.','gray'));
    if(end<findings.length)lines.push(fmt('↓ Altri '+(findings.length-end)+' esiti','gray'));
    lines.push('',fmt('INVIO apre il testo integrale della claim e la citazione verificata.','gray'));
  }else if(state.view==='semantic-detail'){
    const item=semanticAudit?.findings?.[state.semanticCursor??0];
    const details=item?[
      'Esito: '+item.assessment+' (ipotesi del modello)',
      'Istruzione: '+item.skill+':'+item.skill_line,
      'Claim: '+item.statement,
      'Motivo: '+item.reason,
      'Citazione verificata: '+(item.evidence?
        item.evidence.path+':'+item.evidence.line:'NON DISPONIBILE'),
      'Testo sorgente: '+(item.evidence?.quote??'—'),
      'Limiti: '+(item.limitations??[]).join(' | ')
    ]:['Nessuna diagnosi selezionata'];
    const wrapped=wrapTuiLines(details.map(safe),Math.max(20,width-5));
    const max=Math.max(3,height-lines.length-7);
    const start=Math.max(0,Math.min(state.scroll??0,Math.max(0,wrapped.length-max)));
    lines.push(fmt('DETTAGLIO SEMANTICO · IPOTESI, NON APPROVAZIONE','yellow'),
      fmt('Righe '+(wrapped.length?start+1:0)+'–'+Math.min(wrapped.length,start+max)+
        '/'+wrapped.length+'  ·  ↑↓ per leggere tutto','gray'),
      ...wrapped.slice(start,start+max).map(value=>fmt(value,'bold')));
  }else if(state.view==='help'){
    const guidance=wrapDetail([
      ...HELP_LINES.slice(0,7),
      'IN QUESTA SCHERMATA',
      ...contextualHelp(state.helpReturnView),
      '',
      ...HELP_LINES.slice(7)
    ],Math.max(20,width-4));
    lines.push(fmt('AIUTO · COMANDI E PERCORSO OPERATIVO','cyan'),
      fmt('Sezione '+Math.min(guidance.length,(state.scroll??0)+1)+
        '–'+Math.min(guidance.length,(state.scroll??0)+Math.max(3,height-10))+
        ' di '+guidance.length+' · ↑↓ per continuare','gray'),
      ...guidance.slice(state.scroll??0,(state.scroll??0)+Math.max(3,height-11))
        .map(line=>fmt(line,'bold')));
  }else if(state.view==='confirm-apply'){
    const pending=state.pendingApply?.candidates??[];
    lines.push(fmt('CONFERMA UNICA — SCRITTURA REALE SU '+pending.length+' FILE','red'),
      fmt('Proposte confermate: '+(state.pendingApply?.selected_ids?.length??pending.length),'bold'),
      fmt('Lotto completo: se una patch non è pronta, non si applica nulla.','yellow'));
    // Wrap before formatting so a destination is never truncated.
    const details=confirmationDetails(pending,width);
    const viewHeight=Math.max(1,height-lines.length-4); // counter + three-line footer
    const start=Math.max(0,Math.min(state.scroll??0,Math.max(0,details.length-viewHeight)));
    const finish=Math.min(details.length,start+viewHeight);
    lines.push(fmt('Righe '+(details.length?start+1:0)+'–'+finish+'/'+details.length+
      '  ·  ↑↓ per leggere tutte le destinazioni','bold'),
      ...details.slice(start,finish).map(line=>fmt(line,'bold')));

  }else if(state.view==='diagnostics'||state.view==='diagnostic-detail'){
    const kind=state.diagnosticKind,records=kind==='scope'?scope:consistency;
    const title=kind==='scope'?'SCOPE':'COERENZA SORGENTI';
    lines.push(fmt('DIAGNOSI '+title+'  ·  '+records.length+' voci  ·  NON SELEZIONABILI','cyan'));
    if(state.view==='diagnostics'){
      if(kind==='scope' && localScan)
        lines.push(fmt('Scope non valutato da questa scansione locale.','yellow'));
      const viewHeight=Math.max(3,height-11);
      const cursor=Math.max(0,Math.min(records.length-1,state.diagnosticCursor));
      const start=Math.max(0,Math.min(cursor-Math.floor(viewHeight/2),Math.max(0,records.length-viewHeight)));
      for(let i=start;i<Math.min(records.length,start+viewHeight);i++){
        const {type,item}=records[i];
        const name=kind==='scope'?(item.skill??item.path??'?'):(item.skill??item.skill_path??'?');
        const why=kind==='scope'?(item.kind??item.reason??''):(item.kind??'');
        lines.push(fmt((i===cursor?' ❯ ':'   ')+String(i+1).padStart(2,'0')+'  '+
          type.padEnd(11)+name+'  '+why,i===cursor?'cyan':'bold'));
      }
      if(!records.length)lines.push(fmt('Nessuna diagnosi disponibile; non significa verifica completa.','gray'));

    }else{
      const chosen=records[state.diagnosticCursor];
      let details=[];
      if(chosen && kind==='scope'){
        const d=chosen.item;
        details=[
          'Tipo: '+chosen.type+(d.kind?' / '+d.kind:''),
          'Skill: '+(d.skill??'non specificata'),
          'Percorso: '+(d.current?.path??d.path??'non specificato'),
          'Motivo: '+(d.reason??'non specificato'),
          'Destinazione: '+(d.target?.path??'non dimostrata'),
          'Confidenza: '+(d.confidence??'non dichiarata'),
          'Prova: '+(d.proof??'non disponibile'),
          'Direzioni: '+(d.directions??[]).join(', '),
          'Claim provider: '+(d.provider_claims?.length??0)+
            '   locali: '+(d.local_claims?.length??0)+
            '   irrisolti: '+(d.unresolved_claim_count??'non determinato'),
          'SHA skill: '+(d.current?.sha256??'non disponibile'),
          'Limiti:',...(d.limits??[]).map(x=>' • '+x)
        ];
      }else if(chosen){
        const d=chosen.item;
        details=[
          'Tipo: '+(d.kind??'controllo strutturale'),
          'Skill: '+(d.skill??'non specificata'),
          'Istruzione: '+(d.skill_path??'?')+':'+(d.skill_line??'?'),
          'Sorgente: '+(d.source?.path??'?')+':'+(d.source?.line??'?'),
          'SHA sorgente: '+(d.source?.sha256??'non disponibile'),
          'SHA skill: '+(d.skill_sha256??'non disponibile'),
          'Valutazione: '+(d.confidence??'non dichiarata'),
          'Esito: '+(d.suggested_action??'solo diagnosi'),
          'Motivo: '+(d.detail??'non specificato')
        ];
      }
      lines.push(fmt('DETTAGLIO '+(state.diagnosticCursor+1)+'/'+records.length,'cyan'),'');
      const viewHeight=Math.max(3,height-11);
      for(const line of wrapDetail(details,Math.max(20,width-3)).slice(state.scroll,state.scroll+viewHeight))
        lines.push(fmt(line,'bold'));

    }
  }else{
    const item=items[c],preview=previews?.previews?.find(p=>p.proposal_id===item?.id);
    lines.push(fmt((state.view==='detail'?'DETTAGLIO':'ANTEPRIMA')+'  '+(c+1)+'/'+items.length+
      '   '+(item?.title??''),'cyan'),'');
    const draft=state.view==='preview' && state.draftResult &&
      state.draftResult.ids?.includes(item?.id) &&
      preview?.status==='PREVIEW_READY' ? state.draftResult:null;
    if(draft){
      const instructions=draftInstructions({method:draft.method,
        selected:state.selected.includes(c)});
      // On short terminals the footer already explains navigation and approval.
      // Keep enough real viewport rows to inspect the diff before G/Y.
      if(height<20)lines.push(fmt(instructions[0],'green'));
      else lines.push(...instructions.map((value,i)=>
        fmt(value,i===0?'green':i===3?'yellow':'bold')), '');
    }
    const details=state.view==='preview' ?
      (preview?.status==='PREVIEW_READY' && preview.diff?
        [preview.user_candidate?'CANDIDATO UTENTE — diff completo da revisionare':'ANTEPRIMA MECCANICA',
          ...preview.diff.split('\n')] :
        ['Nessun diff verificabile per questa proposta.',
          'Stato: '+(preview?.status??'NON DISPONIBILE'),
          'Non inventare patch: serve preparazione e revisione.']) :
      ['PROPOSTA · '+item.action+' · '+item.readiness,
       'ID: '+item.id,'',
       'DESTINAZIONE',
       source(item.target),
       'ORIGINE',
       source(item.source),
       ...evidenceDetailLines(item,semanticAudit),
       '',
       'MOTIVO DELLA PROPOSTA',
       item.summary,
       '',
       'EVIDENZE INCLUSE',
       ...(item.evidence||[]).map(e=>'  '+source(e)+(e.sha256?'  sha256 '+e.sha256:'')),
       'PASSAGGI PROPOSTI',...(item.proposed_steps||[]).map(s=>'  • '+s),
       'LIMITI',...(item.risk_notes||[]).map(s=>'  • '+s)];
    // Lifecycle paths may contain spaces: fixed-width wrapping preserves every byte.
    const wrapped=state.view==='preview'&&preview?.lifecycle_candidate?
      wrapDetail(details.map(safe),Math.max(20,width-5)):
      wrapTuiLines(details.map(safe),Math.max(20,width-5));
    // Reserve exactly one progress row and the three footer rows.
    // Oversized virtual viewports made the final diff lines unreachable.
    const max=Math.max(1,height-lines.length-4);
    const start=Math.max(0,Math.min(state.scroll??0,Math.max(0,wrapped.length-max)));
    lines.push(fmt('Righe '+(wrapped.length?start+1:0)+'–'+Math.min(wrapped.length,start+max)+
      '/'+wrapped.length+'   ↑↓ per leggere tutto','gray'));
    for(const line of wrapped.slice(start,start+max)){
      lines.push(fmt(line,
        state.view==='preview' && line.startsWith('+')?'green':
        state.view==='preview' && line.startsWith('-')?'red':'bold'));
    }

  }
  // Mascot is decoration only: no extra lines, no changes to panes or input.
  const branded=guidedOverview?decorateWizardOverview(lines,{width,height,colors}):lines;
  return pinCommandHints(branded,commandHints(state.view,{
    narrow:width<90,twoPane:width>=100&&height>=20,searching:state.searching,
    providerPickerEnabled,modelConfigured,editorConfigured,applyConfigured,
    proposalCount:items.length,hasSemanticReport:Boolean(semanticAudit)
  }),{height,width,fmt});
}

export function reviewSessionDraft(catalog,state){
  const ids=state.selected.map(i=>catalog.items[i]?.id).filter(Boolean);
  const selection=planHumanSelection(catalog,ids.length?{mode:'SUBSET',ids}:{mode:'NONE'});
  return {schema_version:1,mode:'DRAFT_ONLY',catalog_sha256:catalog.catalog_sha256,
    selected_ids:ids,discarded_ids:state.discarded.map(i=>catalog.items[i]?.id).filter(Boolean),
    selection,write_authorized:false,applied_count:0,
    note:'This is a local draft, not a final user confirmation or instruction to apply.'};
}

export async function runReviewTui(folder,{input=process.stdin,output=process.stdout,
  consumerRoot=null,providerRoot=null,clientFactory=null,editor=undefined,
  moveDestinationDir=null,providerFactory=null,initialProvider=null}={}){
  if(!input.isTTY||!output.isTTY||!input.setRawMode)
    throw Error('La TUI richiede un terminale interattivo (TTY).');
  const load=(file,required=false)=>{
    const filename=path.join(folder,file);
    if(!fs.existsSync(filename)){if(required)throw Error('File mancante: '+file);return null;}
    return JSON.parse(fs.readFileSync(filename,'utf8'));
  };
  let proposals=load('repair-proposals.json',true);
  let previews=loadReviewPreviews(folder,proposals,load('repair-previews.json'));
  let catalog=buildReviewCatalog(proposals,{previews});
  const extra={previews,scopeHints:load('scope-hints.json'),
    sourceChecks:load('source-consistency.json'),localScan:load('local-scan-summary.json'),
    semanticAudit:load('semantic-audit.json')};
  let state=initialTuiState({guided:true});
  let providerSelection=initialProviderSelection(initialProvider??{});
  let providerWizard=null;
  let domainWizard=null;
  try{
    const stored=readReviewSession(folder);
    if(stored){
      const restored=restoreReviewSession(catalog,stored);
      state={...state,...restored,notice:
        'Bozza ripresa: '+restored.selected.length+' selezionate, '+
        restored.discarded.length+' scartate. Nessuna applicazione.'};
    }
  }catch(error){
    state.notice='Ripresa rifiutata: '+error.message+' (sessione nuova).';
  }
  const draw=()=>output.write(CSI+'2J'+CSI+'H'+renderReviewTui(catalog,state,{
    ...extra,columns:output.columns,rows:output.rows,
    colors:!process.env.NO_COLOR,
    applyConfigured:Boolean(consumerRoot && previews?.previews?.some(p=>p.status==='PREVIEW_READY')),
    editorConfigured:Boolean(consumerRoot),
    modelConfigured:Boolean(consumerRoot && (clientFactory||providerFactory)),
    providerPickerEnabled:typeof providerFactory==='function',
    providerSelection,providerWizard,domainWizard
  }));
  let busy=false;
  const draftIds=()=>{
    if(state.view!=='list'||state.searching||!consumerRoot)
      throw Error('Apri la lista con un progetto esplicito per preparare la patch');
    const focus=catalog.items[state.cursor];
    if(!focus||focus.action!=='UPDATE'||!focus.target||!focus.source)
      throw Error('Questa proposta non è una UPDATE di uno SKILL.md esistente');
    const key=focus.target.repo+'\0'+focus.target.path;
    const group=focus.group_ids?.length>1?focus.group_ids:
      (state.selected.includes(state.cursor)?
        catalog.items.filter((item,i)=>state.selected.includes(i)&&
          item.action==='UPDATE'&&item.target?.repo+'\0'+item.target?.path===key)
          .map(item=>item.id):[focus.id]);
    return group.length?group:[focus.id];
  };
  const refreshDraft=(message,{method=null,ids=[]}={})=>{
    const selectedIds=state.selected.map(i=>catalog.items[i]?.id);
    const discardedIds=state.discarded.map(i=>catalog.items[i]?.id);
    const focused=catalog.items[state.cursor]?.id;
    const nextPreviews=loadReviewPreviews(folder,proposals,load('repair-previews.json'));
    const nextCatalog=buildReviewCatalog(proposals,{previews:nextPreviews});
    previews=nextPreviews;
    catalog=nextCatalog;
    extra.previews=previews;
    const indexes=ids=>ids.map(id=>catalog.items.findIndex(item=>item.id===id))
      .filter(i=>i>=0);
    const focusIndex=catalog.items.findIndex(item=>item.id===focused);
    state={...state,cursor:focusIndex>=0?focusIndex:0,
      selected:indexes(selectedIds),discarded:indexes(discardedIds),
      view:'preview',scroll:0,notice:message,
      draftResult:method?{method,ids}:null};
  };
  const suspendTerminal=()=>{
    input.removeListener('keypress',handler);
    input.setRawMode(false);input.pause();
    output.write(CSI+'?25h'+CSI+'?1049l');
  };
  const resumeTerminal=()=>{
    output.write(CSI+'?1049h'+CSI+'?25l');
    input.setRawMode(true);input.resume();
    input.on('keypress',handler);
  };
  const editMessage=()=>{
    try{
      const selected=catalog.items[state.cursor];
      if(selected?.action==='CREATE'){
        if(!consumerRoot)throw Error('CREATE editor requires a project root');
        suspendTerminal();
        try{
          const result=editCreateSkill(folder,{consumerRoot,proposalId:selected.id,editor});
          refreshDraft('Bozza CREATE pronta. Leggi il diff, torna alla lista e seleziona.',
            {method:'EDITOR',ids:[result.proposal_id]});
        }finally{resumeTerminal();}
      }else{
        const ids=draftIds();
        suspendTerminal();
        try{
          const result=editUpdateDraft(folder,{consumerRoot,proposalIds:ids,editor});
          refreshDraft('Bozza da editor pronta: controlla il diff prima della selezione.',
            {method:'EDITOR',ids:result.proposal_ids});
        }finally{resumeTerminal();}
      }
    }catch(error){
      state.notice='EDITOR: '+error.message;
    }
    draw();
  };
  const semanticMessage=async()=>{
    if(typeof clientFactory!=='function'&&typeof providerFactory!=='function'){
      state.notice='Audit semantico: seleziona un provider con L.';
      draw();return;
    }
    if(typeof providerFactory==='function'){
      try{validateProviderSelection(providerSelection);}
      catch(error){state.notice='LLM: '+error.message+' (L per configurare).';draw();return;}
    }
    busy=true;
    state.notice='Audit semantico richiesto: skill e frammenti di codice saranno inviati al modello.';
    draw();
    let client;
    try{
      client=typeof providerFactory==='function'?
        providerFactory({...providerSelection}):clientFactory();
      const report=await performSemanticAudit(folder,{consumerRoot,client});
      const previousSelected=state.selected.map(i=>catalog.items[i]?.id);
      const previousDiscarded=state.discarded.map(i=>catalog.items[i]?.id);
      proposals=load('repair-proposals.json',true);
      previews=loadReviewPreviews(folder,proposals,load('repair-previews.json'));
      catalog=buildReviewCatalog(proposals,{previews});
      extra.previews=previews;
      extra.semanticAudit=report;
      const indexes=ids=>ids.map(id=>catalog.items.findIndex(item=>item.id===id))
        .filter(i=>i>=0);
      state={...state,view:'semantic-list',semanticCursor:0,cursor:0,scroll:0,
        overviewChoice:null,selected:indexes(previousSelected),discarded:indexes(previousDiscarded),
        notice:'Audit terminato: '+report.claims_checked+' claim esaminate, '+
          report.proposed_updates+' ipotesi UPDATE. Nessuna scrittura nel progetto.'};
    }catch(error){state.notice='AUDIT SEMANTICO: '+error.message;}
    finally{
      try{await closeLlmClient(client);}catch(error){state.notice+=' · '+error.message;}
      busy=false;draw();
    }
  };
  const lifecycleMessage=()=>{
    try{
      if(state.view!=='list'||!consumerRoot)throw Error('Serve la lista e il progetto');
      const current=catalog.items[state.cursor];
      if(!['MOVE','REMOVE'].includes(current?.action))
        throw Error('R prepara solo MOVE/REMOVE. CREATE richiede E editor.');
      const result=stageLifecycle(folder,{consumerRoot,proposalId:current.id,
        destinationDir:current.action==='MOVE'?moveDestinationDir:null});
      refreshDraft(result.action+' preparata: '+result.file_count+
        ' file tracciati. Controlla il diff prima di G.',
        {method:'LIFECYCLE',ids:[current.id]});
    }catch(error){state.notice='AZIONE: '+error.message;}
    draw();
  };
  const modelMessage=async()=>{
    if(typeof clientFactory!=='function'&&typeof providerFactory!=='function'){
      state.notice='Per chiedere una proposta di modifica, configura prima un modello con L.';
      draw();return;
    }
    if(typeof providerFactory==='function'){
      try{validateProviderSelection(providerSelection);}
      catch(error){state.notice='LLM: '+error.message+' (L per configurare).';draw();return;}
    }
    let ids;
    try{ids=draftIds();}catch(error){state.notice=error.message;draw();return;}
    busy=true;
    state.notice='Richiesta al modello: nuova versione di SKILL.md per '+
      ids.length+' segnalazioni. Nessun file del progetto viene modificato.';
    draw();
    let client;
    try{
      client=typeof providerFactory==='function'?
        providerFactory({...providerSelection}):clientFactory();
      const result=await generateUpdateDraft(folder,{consumerRoot,proposalIds:ids,client});
      if(result.status==='STAGED')
        refreshDraft('Proposta dell’AI pronta per revisione: leggi il diff. Nessun file modificato.',
          {method:'AI',ids});
      else state.notice='Il modello NON ha preparato una modifica. Serve verifica umana: '+result.reason;
    }catch(error){
      state.notice='MODELLO: '+error.message;
    }finally{
      try{await closeLlmClient(client);}
      catch(error){state.notice+=' (chiusura modello: '+error.message+')';}
      busy=false;draw();
    }
  };
  const beginProvider=()=>{
    if(typeof providerFactory!=='function')return;
    providerWizard={step:'menu',returnView:state.view,text:'',draft:null};
    state.notice='';
    draw();
  };
  const acceptProvider=()=>{
    validateProviderSelection(providerWizard.draft);
    providerSelection={...providerWizard.draft};
    providerWizard=null;
    state.overviewChoice=null; // Changing provider returns focus to the recommended action.
    state.notice='Provider scelto: '+providerDescription(providerSelection)+
      '. Premi M su una UPDATE per chiedere una bozza.';
  };
  const discoverModels=async()=>{
    if(providerWizard?.step!=='model'||typeof providerFactory!=='function')return;
    busy=true;
    let client;
    try{
      const draft={...providerWizard.draft,model:''};
      validateProviderSelection(draft,{needsModel:false});
      client=providerFactory(draft);
      if(typeof client?.doctor!=='function')
        throw Error('Il provider non supporta l’elenco modelli');
      const info=await client.doctor();
      const models=(info.models??[]).map(m=>m?.id??m?.model??m?.name).filter(Boolean);
      if(draft.provider==='copilot')models.unshift('auto');
      if(!models.length)throw Error('Nessun modello disponibile sul server Ollama.');
      const unique=[...new Set(models)];
      providerWizard={...providerWizard,step:'models',models:unique,
        modelCursor:Math.max(0,unique.indexOf(providerWizard.text))};
      state.notice='Scegli un modello. Nessuna generazione effettuata.';
    }catch(error){state.notice='Elenco modelli: '+error.message;}
    finally{
      try{await closeLlmClient(client);}catch{}
      busy=false;draw();
    }
  };
  const providerKey=(ch,command)=>{
    if(command==='escape'){
      if(providerWizard.step==='models'){
        providerWizard={...providerWizard,step:'model'};
      }else{
        providerWizard=null;
        state.notice='Cambio provider annullato.';
      }
      return;
    }
    if(providerWizard.step==='menu'){
      if(command==='1'){
        const model=providerSelection.provider==='copilot'?providerSelection.model:'auto';
        providerWizard={...providerWizard,step:'model',
          text:model||'auto',draft:{provider:'copilot',model:''}};
      }else if(command==='2'){
        providerWizard={...providerWizard,step:'model',text:
          providerSelection.provider==='ollama'?providerSelection.model??'':'',
          draft:{provider:'ollama',baseUrl:LOCAL_OLLAMA_URL,model:''}};
      }else if(command==='4'||command==='5'){
        providerWizard={...providerWizard,draft:{provider:command==='4'?'codex-account':'claude-code-account',model:''}};
        acceptProvider();
      }else if(command==='3'){
        providerWizard={...providerWizard,step:'url',
          text:providerSelection.provider==='ollama' &&
            providerSelection.baseUrl!==LOCAL_OLLAMA_URL?
            providerSelection.baseUrl??'':'http://',
          draft:{provider:'ollama',baseUrl:'',model:''}};
      }
      return;
    }
    if(providerWizard.step==='models'){
      if(command==='up'||command==='down')
        providerWizard.modelCursor=Math.max(0,Math.min(providerWizard.models.length-1,
          providerWizard.modelCursor+(command==='up'?-1:1)));
      else if(command==='t')providerWizard={...providerWizard,step:'model'};
      else if(command==='enter'){
        providerWizard.draft.model=providerWizard.models[providerWizard.modelCursor];
        acceptProvider();
      }
      return;
    }
    if(command==='backspace'){
      providerWizard.text=providerWizard.text.slice(0,-1);return;
    }
    if(command==='tab'&&providerWizard.step==='model'){
      void discoverModels();return;
    }
    if(command==='enter'){
      if(providerWizard.step==='url'){
        const endpoint=providerWizard.text.trim();
        validateProviderSelection({provider:'ollama',baseUrl:endpoint,model:''},
          {needsModel:false});
        providerWizard={...providerWizard,step:'model',text:
          providerSelection.provider==='ollama'?providerSelection.model??'':'',
          draft:{provider:'ollama',baseUrl:endpoint,model:''}};
      }else if(providerWizard.step==='model'){
        providerWizard.draft.model=providerWizard.text.trim()||
          (providerWizard.draft.provider==='copilot'?'auto':'');
        acceptProvider();
      }
      return;
    }
    if(typeof ch==='string'&&ch.length===1&&!/[\x00-\x1f\x7f]/.test(ch)&&
      providerWizard.text.length<512)
      providerWizard.text+=ch;
  };
  const applyMessage=()=>{
    if(state.view!=='list'){
      state.notice='Apri le proposte, prepara e seleziona le modifiche; G verifica il lotto.';
      return;
    }
    const draft=reviewSessionDraft(catalog,state);
    try{
      const plan=prepareReviewedApply(catalog,draft.selected_ids,previews,
        {consumerRoot,providerRoot});
      state={...state,view:'confirm-apply',pendingApply:plan,scroll:0,notice:''};
    }catch(error){
      state.notice='NON APPLICABILE: '+error.message+
        '. Serve una patch concreta; puoi prepararne una prima di confermare.';
    }
  };
  const confirmMessage=()=>{
    try{
      const result=commitReviewedApply(state.pendingApply,{
        catalog,previews,consumerRoot,providerRoot,auditFolder:folder,
        confirmation:'APPLY'
      });
      state={...state,view:'overview',pendingApply:null,
        selected:[],notice:(result.status==='APPLIED'?'Applicate ':'ATTENZIONE '+result.status+' ')+
          result.selected_count+' proposte in '+result.applied_count+
          ' operazioni. Backup: '+result.backup_directory+
          (result.receipt_warning?' AVVISO: '+result.receipt_warning:
            ' Ricevuta: '+result.receipt)};
    }catch(error){
      state={...state,view:'list',pendingApply:null,
        notice:'APPLY NON COMPLETATO: '+error.message};
    }
  };
  const handler=(ch,key={})=>{
    const command=key.name==='return'?'enter':key.name==='space'?'space':
      key.name==='escape'?'escape':key.name || ch;
    if(busy)return;
    if(key.ctrl&&command==='c'){finish();return;}
    if(providerWizard){
      try{providerKey(ch,command);}catch(error){state.notice='LLM: '+error.message;}
      draw();return;
    }
    if(state.view==='help'){
      if(['escape','enter','?'].includes(command))
        state={...state,view:state.helpReturnView??'overview',
          helpReturnView:null,scroll:0};
      else if(command==='up'||command==='down')
        state={...state,scroll:Math.max(0,(state.scroll??0)+(command==='up'?-1:1))};
      draw();return;
    }
    if(command==='?'&&!state.searching&&state.view!=='confirm-apply'){
      state={...state,helpReturnView:state.view,view:'help',scroll:0};
      draw();return;
    }
    if(command==='l'&&!state.searching&&state.view!=='confirm-apply'&&
       typeof providerFactory==='function'){
      beginProvider();return;
    }
    if(command==='q'&&!state.searching){finish();return;}
    if(state.view==='overview'&&['up','down','enter','v'].includes(command)){
      const options=overviewActions({
        hasSemanticReport:Boolean(extra.semanticAudit),
        modelConfigured:Boolean(consumerRoot&&(clientFactory||providerFactory)),
        providerPickerEnabled:typeof providerFactory==='function',
        proposalCount:catalog.items.length,modelLabel:providerDescription(providerSelection)
      });
      if(command==='up'||command==='down'){
        state.overviewChoice=moveOverviewChoice(options,state.overviewChoice,
          command==='up'?-1:1);
        draw();return;
      }
      const chosen=activeOverviewChoice(options,state.overviewChoice);
      if(chosen?.id==='audit'){void semanticMessage();return;}
      if(chosen?.id==='results'){
        state={...state,view:'semantic-list',semanticCursor:0,scroll:0};
        draw();return;
      }
      if(chosen?.id==='provider'){beginProvider();return;}
      if(chosen?.id==='proposals'){
        state=updateTuiState(state,'enter',catalog.items.length,{items:catalog.items});
        draw();return;
      }
      draw();return;
    }
    if(state.view==='semantic-list'||state.view==='semantic-detail'){
      if(command==='escape'){
        state={...state,view:state.view==='semantic-detail'?'semantic-list':'overview',scroll:0};
      }else if(state.view==='semantic-list'){
        if(command==='up'||command==='down')state.semanticCursor=Math.max(0,
          Math.min((extra.semanticAudit?.findings?.length??1)-1,
            (state.semanticCursor??0)+(command==='up'?-1:1)));
        else if(command==='enter' && extra.semanticAudit?.findings?.length)
          state={...state,view:'semantic-detail',scroll:0};
      }else if(command==='up'||command==='down')state.scroll=Math.max(0,
        (state.scroll??0)+(command==='up'?-1:1));
      draw();return;
    }
    if(command==='tab'&&state.view==='list'&&!state.searching){
      if(output.columns>=100&&output.rows>=20)
        state={...state,paneFocus:state.paneFocus==='proposals'?'evidence':'proposals'};
      draw();return;
    }
    if(command==='k'&&!state.searching&&['overview','list'].includes(state.view)){
      void semanticMessage();return;
    }
    if(command==='j'&&!state.searching&&extra.semanticAudit&&
       ['overview','list'].includes(state.view)){
      state={...state,view:'semantic-list',semanticCursor:0,scroll:0};
      draw();return;
    }
    if(state.view==='confirm-apply'){
      if(command==='y')confirmMessage();
      else if(command==='escape')state={...state,view:'list',pendingApply:null,
        notice:'Applicazione annullata. Nessun file modificato.'};
      else if(command==='up'||command==='down'){
        const width=Math.max(40,output.columns),height=Math.max(1,output.rows||14);
        const viewport=Math.max(1,height-10-(state.notice?1:0)-
          (typeof providerFactory==='function'?1:0));
        const maxScroll=Math.max(0,confirmationDetails(
          state.pendingApply?.candidates??[],width).length-viewport);
        state={...state,scroll:Math.max(0,Math.min(maxScroll,
          (state.scroll??0)+(command==='up'?-1:1)))};
      }
      draw();return;
    }
    if(command==='e' && state.view==='list' && !state.searching){
      editMessage();return;
    }
    if(command==='m' && state.view==='list' && !state.searching){
      void modelMessage();return;
    }
    if(command==='r' && state.view==='list' && !state.searching){
      lifecycleMessage();return;
    }
    if(command==='g' && !state.searching)applyMessage();
    else if(command==='s' && !state.searching){
      const draft=reviewSessionDraft(catalog,state);
      try{
        saveReviewSession(folder,draft);
        state.notice='Bozza salvata. Nessun repository modificato.';
      }catch(error){
        state.notice='Salvataggio non riuscito: '+error.message;
      }
    }else{
      const printable=typeof ch==='string' && ch.length===1 &&
        ch.charCodeAt(0)>=32 && ch.charCodeAt(0)!==127 && !key.ctrl && !key.meta;
      const actual=state.searching && printable?'text':command;
      state=updateTuiState(state,actual,catalog.items.length,{
        items:catalog.items,
        scopeCount:diagnosticEntries('scope',extra).length,
        consistencyCount:diagnosticEntries('consistency',extra).length,
        twoPane:output.columns>=100&&output.rows>=20,
        text:ch
      });
      if(!state.searching && command==='space')state.notice='';

    }
    draw();
  };
  let finish;
  return new Promise(resolve=>{
    finish=()=>{
      input.removeListener('keypress',handler);
      input.setRawMode(false);input.pause();
      output.write(CSI+'?25h'+CSI+'?1049l');
      resolve(reviewSessionDraft(catalog,state));
    };
    readline.emitKeypressEvents(input);
    output.write(CSI+'?1049h'+CSI+'?25l');
    input.setRawMode(true);input.resume();
    input.on('keypress',handler);draw();
  });
}
