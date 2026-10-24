import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {stageLifecycle} from '../src/skill-lifecycle.mjs';
import {stageUpdateText,loadReviewPreviews} from '../src/review-candidates.mjs';
import {buildReviewCatalog,planHumanSelection} from '../src/review-selection.mjs';
import {prepareReviewedApply,commitReviewedApply} from '../src/guarded-apply.mjs';
import {commitMixedBatch} from '../src/apply-lifecycle.mjs';
import {runReviewTui,renderReviewTui} from '../src/review-tui.mjs';

const sha=t=>createHash('sha256').update(t).digest('hex');
function fixture(){
  // Use the physical tmpdir. On macOS /var is a symlink to /private/var;
  // do not weaken production symlink checks to accommodate test fixtures.
  const home=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'wizard-lifecycle-'));
  const consumerRoot=path.join(home,'project'),auditFolder=path.join(home,'audit');
  const prefix='.agents/skills/';
  fs.mkdirSync(path.join(consumerRoot,prefix),{recursive:true});fs.mkdirSync(auditFolder);
  const write=(rel,content)=>{
    const absolute=path.join(consumerRoot,rel);
    fs.mkdirSync(path.dirname(absolute),{recursive:true});fs.writeFileSync(absolute,content);
    return absolute;
  };
  const old='# Old skill\n';
  write(prefix+'from/SKILL.md','# Move me\n');
  const bytes=Buffer.from([0,1,2,3,254]);
  write(prefix+'from/references/details.md','Source detail\n');
  write(prefix+'from/assets/icon.bin',bytes);
  write(prefix+'remove/SKILL.md','# Remove me\n');
  write(prefix+'remove/references/info.md','legacy\n');
  write(prefix+'update/SKILL.md',old);
  const loc=name=>({repo:'demo/project',path:prefix+name+'/SKILL.md'});
  const proposals={consumer_repo:'demo/project',proposals:[
    {id:'create',action:'CREATE',target:loc('new'),title:'Create skill',reason:'Human-directed new skill'},
    {id:'move',action:'MOVE',source:loc('from'),target:loc('to'),title:'Relocate skill'},
    {id:'remove',action:'REMOVE',source:loc('remove'),title:'Remove skill'},
    {id:'update',action:'UPDATE',source:loc('update'),target:loc('update'),
      title:'Update skill',evidence:[{...loc('update'),sha256:sha(old)}]}
  ]};
  fs.writeFileSync(path.join(auditFolder,'repair-proposals.json'),JSON.stringify(proposals));
  return {home,consumerRoot,auditFolder,prefix,write,proposals,bytes,old,
    newText:'---\nname: new\ndescription: brand new skill\n---\n# New skill\n'};
}
const cleanup=x=>fs.rmSync(x.home,{recursive:true,force:true});
const folder=(e,name)=>path.join(e.consumerRoot,e.prefix+name);
function stageAll(e){
  stageLifecycle(e.auditFolder,{consumerRoot:e.consumerRoot,proposalId:'create',content:e.newText});
  stageLifecycle(e.auditFolder,{consumerRoot:e.consumerRoot,proposalId:'move'});
  stageLifecycle(e.auditFolder,{consumerRoot:e.consumerRoot,proposalId:'remove'});
  stageUpdateText(e.auditFolder,{consumerRoot:e.consumerRoot,proposalId:'update',content:'# Revised\n'});
  const previews=loadReviewPreviews(e.auditFolder,e.proposals);
  const catalog=buildReviewCatalog(e.proposals,{previews});
  return {previews,catalog};
}

