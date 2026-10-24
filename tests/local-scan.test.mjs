import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createLocalScan} from '../src/local-scan.mjs';
import {buildReviewCatalog,planHumanSelection} from '../src/review-selection.mjs';
import {initialTuiState,renderReviewTui} from '../src/review-tui.mjs';

const cli=fileURLToPath(new URL('../bin/wizard.mjs',import.meta.url));
const write=(root,rel,content)=>{
  const file=path.join(root,rel);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,content);
};
function exampleProject(){
  // macOS exposes /var through /private/var: use the physical temp root
  // so expected output paths match the scan's secure realpath canonicalization.
  const sandbox=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'wizard-test-'));
  const root=path.join(sandbox,'project');
  fs.mkdirSync(root);
  const skill='---\nname: reviewer\ndescription: local source review\n---\n'+
    'Read [details](references/missing.md).\n'+
    'File: `src/shape.ts`\n'+
    'Add an entry to `ShapesInfo` with at minimum `{ isK2: true }`.\n';
  write(root,'.agents/skills/reviewer/SKILL.md',skill);
  write(root,'src/shape.ts',
    'export type ShapesInfoMap = { existing: boolean };\n'+
    'export const ShapesInfo: ShapesInfoMap = {};\n');
  return {sandbox,root,skill};
}

test('local intake creates source-backed MANUAL_ONLY reviews outside project without provider or LLM',()=>{
  const {sandbox,root,skill}=exampleProject();
  try{
    const out=path.join(sandbox,'audit-results');
    const result=createLocalScan(root,{out});
    assert.equal(result.output_directory,out);
    assert.equal(result.mode,'LOCAL_STRUCTURAL_ONLY');
    assert.equal(result.skill_count,1);
    assert.equal(result.proposal_count,2);
    assert.equal(result.semantic_verification,false);
    assert.equal(result.scope_evaluated,false);
    assert.equal(result.llm_used,false);
    assert.equal(result.write_authorized,false);
    assert.equal(result.applied_count,0);
    const proposals=JSON.parse(fs.readFileSync(path.join(out,'repair-proposals.json'),'utf8'));
    const catalog=buildReviewCatalog(proposals);
    assert.equal(catalog.items.length,2);
    assert.ok(catalog.items.every(x=>x.action==='UPDATE' && x.readiness==='MANUAL_ONLY'));
    assert.ok(catalog.items.every(x=>x.evidence.some(e=>e.sha256)));
    assert.equal(planHumanSelection(catalog).selected_count,0);
    const report=JSON.parse(fs.readFileSync(path.join(out,'skill-reference-links.json'),'utf8'));
    assert.equal(report.summary.missing,1);
    assert.equal(fs.readFileSync(path.join(root,'.agents/skills/reviewer/SKILL.md'),'utf8'),skill);
    assert.deepEqual(fs.readdirSync(root).sort(),['.agents','src']);
    const view=renderReviewTui(catalog,initialTuiState({guided:true}),{
      localScan:result,columns:92,rows:20,colors:false});
    assert.match(view,/1 skill individuate/);
    assert.match(view,/verifica semantica non inclusa/);
    assert.match(view,/Audit semantico: non ancora eseguito/);
  }finally{fs.rmSync(sandbox,{recursive:true,force:true});}
});

test('intake does not write inside inspected root and never overwrites an existing audit',()=>{
  const {sandbox,root}=exampleProject();
  try{
    assert.throws(()=>createLocalScan(root,{out:path.join(root,'.wizard')}),/inside inspected repository/);
    assert.equal(fs.existsSync(path.join(root,'.wizard')),false);
    const existing=path.join(sandbox,'existing');
    fs.mkdirSync(existing);
    write(existing,'important.txt','preserve this');
    assert.throws(()=>createLocalScan(root,{out:existing}),/EEXIST/);
    assert.equal(fs.readFileSync(path.join(existing,'important.txt'),'utf8'),'preserve this');
  }finally{fs.rmSync(sandbox,{recursive:true,force:true});}
});

