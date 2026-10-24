import test from 'node:test';
import assert from 'node:assert/strict';
import {wrapTuiLines,evidenceDetailLines} from '../src/tui-readable.mjs';
import {buildReviewCatalog} from '../src/review-selection.mjs';
import {renderReviewTui,initialTuiState} from '../src/review-tui.mjs';

const longPath='.agents/skills/parsing-contract/SKILL.md';
const codePath='src/parser/very-long-module-name/handle-a-request-with-a-long-description.ts';
const claim='The parseResult function must throw a TypeError when the supplied value is blank or whitespace.';
const quote="return 'anonymous'; // The real parser does not throw a TypeError for empty input";
const finding={
  proposal_id:'SEM-example',skill:longPath,skill_line:5,statement:claim,
  assessment:'SUSPECTED_CONTRADICTION',
  evidence:{path:codePath,line:77,quote},reason:'The source returns anonymous instead of throwing.',
  limitations:['This model hypothesis is not proof.']
};
const report={claims_checked:2,proposed_updates:1,findings:[finding]};
const catalog=buildReviewCatalog({consumer_repo:'local/fixture',proposals:[{
  id:'SEM-example',action:'UPDATE',
  title:'Verificare: '+claim.slice(0,90),
  source:{repo:'local/fixture',path:longPath},
  target:{repo:'local/fixture',path:longPath},
  reason:'Possibile incoerenza (ipotesi LLM): '+finding.reason,
  evidence:[{repo:'local/fixture',path:longPath},
    {repo:'local/fixture',path:codePath}],
  limits:['La citazione e verificata; il giudizio NON è automaticamente confermato.'],
  steps:['Read the full claim and inspect the source before preparing any change.']
}]});
const screen=(state,opts={})=>renderReviewTui(catalog,state,{
  semanticAudit:report,providerPickerEnabled:true,
  providerSelection:{provider:'copilot',model:'auto'},
  modelConfigured:true,editorConfigured:true,columns:74,rows:26,colors:false,...opts
});
test('wrap preserves complete words and long paths rather than adding ellipses',()=>{
  const input=['Motivo: '+claim,'Sorgente: '+codePath,quote,''];
  const wrapped=wrapTuiLines(input,29);
  assert.ok(wrapped.every(s=>s.length<=29));
  assert.match(wrapped.join(' '),/throw\s+a\s+TypeError/);
  assert.ok(wrapped.some(s=>s.includes('anonymous')));
  assert.ok(wrapped.at(-1)==='');
  assert.ok(!wrapped.join('\n').includes('…'));
  assert.equal(wrapped.filter(s=>s).length>input.length,true);
});
test('semantic proof is shown only for the matching UPDATE ID',()=>{
  const matched=evidenceDetailLines(catalog.items[0],report).join('\n');
  assert.match(matched,/AFFERMAZIONE DELLA SKILL/);
  assert.match(matched,/CODICE CITATO/);
  assert.match(matched,/real parser does not throw/);
  assert.match(matched,/INTERPRETAZIONE DEL MODELLO/);
  assert.match(matched,/NON prova logica/);
  assert.deepEqual(evidenceDetailLines({...catalog.items[0],id:'SEM-other'},report),[]);
});
test('proposal details scroll through original claim, citation and limitation with no data loss',()=>{
  let s={...initialTuiState(),view:'detail',scroll:0};
  let first=screen(s);
  assert.match(first,/Righe 1–/);
  assert.match(first,/AFFERMAZIONE DELLA SKILL/);
  assert.ok(first.split('\n').length<=26);
  assert.doesNotMatch(first,/\.\.\./); // the terminal never inserts synthetic ellipses
  const body=[];
  for(let i=0;i<90;i++){
    s={...s,scroll:i};
    body.push(screen(s));
  }
  const full=body.join('\n');
  assert.match(full,/real parser does not throw/);
  assert.match(full,/INTERPRETAZIONE DEL MODELLO/);
  assert.match(full,/LIMITI/);
  assert.match(full,/La citazione e verificata/);
  assert.ok(body.every(frame=>frame.split('\n').length<=26));
});
test('semantic detail scrolls exact complete model quote; headers and progress are readable',()=>{
  let frames=[];
  for(let scroll=0;scroll<40;scroll++)
    frames.push(screen({...initialTuiState(),view:'semantic-detail',scroll,semanticCursor:0}));
  const all=frames.join('\n');
  assert.match(all,/DETTAGLIO SEMANTICO/);
  assert.match(all,/Righe /);
  assert.match(all,/very-long-module-name/);
  assert.match(all,/real parser does not throw/);
  assert.match(all,/This model hypothesis is not proof/);
});
test('contrast: normal secondary text does not use ANSI black/dark-gray or ANSI dim',()=>{
  const colored=screen(initialTuiState({guided:true}),{colors:true});
  assert.match(colored,/\x1b\[37m/);
  assert.match(colored,/\x1b\[96m/);
  assert.doesNotMatch(colored,/\x1b\[90m/);
  assert.doesNotMatch(colored,/\x1b\[2m/);
});
test('short terminal still reserves navigation instructions when viewing evidence',()=>{
  const page=screen({...initialTuiState(),view:'detail'},{columns:58,rows:14});
  const lines=page.split('\n');
  assert.equal(lines.length,14);
  assert.match(lines.at(-2),/↑↓ Leggi proposta completa/);
  assert.match(lines.at(-1),/M\/E per preparare/);
});