test('CREATE MOVE REMOVE UPDATE: one confirmation changes four distinct skills, preserving package assets',()=>{
  const e=fixture();
  try{
    const {previews,catalog}=stageAll(e);
    assert.deepEqual(catalog.items.map(x=>x.readiness),Array(4).fill('PREVIEW_READY'));
    assert.ok(!fs.existsSync(folder(e,'new')));
    assert.ok(fs.existsSync(folder(e,'from')));
    assert.ok(fs.existsSync(folder(e,'remove')));
    const selected=['create','move','remove','update'];
    const plan=prepareReviewedApply(catalog,selected,previews,{consumerRoot:e.consumerRoot});
    assert.equal(plan.candidates.length,4);
    assert.throws(()=>commitReviewedApply(plan,{catalog,previews,consumerRoot:e.consumerRoot,
      auditFolder:e.auditFolder}),/Final explicit APPLY/);
    const result=commitReviewedApply(plan,{catalog,previews,consumerRoot:e.consumerRoot,
      auditFolder:e.auditFolder,confirmation:'APPLY'});
    assert.equal(result.status,'APPLIED');
    assert.equal(result.selected_count,4);
    assert.equal(result.applied_count,4);
    assert.equal(fs.readFileSync(path.join(folder(e,'new'),'SKILL.md'),'utf8'),e.newText);
    assert.ok(!fs.existsSync(folder(e,'from')));
    assert.deepEqual(fs.readFileSync(path.join(folder(e,'to'),'assets/icon.bin')),e.bytes);
    assert.equal(fs.readFileSync(path.join(folder(e,'to'),'references/details.md'),'utf8'),'Source detail\n');
    assert.ok(!fs.existsSync(folder(e,'remove')));
    assert.equal(fs.readFileSync(path.join(folder(e,'update'),'SKILL.md'),'utf8'),'# Revised\n');
    assert.ok(fs.existsSync(path.join(result.backup_directory,'1.package','references/details.md')));
    assert.ok(fs.existsSync(path.join(result.backup_directory,'2.package','references/info.md')));
    assert.ok(fs.existsSync(result.receipt));
    assert.equal(fs.readdirSync(e.auditFolder).filter(n=>n.startsWith('apply-result-')).length,1);
  }finally{cleanup(e);}
});

test('failure after CREATE and MOVE restores both and preserves REMOVE, UPDATE',()=>{
  const e=fixture();
  try{
    const {previews,catalog}=stageAll(e);
    const plan=prepareReviewedApply(catalog,['create','move','remove','update'],previews,
      {consumerRoot:e.consumerRoot});
    let count=0,error;
    const rename=(a,b)=>{
      if(++count===3)throw Error('simulated REMOVE rename failure');
      fs.renameSync(a,b);
    };
    try{commitMixedBatch(plan.candidates,{consumerRoot:e.consumerRoot,
      auditFolder:e.auditFolder,confirmation:'APPLY',rename});}
    catch(ex){error=ex;}
    assert.ok(error);
    assert.equal(error.report.status,'ROLLED_BACK');
    assert.ok(!fs.existsSync(folder(e,'new')));
    assert.ok(fs.existsSync(folder(e,'from')));
    assert.ok(!fs.existsSync(folder(e,'to')));
    assert.ok(fs.existsSync(folder(e,'remove')));
    assert.equal(fs.readFileSync(path.join(folder(e,'update'),'SKILL.md'),'utf8'),e.old);
  }finally{cleanup(e);}
});

test('source drift in MOVE or REMOVE prevents the full mixed batch without writes',()=>{
  const e=fixture();
  try{
    const {previews,catalog}=stageAll(e);
    fs.appendFileSync(path.join(folder(e,'from'),'references/details.md'),'human edit\n');
    assert.throws(()=>prepareReviewedApply(catalog,['create','move','remove','update'],previews,
      {consumerRoot:e.consumerRoot}),/changed since review/);
    assert.ok(!fs.existsSync(folder(e,'new')));
    assert.ok(fs.existsSync(folder(e,'remove')));
  }finally{cleanup(e);}
});

test('unsafe symlink package refuses staging; CREATE destination must not exist',()=>{
  const e=fixture();
  try{
    const outside=path.join(e.home,'secret');fs.writeFileSync(outside,'outside');
    fs.symlinkSync(outside,path.join(folder(e,'from'),'leak'));
    assert.throws(()=>stageLifecycle(e.auditFolder,{
      consumerRoot:e.consumerRoot,proposalId:'move'}),/Symlink inside/);
    fs.mkdirSync(folder(e,'new'));
    assert.throws(()=>stageLifecycle(e.auditFolder,{consumerRoot:e.consumerRoot,
      proposalId:'create',content:e.newText}),/already exists/);
  }finally{cleanup(e);}
});

