import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildReviewCatalog,planHumanSelection} from '../src/review-selection.mjs';
import {readReviewSession,restoreReviewSession,saveReviewSession} from '../src/review-session.mjs';
import {initialTuiState,reviewSessionDraft} from '../src/review-tui.mjs';

const proposal=(id)=>({
  id,action:'UPDATE',title:'Review '+id,source:{repo:'sample/repo',path:id+'/SKILL.md'},
  target:{repo:'sample/repo',path:id+'/SKILL.md'}
});
const catalog=buildReviewCatalog({consumer_repo:'sample/repo',
  proposals:[proposal('a'),proposal('b'),proposal('c')]});
const draft=(selected=[0],discarded=[1])=>reviewSessionDraft(catalog,{
  ...initialTuiState(),selected,discarded
});

test('session round-trip maps stable proposal IDs back to indices',()=>{
  const source=draft([2,0],[1]);
  const result=restoreReviewSession(catalog,source);
  assert.deepEqual(result,{selected:[0,2],discarded:[1]});
  assert.equal(source.write_authorized,false);
  assert.equal(source.applied_count,0);
});

test('strictly reject draft from another catalog even with coincident proposal IDs',()=>{
  const changed=buildReviewCatalog({consumer_repo:'sample/repo',
    proposals:[{...proposal('a'),title:'Edited'},proposal('b'),proposal('c')]});
  assert.throws(()=>restoreReviewSession(changed,draft()),/catalogo corrente/);
});

test('reject unknown, duplicate, overlapping IDs and inconsistent plans',()=>{
  const original=draft([0],[1]);
  const mutate=changes=>({...original,...changes});
  assert.throws(()=>restoreReviewSession(catalog,mutate({selected_ids:['unknown']})),/sconosciuti/);
  assert.throws(()=>restoreReviewSession(catalog,mutate({selected_ids:['a','a']})),/duplicati/);
  assert.throws(()=>restoreReviewSession(catalog,mutate({discarded_ids:['a']})),/contemporaneamente/);
  assert.throws(()=>restoreReviewSession(catalog,mutate({selection:{...original.selection,
    selection_sha256:'0'.repeat(64)}})),/piano salvato/);
  assert.throws(()=>restoreReviewSession(catalog,mutate({write_authorized:true})),/autorizzazioni/);
  assert.throws(()=>restoreReviewSession(catalog,mutate({applied_count:1})),/autorizzazioni/);
  assert.throws(()=>restoreReviewSession(catalog,mutate({schema_version:77})),/catalogo corrente/);
  assert.throws(()=>restoreReviewSession(catalog,mutate({discarded_ids:null})),/non valida/);
  assert.throws(()=>restoreReviewSession(catalog,mutate({selected_ids:['a','c']})),/piano salvato/);
});

test('save is atomic, private and does not overwrite a symlink target',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-session-'));
  const outside=path.join(folder,'outside.txt');
  const file=path.join(folder,'review-session.json');
  try{
    assert.equal(readReviewSession(folder),null);
    const original=draft();
    saveReviewSession(folder,original);
    assert.deepEqual(restoreReviewSession(catalog,readReviewSession(folder)),
      {selected:[0],discarded:[1]});
    assert.equal(fs.statSync(file).mode&0o777,0o600);
    saveReviewSession(folder,draft([2],[]));
    assert.deepEqual(restoreReviewSession(catalog,readReviewSession(folder)),
      {selected:[2],discarded:[]});
    assert.deepEqual(fs.readdirSync(folder),['review-session.json']);
    fs.unlinkSync(file);
    fs.writeFileSync(outside,'unchanged');
    fs.symlinkSync(outside,file);
    assert.throws(()=>readReviewSession(folder),/non è un file regolare/);
    assert.throws(()=>saveReviewSession(folder,original),/Rifiutato/);
    assert.equal(fs.readFileSync(outside,'utf8'),'unchanged');
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
});

test('malformed files are not silently interpreted as empty sessions',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-session-'));
  try{
    fs.writeFileSync(path.join(folder,'review-session.json'),'{broken');
    assert.throws(()=>readReviewSession(folder),SyntaxError);
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
});
