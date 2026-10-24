import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReviewCatalog} from '../src/review-selection.mjs';
import {renderReviewTui,initialTuiState,updateTuiState,visibleProposalIndices}
  from '../src/review-tui.mjs';
import {renderReviewWorkspace,reviewWindow,draftInstructions}
  from '../src/tui-review-layout.mjs';

const repo='test/repo';
const source='.agents/skills/parsing-contract/SKILL.md';
const quote="return 'anonymous'; // actual behavior on blank input";
function fixture(count=50){
  const proposals=Array.from({length:count},(_,i)=>({
    id:'ISSUE-'+i,
    action:'UPDATE',title:'Investigate the contract for parsing input '+i,
    source:{repo,path:source},target:{repo,path:source},
    reason:'The skill may contradict the parser; inspect evidence for item '+i,
    evidence:[{repo,path:'src/parsing.ts'}],
    priority:i%3===0?'HIGH':'LOW',
    limits:['Human verification is required']
  }));
  const previews={
    consumer_repo:repo,
    previews:proposals.slice(0,3).map(p=>({
      proposal_id:p.id,status:'PREVIEW_READY',
      diff:'--- a/'+source+'\n+++ b/'+source+'\n@@ -1 +1 @@\n-old\n+new',
    }))
  };
  return {catalog:buildReviewCatalog({consumer_repo:repo,proposals},{previews}),previews};
}
const findings=[{
  proposal_id:'ISSUE-30',skill:source,skill_line:5,
  statement:'The parser always throws for blank input and must never return anonymous.',
  assessment:'SUSPECTED_CONTRADICTION',
  evidence:{path:'src/parsing.ts',line:39,
    quote:"return 'anonymous'; // actual behavior on blank input"},
  reason:'The cited source returns anonymous instead of throwing an exception.'
}];
const semanticAudit={findings,claims_checked:1,proposed_updates:1};

test('70 proposals remain bounded, with selected status and accurate position',()=>{
  const {catalog,previews}=fixture(70);
  const state={...initialTuiState(),view:'list',cursor:55,selected:[0,2,55],
    paneFocus:'proposals'};
  const visible=visibleProposalIndices(catalog.items,state);
  const display=renderReviewWorkspace({items:catalog.items,visible,state,previews,
    semanticAudit,width:124,height:24});
  assert.equal(display.lines.length,23);
  assert.equal(display.window.total,70);
  assert.equal(display.window.current,56);
  assert.equal(display.selectedCount,3);
  assert.equal(display.readySelected,2);
  assert.match(display.lines.join('\n'),/❯ ✓  56 UPDATE/);
  assert.match(display.lines.join('\n'),/Visibili [0-9]+-[0-9]+\/70/);
  assert.match(display.lines.at(0),/^┌/);
  assert.match(display.lines.at(-1),/^└/);
  assert.ok(display.lines.every(line=>line.length<=122));
});
test('right pane displays full selected claim, quote and rationale by scrolling',()=>{
  const {catalog,previews}=fixture(50);
  const base={...initialTuiState(),view:'list',cursor:30,
    paneFocus:'evidence',selected:[30]};
  const frames=[];
  for(let i=0;i<40;i++){
    frames.push(renderReviewWorkspace({
      items:catalog.items,visible:visibleProposalIndices(catalog.items,base),
      state:{...base,paneScroll:i},semanticAudit,previews,width:115,height:21
    }).lines.join('\n'));
  }
  const complete=frames.join('\n');
  assert.match(complete,/AFFERMAZIONE DELLA SKILL/);
  assert.match(complete,/parser always throws/);
  assert.match(complete,/CODICE CITATO/);
  assert.match(complete,/return 'anonymous'/);
  assert.match(complete,/The cited source returns/);
  assert.match(complete,/REVISIONE \[ATTIVO\]/);
});
test('Tab focus semantics keep list navigation and evidence scrolling independent',()=>{
  const {catalog}=fixture(50);
  const state={...initialTuiState(),view:'list',cursor:19,
    paneFocus:'evidence',paneScroll:0};
  const scrolled=updateTuiState(state,'down',catalog.items.length,{
    items:catalog.items,twoPane:true});
  assert.equal(scrolled.cursor,19);
  assert.equal(scrolled.paneScroll,1);
  const narrowed=updateTuiState(state,'down',catalog.items.length,{
    items:catalog.items,twoPane:false});
  assert.equal(narrowed.cursor,20);
  assert.equal(narrowed.paneScroll,0);
  const list=updateTuiState({...state,paneFocus:'proposals',paneScroll:5},
    'down',catalog.items.length,{items:catalog.items,twoPane:true});
  assert.equal(list.cursor,20);
  assert.equal(list.paneScroll,0);
});
test('full screen uses bounded two panes; narrow view retains one-column fallback',()=>{
  const {catalog,previews}=fixture(50);
  const state={...initialTuiState(),view:'list',cursor:41};
  const wide=renderReviewTui(catalog,state,{previews,semanticAudit,
    columns:126,rows:28,colors:false,modelConfigured:true});
  assert.match(wide,/┌─/);
  assert.match(wide,/REVISIONE/);
  assert.match(wide,/TAB Cambia pannello/);
  assert.match(wide,/LOTTO: 0 selezionate/);
  assert.ok(wide.split('\n').length<=28);
  const narrow=renderReviewTui(catalog,state,{previews,semanticAudit,
    columns:76,rows:20,colors:false,modelConfigured:true});
  assert.doesNotMatch(narrow,/┌─/);
  assert.match(narrow,/❯/);
  assert.ok(narrow.split('\n').length<=20);
});
test('AI draft is an intermediate stage, never an automatic apply',()=>{
  const lines=draftInstructions({method:'AI',selected:false});
  assert.match(lines.join('\n'),/PROPOSTA DI MODIFICA GENERATA DALL’AI/);
  assert.match(lines.join('\n'),/SKILL\.md originale NON è stato modificato/);
  assert.match(lines.join('\n'),/Leggi il diff/);
  assert.match(lines.join('\n'),/SPAZIO seleziona/);
  assert.match(lines.join('\n'),/G verifica il lotto/);
  assert.match(lines.join('\n'),/Y conferma/);
});