test('cross-repository MOVE must be explicitly rejected',()=>{
  const e=fixture();
  try{
    const modified=structuredClone(e.proposals);
    modified.proposals.find(p=>p.id==='move').target.repo='external/elsewhere';
    fs.writeFileSync(path.join(e.auditFolder,'repair-proposals.json'),JSON.stringify(modified));
    assert.throws(()=>stageLifecycle(e.auditFolder,{consumerRoot:e.consumerRoot,
      proposalId:'move'}),/Cross-repository/);
  }finally{cleanup(e);}
});

test('TUI prepares MOVE with R and CREATE with E, applies only on separate G then Y',async()=>{
  const e=fixture();
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
  let rendered='';
  const output={isTTY:true,columns:115,rows:28,write:s=>{rendered+=s;}};
  const key=name=>input.emit('keypress',name==='return'?'\r':name,{name});
  try{
    const editor=path.join(e.home,'editor.mjs');
    fs.writeFileSync(editor,'#!/usr/bin/env node\nimport fs from "node:fs";\n'+
      'fs.writeFileSync(process.argv[2],'+JSON.stringify(e.newText)+');\n');
    const session=runReviewTui(e.auditFolder,{consumerRoot:e.consumerRoot,input,output,
      editor:process.execPath+' '+editor});
    key('return');
    key('e'); // CREATE
    assert.match(rendered,/PREVIEW|CANDIDATO|ANTEPRIMA/);
    assert.ok(!fs.existsSync(folder(e,'new')));
    key('escape');key('down');key('r'); // MOVE
    assert.match(rendered,/MOVE PACKAGE/);
    key('escape');key('a'); // Select all, unprepared REMOVE/UPDATE block
    key('g');
    assert.match(rendered,/NON APPLICABILE/);
    key('n'); // Clear selection
    key('space'); // Select current MOVE
    key('up');key('space'); // Select CREATE
    key('g');
    assert.match(rendered,/SCRITTURA REALE SU 2 FILE/);
    assert.ok(fs.existsSync(folder(e,'from')));
    key('y');key('q');
    await session;
    assert.ok(fs.existsSync(folder(e,'new')));
    assert.ok(fs.existsSync(folder(e,'to')));
    assert.ok(!fs.existsSync(folder(e,'from')));
  }finally{cleanup(e);}
});


test('user chooses absolute local folder: MOVE assets and UPDATE one confirmed batch',()=>{
  const e=fixture();
  try{
    const destination=path.join(e.home,'personal-skills');
    fs.mkdirSync(destination);
    stageLifecycle(e.auditFolder,{consumerRoot:e.consumerRoot,proposalId:'move',
      destinationDir:destination});
    stageUpdateText(e.auditFolder,{consumerRoot:e.consumerRoot,proposalId:'update',
      content:'# Reviewed update\n'});
    const previews=loadReviewPreviews(e.auditFolder,e.proposals);
    const move=previews.previews.find(p=>p.proposal_id==='move');
    const target=path.join(destination,'from');
    assert.equal(move.destination_absolute,target);
    assert.ok(move.diff.includes(target));
    const catalog=buildReviewCatalog(e.proposals,{previews});
    const prepared=prepareReviewedApply(catalog,['move','update'],previews,
      {consumerRoot:e.consumerRoot});
    assert.equal(prepared.candidates[0].destination_absolute,target);
    assert.equal(fs.existsSync(target),false);
    assert.throws(()=>commitReviewedApply(prepared,{catalog,previews,
      consumerRoot:e.consumerRoot,auditFolder:e.auditFolder,confirmation:'NO'}),
      /Final explicit APPLY/);
    const receipt=commitReviewedApply(prepared,{catalog,previews,consumerRoot:e.consumerRoot,
      auditFolder:e.auditFolder,confirmation:'APPLY'});
    assert.equal(receipt.status,'APPLIED');
    assert.equal(receipt.selected_count,2);
    assert.equal(receipt.files[0].destination,target);
    assert.ok(!fs.existsSync(folder(e,'from')));
    assert.deepEqual(fs.readFileSync(path.join(target,'assets/icon.bin')),e.bytes);
    assert.equal(fs.readFileSync(path.join(target,'references/details.md'),'utf8'),'Source detail\n');
    assert.equal(fs.readFileSync(path.join(folder(e,'update'),'SKILL.md'),'utf8'),
      '# Reviewed update\n');
    assert.ok(fs.existsSync(path.join(receipt.backup_directory,'0.package','SKILL.md')));
  }finally{cleanup(e);}
});

