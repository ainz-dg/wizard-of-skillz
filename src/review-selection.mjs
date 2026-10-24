/**
 * Human-in-the-loop review catalog, intentionally read-only.
 * A selected item is NOT an authorization to modify any repository.
 */
import { createHash } from 'node:crypto';

const ACTIONS = new Set(['CREATE','MOVE','UPDATE','REMOVE']);
const PREVIEW = new Set(['PREVIEW_READY','MANUAL_ONLY','BLOCKED']);
const SHA = /^[a-f0-9]{64}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasText = value => typeof value === 'string' && value.trim().length > 0;
const stable = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function safeLocation(loc) {
  if(!plain(loc) || !hasText(loc.repo) || !hasText(loc.path))return null;
  const p=loc.path;
  if(p.length>1024 || p.includes('\0') || p.includes('\\') || p.startsWith('/') ||
    /^(?:[A-Za-z]:|~)/.test(p) || p.split('/').some(x=>!x || x==='.' || x==='..'))
    return null;
  return {repo:loc.repo,path:p};
}
const locationKey = loc => loc ? loc.repo + '\0' + loc.path : null;

/** Existing Java proposals are converted into UPDATE items, but generic
 * future adapters can submit CREATE/MOVE/UPDATE/REMOVE explicitly.
 * No target is inferred for CREATE or MOVE.
 */
export function buildReviewCatalog(source,{previews=null}={}) {
  if(!plain(source) || !Array.isArray(source.proposals))
    throw Error('Expected a source proposal set with proposals[]');
  const original=source.proposals;
  const ids=new Set();
  const previewMap=new Map();
  if(previews !== null) {
    if(!plain(previews) || !Array.isArray(previews.previews))
      throw Error('Invalid preview export');
    if(source.consumer_repo && previews.consumer_repo && source.consumer_repo!==previews.consumer_repo)
      throw Error('Preview consumer repository does not match proposal source');
    for(const p of previews.previews) {
      if(!hasText(p.proposal_id) || previewMap.has(p.proposal_id))
        throw Error('Duplicated or invalid preview identity');
      previewMap.set(p.proposal_id,p);
    }
  }
  const items=[];
  for(const p of original) {
    if(!plain(p) || !hasText(p.id) || ids.has(p.id))
      throw Error('Invalid or duplicated proposal ID');
    ids.add(p.id);
    const action=p.action ?? (p.kind==='CONFIRMED_SOURCE_DRIFT'?'UPDATE':null);
    if(!ACTIONS.has(action))throw Error('Unknown action for '+p.id);
    const evidence=(Array.isArray(p.evidence)?p.evidence:[]).map(e=>{
      if(!plain(e) || !hasText(e.repo) || !hasText(e.path))throw Error('Invalid evidence for '+p.id);
      return {repo:e.repo,path:e.path,sha256:SHA.test(e.sha256||'')?e.sha256:null};
    });
    let sourceLoc=p.source ? safeLocation(p.source) : null;
    let targetLoc=p.target ? safeLocation(p.target) : null;
    if(!p.target && action==='UPDATE' && p.kind==='CONFIRMED_SOURCE_DRIFT') {
      const owner=source.consumer_repo;
      const originalSkill=evidence.find(e=>e.repo===owner && /(?:^|\/)SKILL\.md$/.test(e.path));
      if(originalSkill)targetLoc=safeLocation(originalSkill);
    }
    if(!p.source && (action==='UPDATE'||action==='REMOVE'))sourceLoc=targetLoc;
    if((p.source && !sourceLoc)||(p.target && !targetLoc))
      throw Error('Unsafe proposal source or target path: '+p.id);
    if(action==='MOVE' && (!sourceLoc || !targetLoc || locationKey(sourceLoc)===locationKey(targetLoc)))
      throw Error('MOVE requires distinct explicit source and target: '+p.id);
    if(action==='CREATE' && sourceLoc)throw Error('CREATE must not have existing source location');
    if((action==='UPDATE'||action==='REMOVE') && sourceLoc && targetLoc &&
      locationKey(sourceLoc)!==locationKey(targetLoc))
      throw Error(action+' cannot implicitly relocate a skill: '+p.id);
    const referencedPreview=previewMap.get(p.id);
    if(referencedPreview && !PREVIEW.has(referencedPreview.status))
      throw Error('Invalid preview status for '+p.id);
    // A computed candidate is never approved just because it is previewable.
    let readiness=referencedPreview?.status || 'MANUAL_ONLY';
    if(!targetLoc && action!=='REMOVE')readiness='BLOCKED';
    if(!sourceLoc && (action==='UPDATE'||action==='MOVE'||action==='REMOVE'))readiness='BLOCKED';
    const dependencies=Array.isArray(p.depends_on)?p.depends_on:[];
    if(dependencies.some(d=>!hasText(d))||new Set(dependencies).size!==dependencies.length)
      throw Error('Invalid dependencies for '+p.id);
    items.push({
      id:p.id,action,title:hasText(p.title)?p.title:p.id,
      summary:hasText(p.reason)?p.reason:'',
      priority:p.priority ?? 'UNRANKED',
      skill:p.skill??null,source:sourceLoc,target:targetLoc,
      readiness,evidence,depends_on:dependencies,
      risk_notes:Array.isArray(p.limits)?p.limits.filter(hasText):[],
      proposed_steps:Array.isArray(p.steps)?p.steps.filter(hasText):[],
      preview_status:referencedPreview?.status??null,
      preview_ref:referencedPreview?.status==='PREVIEW_READY'?p.id:null,
      group_ids:referencedPreview?.status==='PREVIEW_READY' &&
        Array.isArray(referencedPreview.group_ids)?referencedPreview.group_ids:[p.id],
      write_authorized:false
    });
  }
  for(const item of items){
    for(const dep of item.depends_on){
      if(!ids.has(dep)||dep===item.id)throw Error('Unknown/self dependency in '+item.id+': '+dep);
    }
    if(!Array.isArray(item.group_ids)||!item.group_ids.includes(item.id)||
       new Set(item.group_ids).size!==item.group_ids.length||
       item.group_ids.some(id=>!ids.has(id)))
      throw Error('Invalid consolidated preview group: '+item.id);
  }
  for(const item of items){
    if(item.group_ids.length<=1)continue;
    for(const member of item.group_ids){
      const other=items.find(x=>x.id===member);
      if(JSON.stringify([...other.group_ids].sort())!==
         JSON.stringify([...item.group_ids].sort()) ||
         locationKey(other.target)!==locationKey(item.target))
        throw Error('Inconsistent consolidated preview group: '+item.id);
    }
  }
  const catalog={schema_version:1,mode:'REVIEW_ONLY',default_selection:'NONE',
    source_repositories:{consumer:source.consumer_repo??null,provider:source.provider_repo??null},
    items,write_authorized:false,confirmation_required:true};
  return {...catalog,catalog_sha256:stable(catalog)};
}