test('local scan skips symlinked SKILL.md and reports absence rather than claiming clean semantic audit',()=>{
  const {sandbox,root}=exampleProject();
  try{
    const external=path.join(sandbox,'outside-SKILL.md');
    fs.writeFileSync(external,'confidential external test fixture');
    const folder=path.join(root,'.agents/skills/escaped');
    fs.mkdirSync(folder,{recursive:true});
    fs.symlinkSync(external,path.join(folder,'SKILL.md'));
    const result=createLocalScan(root,{out:path.join(sandbox,'report')});
    assert.equal(result.skill_count,1);
    assert.equal(result.semantic_verification,false);
    assert.equal(result.proposal_count,2);
    const empty=path.join(sandbox,'empty');
    fs.mkdirSync(empty);
    const none=createLocalScan(empty,{out:path.join(sandbox,'empty-report')});
    assert.equal(none.skill_count,0);
    assert.equal(none.proposal_count,0);
    assert.equal(none.semantic_verification,false);
  }finally{fs.rmSync(sandbox,{recursive:true,force:true});}
});

test('bare wizard scans cwd and returns offline JSON in non-TTY mode',()=>{
  const {sandbox,root}=exampleProject();
  try{
    const run=spawnSync(process.execPath,[cli],{cwd:root,encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    const summary=JSON.parse(run.stdout);
    assert.equal(summary.skill_count,1);
    assert.equal(summary.llm_used,false);
    assert.equal(summary.write_authorized,false);
    assert.equal(summary.proposal_count,2);
    assert.ok(summary.output_directory.startsWith(fs.realpathSync(os.tmpdir())+path.sep));
    assert.equal(fs.existsSync(path.join(summary.output_directory,'repair-proposals.json')),true);
    fs.rmSync(summary.output_directory,{recursive:true,force:true});
  }finally{fs.rmSync(sandbox,{recursive:true,force:true});}
});

test('scan command with explicit project and output paths is also non-interactive-safe',()=>{
  const {sandbox,root}=exampleProject();
  try{
    const out=path.join(sandbox,'explicit-output');
    const run=spawnSync(process.execPath,[cli,'scan',root,'--out',out],{
      cwd:sandbox,encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    assert.equal(JSON.parse(run.stdout).output_directory,out);
    assert.equal(fs.existsSync(path.join(out,'local-scan-summary.json')),true);
    const help=spawnSync(process.execPath,[cli,'--help'],{cwd:sandbox,encoding:'utf8'});
    assert.equal(help.status,0,help.stderr);
    assert.match(help.stdout,/scan \[repo\]/);
  }finally{fs.rmSync(sandbox,{recursive:true,force:true});}
});

test('local scan emits path snapshot evidence but never turns chapter problems into UPDATE',()=>{
  const {sandbox,root}=exampleProject();
  try{
    const folder='.agents/skills/reviewer';
    write(root,folder+'/references/chapter.md',[
      '# Existing code paths',
      '- '+String.fromCharCode(96)+'src/shape.ts'+String.fromCharCode(96),
      '- '+String.fromCharCode(96)+'src/obsolete/file.ts'+String.fromCharCode(96)
    ].join('\n'));
    const result=createLocalScan(root,{out:path.join(sandbox,'with-local-paths')});
    const report=JSON.parse(fs.readFileSync(path.join(result.output_directory,'local-path-mentions.json'),'utf8'));
    assert.equal(report.summary.present,2); // src/shape.ts in SKILL.md and chapter
    assert.equal(report.summary.missing_at_snapshot,1);
    const problem=report.mentions.find(m=>m.mentioned_path==='src/obsolete/file.ts');
    assert.ok(problem);
    assert.ok(problem.document.endsWith('/references/chapter.md'));
    assert.equal(problem.line,3);
    assert.ok(/^[0-9a-f]{64}$/.test(problem.document_sha256));
    assert.equal(result.local_path_summary.missing_at_snapshot,1);
    assert.equal(result.proposal_count,2);
    const proposals=JSON.parse(fs.readFileSync(path.join(result.output_directory,'repair-proposals.json'),'utf8'));
    assert.equal(proposals.proposals.length,2);
    assert.ok(proposals.proposals.every(p=>!JSON.stringify(p).includes('obsolete/file.ts')));
  }finally{fs.rmSync(sandbox,{recursive:true,force:true});}
});