test('occupied destination after staging blocks the entire selected batch',()=>{
  const e=fixture();
  try{
    const destination=path.join(e.home,'personal-skills');fs.mkdirSync(destination);
    stageLifecycle(e.auditFolder,{consumerRoot:e.consumerRoot,proposalId:'move',
      destinationDir:destination});
    stageUpdateText(e.auditFolder,{consumerRoot:e.consumerRoot,proposalId:'update',
      content:'# Reviewed update\n'});
    const previews=loadReviewPreviews(e.auditFolder,e.proposals);
    const catalog=buildReviewCatalog(e.proposals,{previews});
    fs.mkdirSync(path.join(destination,'from'));
    fs.writeFileSync(path.join(destination,'from','notes.txt'),'Do not overwrite');
    assert.throws(()=>prepareReviewedApply(catalog,['move','update'],previews,
      {consumerRoot:e.consumerRoot}),/already exists/);
    assert.ok(fs.existsSync(folder(e,'from')));
    assert.equal(fs.readFileSync(path.join(destination,'from','notes.txt'),'utf8'),'Do not overwrite');
    assert.equal(fs.readFileSync(path.join(folder(e,'update'),'SKILL.md'),'utf8'),e.old);
  }finally{cleanup(e);}
});

test('reject symlinked destination, relative destination and nested source',()=>{
  const e=fixture();
  try{
    const destination=path.join(e.home,'personal-skills');fs.mkdirSync(destination);
    const alias=path.join(e.home,'alias');fs.symlinkSync(destination,alias,'dir');
    assert.throws(()=>stageLifecycle(e.auditFolder,{consumerRoot:e.consumerRoot,
      proposalId:'move',destinationDir:alias}),/symlinked/);
    assert.throws(()=>stageLifecycle(e.auditFolder,{consumerRoot:e.consumerRoot,
      proposalId:'move',destinationDir:folder(e,'from')}),/inside its own source/);
    assert.throws(()=>stageLifecycle(e.auditFolder,{consumerRoot:e.consumerRoot,
      proposalId:'move',destinationDir:'relative/path'}),/absolute existing directory/);
    assert.ok(fs.existsSync(folder(e,'from')));
  }finally{cleanup(e);}
});

test('chosen local folder can fulfill cross-repo target identity without Git operations',()=>{
  const e=fixture();
  try{
    const destination=path.join(e.home,'other-repo-skills');fs.mkdirSync(destination);
    const data=structuredClone(e.proposals);
    data.proposals.find(p=>p.id==='move').target.repo='another/project';
    fs.writeFileSync(path.join(e.auditFolder,'repair-proposals.json'),JSON.stringify(data));
    assert.throws(()=>stageLifecycle(e.auditFolder,{consumerRoot:e.consumerRoot,proposalId:'move'}),
      /Cross-repository/);
    stageLifecycle(e.auditFolder,{consumerRoot:e.consumerRoot,proposalId:'move',
      destinationDir:destination});
    const previews=loadReviewPreviews(e.auditFolder,data);
    const catalog=buildReviewCatalog(data,{previews});
    const prepared=prepareReviewedApply(catalog,['move'],previews,{consumerRoot:e.consumerRoot});
    const receipt=commitReviewedApply(prepared,{catalog,previews,
      consumerRoot:e.consumerRoot,auditFolder:e.auditFolder,confirmation:'APPLY'});
    assert.equal(receipt.status,'APPLIED');
    assert.ok(fs.existsSync(path.join(destination,'from','SKILL.md')));
    assert.ok(!fs.existsSync(folder(e,'from')));
  }finally{cleanup(e);}
});