const touches=item=>{
  const entries=[];
  if(item.action==='MOVE'){
    if(item.source)entries.push(item.source);
    if(item.target)entries.push(item.target);
  } else if(item.action==='REMOVE') {
    if(item.source)entries.push(item.source);
  } else if(item.target)entries.push(item.target);
  return entries.map(locationKey);
};

/** Produces a REVIEW REQUEST, not consent, signature, or a patch application.
 * ALL includes all review items and explicitly reveals blocked/manual items.
 */
export function planHumanSelection(catalog,{mode='NONE',ids=[]}={}) {
  if(!plain(catalog) || catalog.schema_version!==1 || !Array.isArray(catalog.items) ||
     catalog.mode!=='REVIEW_ONLY')throw Error('Invalid review catalog');
  const expectedHash=catalog.catalog_sha256;
  const {catalog_sha256,...withoutHash}=catalog;
  if(!SHA.test(expectedHash||'')||stable(withoutHash)!==expectedHash)
    throw Error('Review catalog was modified after creation');
  const chosenMode=String(mode).toUpperCase();
  if(!['NONE','ALL','SUBSET'].includes(chosenMode))throw Error('Selection must be NONE, ALL or SUBSET');
  if(!Array.isArray(ids)||ids.some(x=>!hasText(x)))throw Error('Invalid selected IDs');
  if(chosenMode!=='SUBSET' && ids.length)throw Error('IDs only allowed with SUBSET');
  if(chosenMode==='SUBSET' && (!ids.length||new Set(ids).size!==ids.length))
    throw Error('SUBSET requires unique explicit IDs; use NONE for no changes');
  const byId=new Map(catalog.items.map(item=>[item.id,item]));
  if(byId.size!==catalog.items.length)throw Error('Duplicated review catalog entries');
  if(ids.some(id=>!byId.has(id)))throw Error('Unknown selected proposal ID');
  const selected=new Set(chosenMode==='NONE'?[]:chosenMode==='ALL'?[...byId.keys()]:ids);
  const items=catalog.items.map(item=>({
    id:item.id,action:item.action,title:item.title,
    selected:selected.has(item.id),
    readiness:item.readiness,source:item.source,target:item.target,
    depends_on:item.depends_on,preview_status:item.preview_status
  }));
  const blockers=[];
  const occupied=new Map();
  for(const item of catalog.items) {
    if(!selected.has(item.id))continue;
    if(item.readiness==='BLOCKED')
      blockers.push({type:'BLOCKED_PROPOSAL',id:item.id});
    if(item.readiness!=='PREVIEW_READY')
      blockers.push({type:'MANUAL_PREPARATION_REQUIRED',id:item.id});
    for(const id of item.depends_on)
      if(!selected.has(id))blockers.push({type:'MISSING_DEPENDENCY',id:item.id,depends_on:id});
    for(const id of item.group_ids??[item.id])
      if(!selected.has(id))blockers.push({type:'INCOMPLETE_CONSOLIDATED_GROUP',
        id:item.id,missing:id});
    for(const key of touches(item)){
      const previous=occupied.get(key);
      if(previous && previous.id!==item.id){
        const sameGroup=item.group_ids?.length>1 &&
          previous.group_ids?.length>1 &&
          JSON.stringify([...previous.group_ids].sort())===
          JSON.stringify([...item.group_ids].sort());
        if(!sameGroup)blockers.push({type:'PATH_COLLISION',id:item.id,
          conflicts_with:previous.id});
      }else occupied.set(key,item);
    }
  }
  const resolved={
    schema_version:1,mode:chosenMode,selected_ids:[...selected],
    selected_count:selected.size,rejected_count:catalog.items.length-selected.size,
    items,blockers,ready_for_final_confirmation:selected.size>0&&blockers.length===0,
    confirmation_required:true,write_authorized:false,applied_count:0,
    note:'No files were modified. This is a draft human selection, not the final authorization to apply changes.'
  };
  return {...resolved,selection_sha256:stable({catalog_sha256:expectedHash,mode:chosenMode,ids:[...selected]})};
}

