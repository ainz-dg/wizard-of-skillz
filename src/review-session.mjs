/**
 * Persist review decisions only in the audit output folder.
 * A saved draft is never an authorization token or an apply instruction.
 */
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {planHumanSelection} from './review-selection.mjs';

const fileName='review-session.json';
const isRecord=value=>value!==null && typeof value==='object' && !Array.isArray(value);

function uniqueKnownIds(ids,byId,label){
  if(!Array.isArray(ids) || ids.length>byId.size ||
    ids.some(id=>typeof id!=='string' || !byId.has(id)) ||
    new Set(ids).size!==ids.length)
    throw Error('Bozza non valida: '+label+' contiene ID mancanti, duplicati o sconosciuti');
}

/** Strictly restore indices only for the exact catalog and a valid old draft. */
export function restoreReviewSession(catalog,draft){
  if(!isRecord(draft) || draft.schema_version!==1 ||
    draft.mode!=='DRAFT_ONLY'||draft.catalog_sha256!==catalog.catalog_sha256)
    throw Error('Bozza incompatibile con il catalogo corrente (audit cambiato)');
  if(draft.write_authorized!==false || draft.applied_count!==0)
    throw Error('Bozza non valida: autorizzazioni o applicazioni non ammesse');
  const byId=new Map(catalog.items.map((item,i)=>[item.id,i]));
  uniqueKnownIds(draft.selected_ids,byId,'selected_ids');
  uniqueKnownIds(draft.discarded_ids,byId,'discarded_ids');
  const selected=new Set(draft.selected_ids);
  if(draft.discarded_ids.some(id=>selected.has(id)))
    throw Error('Bozza non valida: proposte selezionate e scartate contemporaneamente');
  const recomputed=planHumanSelection(catalog,draft.selected_ids.length?
    {mode:'SUBSET',ids:draft.selected_ids}:{mode:'NONE'});
  const persisted=draft.selection;
  if(!isRecord(persisted) || persisted.mode!==recomputed.mode ||
    persisted.selected_count!==recomputed.selected_count ||
    persisted.selection_sha256!==recomputed.selection_sha256 ||
    persisted.write_authorized!==false || persisted.applied_count!==0 ||
    persisted.confirmation_required!==true ||
    JSON.stringify(persisted.selected_ids)!==JSON.stringify(recomputed.selected_ids))
    throw Error('Bozza non valida: il piano salvato non corrisponde alle selezioni');
  return {
    selected:draft.selected_ids.map(id=>byId.get(id)).sort((a,b)=>a-b),
    discarded:draft.discarded_ids.map(id=>byId.get(id)).sort((a,b)=>a-b)
  };
}

/** Null only for an absent draft. Malformed/unsafe drafts are not silently ignored. */
export function readReviewSession(folder){
  const filename=path.join(folder,fileName);
  let stat;
  try {stat=fs.lstatSync(filename);}
  catch(error){
    if(error.code==='ENOENT')return null;
    throw error;
  }
  if(!stat.isFile())throw Error('Bozza non sicura: review-session.json non è un file regolare');
  if(stat.size>2_000_000)throw Error('Bozza troppo grande');
  return JSON.parse(fs.readFileSync(filename,'utf8'));
}

/** Atomic replace; refuse symlinks and leave inspected source trees untouched. */
export function saveReviewSession(folder,draft){
  const filename=path.join(folder,fileName);
  try {
    const stat=fs.lstatSync(filename);
    if(!stat.isFile())throw Error('Rifiutato salvataggio su file speciale o link simbolico');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=path.join(folder,'.review-session-'+randomBytes(12).toString('hex')+'.tmp');
  try{
    fs.writeFileSync(temporary,JSON.stringify(draft,null,2)+'\n',{flag:'wx',mode:0o600});
    fs.renameSync(temporary,filename);
  }finally{
    try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