test('failure after destination promotion restores original and removes unapproved copy',()=>{
  const e=fixture();
  try{
    const destination=path.join(e.home,'personal-skills');fs.mkdirSync(destination);
    stageLifecycle(e.auditFolder,{consumerRoot:e.consumerRoot,proposalId:'move',
      destinationDir:destination});
    const previews=loadReviewPreviews(e.auditFolder,e.proposals);
    const catalog=buildReviewCatalog(e.proposals,{previews});
    const prepared=prepareReviewedApply(catalog,['move'],previews,
      {consumerRoot:e.consumerRoot});
    let n=0,failure;
    const rename=(source,target)=>{
      if(++n===2)throw Error('source quarantine failed');
      fs.renameSync(source,target);
    };
    try{commitMixedBatch(prepared.candidates,{consumerRoot:e.consumerRoot,
      auditFolder:e.auditFolder,confirmation:'APPLY',rename});}
    catch(error){failure=error;}
    assert.ok(failure);
    assert.equal(failure.report.status,'ROLLED_BACK');
    assert.ok(fs.existsSync(folder(e,'from')));
    assert.ok(!fs.existsSync(path.join(destination,'from')));
    assert.deepEqual(fs.readFileSync(path.join(folder(e,'from'),'assets/icon.bin')),e.bytes);
  }finally{cleanup(e);}
});

test('external MOVE performs same-directory renames and supports cross-device source',()=>{
  const e=fixture();
  try{
    const destination=path.join(e.home,'external-skills');fs.mkdirSync(destination);
    stageLifecycle(e.auditFolder,{consumerRoot:e.consumerRoot,proposalId:'move',
      destinationDir:destination});
    const previews=loadReviewPreviews(e.auditFolder,e.proposals);
    const catalog=buildReviewCatalog(e.proposals,{previews});
    const prepared=prepareReviewedApply(catalog,['move'],previews,
      {consumerRoot:e.consumerRoot});
    const renames=[];
    const rename=(source,target)=>{
      renames.push([source,target]);
      if(path.dirname(source)!==path.dirname(target))
        throw Object.assign(Error('cross-device EXDEV'),{code:'EXDEV'});
      fs.renameSync(source,target);
    };
    const receipt=commitMixedBatch(prepared.candidates,{consumerRoot:e.consumerRoot,
      auditFolder:e.auditFolder,confirmation:'APPLY',rename});
    assert.equal(receipt.status,'APPLIED');
    assert.equal(renames.length,2);
    assert.ok(!fs.existsSync(folder(e,'from')));
    assert.ok(fs.existsSync(path.join(destination,'from','SKILL.md')));
  }finally{cleanup(e);}
});