/** Human-readable review of a proposed selection. No apply token or writes. */
export function renderReviewMarkdown(catalog,selection){
  if(!plain(catalog)||!plain(selection)||
     !Array.isArray(catalog.items)||!Array.isArray(selection.items)||
     selection.write_authorized!==false || selection.confirmation_required!==true ||
     selection.applied_count!==0 ||
     selection.items.length!==catalog.items.length)
    throw Error('Invalid non-applying review plan');
  const expected=planHumanSelection(catalog,{
    mode:selection.mode,ids:selection.mode==='SUBSET'?selection.selected_ids:[]
  });
  if(expected.selection_sha256!==selection.selection_sha256 ||
     JSON.stringify(expected)!==JSON.stringify(selection))
    throw Error('Selection does not match the catalog');
  const md=value=>String(value??'').replace(/\s+/g,' ').trim()
    .replace(/[\\`*_[\]#|<>]/g,'\\$&');
  const where=loc=>loc?md(loc.repo)+':'+md(loc.path):'Non specificato';
  const lines=[
    '# Wizard — proposte da esaminare','',
    '**Anteprima in sola lettura. Nessuna modifica è stata applicata.**','',
    '- Scelta: **'+md(selection.mode)+'**',
    '- Selezionate: **'+selection.selected_count+'** / '+catalog.items.length,
    '- Conferma finale richiesta: **sì**',
    '- Autorizzazione alla scrittura: **no**',
    ''
  ];
  for(const item of catalog.items){
    const yes=selection.selected_ids.includes(item.id);
    lines.push('## '+(yes?'[x] ':'[ ] ')+md(item.title),'',
      '- ID: '+md(item.id)+' — '+md(item.action)+' / '+md(item.priority),
      '- Stato: '+md(item.readiness)+(item.readiness==='PREVIEW_READY'?' (diff da verificare)':''),
      '- Origine: '+where(item.source),
      '- Destinazione: '+where(item.target));
    if(item.summary)lines.push('- Motivo: '+md(item.summary));
    if(item.depends_on.length)lines.push('- Dipendenze: '+item.depends_on.map(md).join(', '));
    if(item.evidence.length)lines.push('- Evidenze:',...item.evidence.map(e=>
      '  - '+where(e)+(e.sha256?' (SHA-256 '+md(e.sha256.slice(0,12))+'…)':' (hash non disponibile)')));
    if(item.proposed_steps.length)lines.push('- Interventi proposti:',...item.proposed_steps.map(x=>'  - '+md(x)));
    if(item.risk_notes.length)lines.push('- Limiti e rischi:',...item.risk_notes.map(x=>'  - '+md(x)));
    const issues=selection.blockers.filter(b=>b.id===item.id);
    if(issues.length)lines.push('- Blocchi:',...issues.map(b=>'  - '+md(b.type)+
      (b.depends_on?' (richiede '+md(b.depends_on)+')':'')+
      (b.conflicts_with?' (conflitto con '+md(b.conflicts_with)+')':'')));
    lines.push('');
  }
  if(!selection.selected_count)lines.push('**Nessuna proposta selezionata.**','');
  else if(selection.blockers.length)lines.push(
    '**Le proposte selezionate hanno vincoli da risolvere prima della conferma.**','');
  else lines.push(
    '**Selezione pronta per essere riesaminata; non equivale a un ordine di applicazione.**','');
  return lines.join('\n');
}
