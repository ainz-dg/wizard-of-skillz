import test from 'node:test';
import assert from 'node:assert/strict';
import {commandHints,contextualHelp} from '../src/tui-help.mjs';
import {draftInstructions,reviewRow,renderReviewWorkspace} from '../src/tui-review-layout.mjs';

test('M is described as a proposed replacement, not an automatic correction or Apply',()=>{
  const help=contextualHelp('list').join('\n');
  assert.match(help,/M invia skill e prove all’AI/);
  assert.match(help,/nuovo SKILL\.md completo/);
  assert.match(help,/non è una correzione verificata/);
  const keys=commandHints('list',{
    twoPane:true,modelConfigured:true,editorConfigured:true,applyConfigured:false
  }).join('\n');
  assert.match(keys,/M Proponi modifica \(AI\)/);
  assert.match(keys,/G Non applicabile/);
  const compact=commandHints('list',{twoPane:false,applyConfigured:false}).join('\n');
  assert.match(compact,/G DISABILITATO/);
  assert.match(compact,/M Proposta AI/);
});

test('generated revision indicates full diff review, no repository write and separate human approval',()=>{
  const lines=draftInstructions({method:'AI',selected:false}).join('\n');
  assert.match(lines,/PROPOSTA DI MODIFICA GENERATA DALL’AI/);
  assert.match(lines,/DA VERIFICARE/);
  assert.match(lines,/SKILL\.md originale NON è stato modificato/);
  assert.match(lines,/Leggi il diff/);
  assert.match(lines,/SPAZIO seleziona/);
  assert.match(lines,/G verifica il lotto/);
  assert.match(lines,/solo Y conferma/);
});

test('readiness label is awaiting human review, not an assertion that code is correct',()=>{
  const row=reviewRow({
    action:'UPDATE',readiness:'PREVIEW_READY',id:'a',title:'Parsing contract'
  },0,{focused:true,width:70});
  assert.match(row,/DA RIVEDERE/);
  assert.doesNotMatch(row,/CORRETTA|VERIFICATA|APPROVATA/);
});
test('workspace explains M only for UPDATE and directs CREATE/MOVE to valid preparation actions',()=>{
  const item=(action)=>({
    id:'example',title:'Example',action,readiness:'MANUAL_ONLY',
    target:{repo:'r',path:'.agents/skills/a/SKILL.md'},source:{repo:'r',path:'.agents/skills/a/SKILL.md'},
    evidence:[],summary:'Human check'
  });
  const pane=action=>renderReviewWorkspace({
    items:[item(action)],visible:[0],state:{cursor:0,selected:[],discarded:[]},
    width:145,height:28
  }).lines.join('\n');
  assert.match(pane('UPDATE'),/M chiede al modello una versione completa/);
  assert.match(pane('CREATE'),/E apre l’editor/);
  assert.doesNotMatch(pane('CREATE'),/M chiede/);
  assert.match(pane('MOVE'),/R prepara MOVE\/REMOVE/);
});
