import test from 'node:test';
import assert from 'node:assert/strict';
import {wizardSprite,stripTerminalColors,decorateWizardOverview}
  from '../src/tui-brand.mjs';
import {initialTuiState,renderReviewTui} from '../src/review-tui.mjs';

const catalog={items:[],source_repositories:{consumer:'synthetic/repo'}};
const plain=(lines)=>lines.map(stripTerminalColors).join('\n');

test('ANSI pixel sprite preserves fixed terminal-cell widths',()=>{
  for(const [variant,expectedRows,width] of [['full',10,30],['face',5,18]]){
    const monochrome=wizardSprite({variant,colors:false});
    const colored=wizardSprite({variant,colors:true});
    assert.equal(monochrome.length,expectedRows);
    assert.equal(colored.length,expectedRows);
    assert.ok(monochrome.every(s=>s.length===width));
    assert.ok(colored.every(s=>stripTerminalColors(s).length===width));
    assert.doesNotMatch(monochrome.join('\n'),/\x1b\[/);
    assert.match(colored.join('\n'),/\x1b\[38;2;/);
    assert.match(plain(colored),/[▀▄]/);
  }
});

test('decoration never adds rows, truncates input text or changes content',()=>{
  const original=[
    'WIZARD OF SKILLZ','─'.repeat(118),
    'Repository: synthetic/example','Status: local scan completed',
    'A very long informational line with a human-reviewed proposal '.repeat(3),
    ...Array(14).fill('COSA VUOI FARE?')
  ];
  const result=decorateWizardOverview(original,{width:120,height:30,colors:false});
  assert.equal(result.length,original.length);
  assert.ok(result.every(line=>line.length<=118||original.includes(line)));
  assert.ok(result.some(line=>line.includes('▀')));
  for(let i=0;i<original.length;i++)
    assert.ok(result[i].startsWith(original[i]));
  assert.equal(decorateWizardOverview(original,{width:60,height:12}),original);
});

test('the familiar review layout remains free from mascot rows',()=>{
  for(const [cols,rows,expectSprite] of [[120,30,true],[90,20,true],[80,16,false],[60,12,false]]){
    const overview=renderReviewTui(catalog,initialTuiState({guided:true}),{
      columns:cols,rows,colors:false
    });
    assert.ok(overview.split('\n').length<=rows,cols+'x'+rows);
    assert.match(overview,/WIZARD OF SKILLZ/);
    assert.equal(overview.includes('▀'),expectSprite,cols+'x'+rows);
    assert.match(overview,/COSA VUOI FARE/);
    const list=renderReviewTui(catalog,initialTuiState(),{
      columns:cols,rows,colors:false
    });
    assert.ok(list.split('\n').length<=rows);
    assert.doesNotMatch(list,/[▀▄]/);
  }
});

test('branding never changes the selection/apply state and is disabled during provider setup',()=>{
  const state=initialTuiState({guided:true});
  const before=JSON.stringify(state);
  const frame=renderReviewTui(catalog,state,{columns:120,rows:30,colors:true});
  assert.match(frame,/\x1b\[38;2;/);
  assert.equal(JSON.stringify(state),before);
  const branded=decorateWizardOverview(['header','do not alter'],{width:80,height:16,colors:true});
  assert.deepEqual(branded,['header','do not alter']);
});