test('CLI stage-action accepts an explicit local destination folder without applying',()=>{
  const e=fixture();
  try{
    const destination=path.join(e.home,'chosen-skills');fs.mkdirSync(destination);
    const cli=new URL('../bin/wizard.mjs',import.meta.url).pathname;
    const run=spawnSync(process.execPath,[cli,'stage-action',e.auditFolder,
      '--consumer-root',e.consumerRoot,'--proposal','move','--destination-dir',destination],
      {encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    const staged=JSON.parse(run.stdout);
    assert.equal(staged.status,'STAGED');
    assert.equal(staged.write_authorized,false);
    const previews=loadReviewPreviews(e.auditFolder,e.proposals);
    assert.equal(previews.previews[0].destination_absolute,path.join(destination,'from'));
    assert.ok(fs.existsSync(folder(e,'from')));
    assert.ok(!fs.existsSync(path.join(destination,'from')));
  }finally{cleanup(e);}
});

// Assert against individual current frames: an earlier preview must not make
// a truncated confirmation appear correct.
function plainTuiFrame(frame){
  return frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').split('\n');
}
function confirmationRows(frames){
  const rows=[];let total=null;
  for(const frame of frames){
    const lines=plainTuiFrame(frame);
    const index=lines.findIndex(line=>/^Righe \d+–\d+\/\d+/.test(line));
    if(index<0)continue;
    const match=/^Righe (\d+)–(\d+)\/(\d+)/.exec(lines[index]);
    const [,first,last,count]=match.map(Number);
    if(total!==null)assert.equal(count,total);
    total=count;
    for(let row=first;row<=last;row++){
      const value=lines[index+row-first+1];
      assert.ok(value!==undefined,'Missing displayed row '+row);
      if(rows[row-1]!==undefined)assert.equal(rows[row-1],value);
      rows[row-1]=value;
    }
  }
  assert.ok(total!==null,'No confirmation frames captured');
  assert.equal(rows.length,total);
  assert.equal(rows.filter(row=>row!==undefined).length,total,
    'Not every confirmation row was reachable');
  return rows;
}
function displayedMoveDestinations(rows){
  const destinations=[];
  for(let i=0;i<rows.length;i++){
    if(!/^DESTINAZIONE (?:ASSOLUTA|RELATIVA)$/.test(rows[i]))continue;
    let destination='';
    for(let j=i+1;j<rows.length&&
      !rows[j].startsWith('Cartella completa:')&&rows[j]!=='';j++){
      destination+=rows[j];
    }
    destinations.push(destination);
  }
  return destinations;
}

test('TUI R with a supplied --move-dir shows exact destination before G/Y approval',async()=>{
  const e=fixture();
  const destination=path.join(e.home,'chosen skills');fs.mkdirSync(destination);
  const expected=path.join(destination,'from');
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
  const frames=[];
  const output={isTTY:true,columns:140,rows:30,write:s=>frames.push(s)};
  const key=name=>input.emit('keypress',name==='return'?'\r':name,{name});
  try{
    const session=runReviewTui(e.auditFolder,{
      consumerRoot:e.consumerRoot,moveDestinationDir:destination,input,output});
    key('return');key('down');key('r');
    const preview=plainTuiFrame(frames.at(-1)).join('');
    assert.ok(preview.includes(expected),'Preview must retain exact destination');
    assert.ok(fs.existsSync(folder(e,'from')));
    key('escape');key('space');key('g');
    const confirmFrames=[frames.at(-1)];
    assert.match(confirmFrames[0],/SCRITTURA REALE SU 1 FILE/);
    for(let i=0;i<60;i++){
      key('down');confirmFrames.push(frames.at(-1));
    }
    assert.deepEqual(displayedMoveDestinations(confirmationRows(confirmFrames)),[expected]);
    assert.ok(fs.existsSync(folder(e,'from')),'Preview must not move the source');
    assert.ok(!fs.existsSync(expected),'Preview must not create the destination');
    key('y');key('q');await session;
    assert.ok(fs.existsSync(path.join(expected,'SKILL.md')));
    assert.ok(!fs.existsSync(folder(e,'from')));
  }finally{cleanup(e);}
});

test('MOVE approval shows full paths at 80/100/140 columns and in multi-MOVE lots',()=>{
  const long=path.join(os.tmpdir(),'chosen folder with spaces',
    'part with spaces '.repeat(12).trim(),'from');
  const short=path.join(os.tmpdir(),'chosen skills','other');
  const candidates=[
    {operation:'MOVE',repo:'demo/project',path:'.agents/skills/from/SKILL.md',
      destination_absolute:long,package_files:[{path:'SKILL.md'}]},
    {operation:'MOVE',repo:'demo/project',path:'.agents/skills/other/SKILL.md',
      destination_absolute:short,package_files:[{path:'SKILL.md'}]}
  ];
  for(const columns of [80,100,140]){
    for(const height of [12,16]){
    const frames=[];
    for(let scroll=0;scroll<90;scroll++){
      frames.push(renderReviewTui({items:[]},{
        view:'confirm-apply',cursor:0,selected:[],discarded:[],
        scroll,pendingApply:{selected_ids:['move1','move2'],candidates}
      },{columns,rows:height,colors:false}));
    }
    const rows=confirmationRows(frames);
    assert.deepEqual(displayedMoveDestinations(rows),[long,short],
      'Full destinations must remain accessible at '+columns+'x'+height);
    assert.ok(rows.join('').includes('.agents/skills/from/SKILL.md'));
    assert.ok(rows.join('').includes('.agents/skills/other/SKILL.md'));
    assert.equal(plainTuiFrame(frames[0]).length,height);
    }
  }
});


test('MOVE lifecycle preview retains path with spaces across narrow viewports',()=>{
  const destination=path.join(os.tmpdir(),'some destination with spaces',
    'segment with spaces '.repeat(12).trim(),'from');
  const original='.agents/skills/from/SKILL.md';
  const diff='MOVE PACKAGE '+original+' → '+destination+'\n'+
    '  SKILL.md sha256 '+'b'.repeat(64);
  const catalog={items:[{id:'move',action:'MOVE',readiness:'PREVIEW_READY',
    title:'Move a skill',source:{repo:'demo/project',path:original},
    target:{repo:'demo/project',path:original},summary:'Review destination'}]};
  const previews={previews:[{proposal_id:'move',status:'PREVIEW_READY',
    lifecycle_candidate:true,diff}]};
  for(const columns of [80,100,140]){
    const frames=[];
    for(let scroll=0;scroll<90;scroll++){
      frames.push(renderReviewTui(catalog,{
        view:'preview',cursor:0,selected:[],discarded:[],scroll
      },{columns,rows:16,colors:false,previews}));
    }
    const visible=confirmationRows(frames).join('');
    assert.ok(visible.includes(destination),
      'Lifecycle preview must preserve every character at '+columns+' columns');
  }
});

test('staged MOVE previews show both complete destinations at 12/16/30 rows',()=>{
  const original='.agents/skills/source/SKILL.md';
  const destinations=[
    path.join(os.tmpdir(),'alpha folder with spaces',
      'alpha segment with spaces '.repeat(12).trim(),'source'),
    path.join(os.tmpdir(),'beta folder with spaces',
      'beta segment with spaces '.repeat(12).trim(),'source')
  ];
  const catalog={items:destinations.map((_,i)=>({
    id:'move-'+i,action:'MOVE',readiness:'PREVIEW_READY',
    title:'Move source '+i,source:{repo:'demo/project',path:original},
    target:{repo:'demo/project',path:original},summary:'Review destination'
  }))};
  const previews={previews:destinations.map((destination,i)=>({
    proposal_id:'move-'+i,status:'PREVIEW_READY',lifecycle_candidate:true,
    diff:'MOVE PACKAGE '+original+' → '+destination+'\n'+
      '  SKILL.md sha256 '+'b'.repeat(64)
  }))};
  for(const rows of [12,16,30]){
    for(const columns of [80,100,140]){
      for(const [index,destination] of destinations.entries()){
        const frames=[];
        for(let scroll=0;scroll<100;scroll++){
          frames.push(renderReviewTui(catalog,{
            view:'preview',cursor:index,selected:[],discarded:[],scroll,
            notice:'MOVE preparata: controlla il diff prima di G.',
            draftResult:{method:'LIFECYCLE',ids:['move-'+index]}
          },{columns,rows,colors:false,previews}));
        }
        const visible=confirmationRows(frames).join('');
        assert.ok(visible.includes(destination),
          'Current staged preview must show full destination at '+
          columns+'x'+rows+' (candidate '+index+')');
        assert.ok(visible.includes('SKILL.md sha256 '+'b'.repeat(64)),
          'All package evidence must be reachable at '+columns+'x'+rows);
        assert.equal(plainTuiFrame(frames[0]).length,rows,
          'Viewport and footer must remain bounded');
      }
    }
  }
});
