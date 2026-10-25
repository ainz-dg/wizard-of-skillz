#!/usr/bin/env node
/**
 * Wizard release guard. GitHub Release is the sole publish authorization.
 * workflow_dispatch runs the same gates but must NEVER publish.
 * No npm credential or GitHub write permission is required by this module.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';

export const PACKAGE_NAME='wizard-of-skillz';
export const REPO_NAME='ainz-dg/wizard-of-skillz';
export const NPM_TAG='next';
export const RELEASE_VERSION=/^0\.5\.0-rc\.[1-9]\d*$/;

const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const currentPackage=()=>readJson('package.json');
const exec=(cmd,args,opts={})=>execFileSync(cmd,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],...opts}).trim();
const sha256=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const commit=x=>/^[0-9a-f]{40}$/.test(x||'');

export function validateMetadata({pkg,eventName,tag,expectedCommit,release,commitSha,mainSha,tagSha,repo,ref}){
  assert.equal(repo,REPO_NAME,'Unexpected GitHub repository');
  assert.equal(pkg.name,PACKAGE_NAME,'Unexpected npm package');
  assert.equal(pkg.repository?.url,'git+https://github.com/'+REPO_NAME+'.git','Repository metadata differs');
  assert.match(pkg.version,RELEASE_VERSION,'Only explicitly reviewed rc versions can use this workflow');
  assert.equal(pkg.publishConfig?.tag,NPM_TAG,'Prerelease must use npm next tag');
  assert.equal(tag,'v'+pkg.version,'Tag must match package version');
  assert.ok(commit(commitSha)&&commit(mainSha),'Expected full git commit SHAs');
  assert.equal(commitSha,mainSha,'Release checkout must be exactly the current main HEAD');
  if(eventName==='workflow_dispatch'){
    assert.equal(ref,'refs/heads/main','Dry-run only on main');
    assert.ok(commit(expectedCommit),'Dry-run requires exact approved 40-character commit SHA');
    assert.equal(expectedCommit,commitSha,'Approved commit is not checked out');
    return {mode:'DRY_RUN',publish:false,private:pkg.private===true};
  }
  assert.equal(eventName,'release','Unexpected event cannot publish');
  assert.equal(pkg.private,false,'The package must be explicitly made publishable');
  assert.ok(release&&!release.draft&&release.prerelease===true,'Published prerelease required');
  assert.equal(release.tag_name,tag,'GitHub Release tag differs');
  assert.ok(commit(tagSha),'Release tag must resolve to a commit');
  assert.equal(tagSha,commitSha,'Tag must point to the checked-out main commit');
  return {mode:'PUBLISH',publish:true};
}
function ensureEvent(){
  const pkg=currentPackage();
  const eventName=process.env.GITHUB_EVENT_NAME;
  const tag=process.env.RELEASE_TAG;
  const gitSha=exec('git',['rev-parse','HEAD']);
  const mainSha=exec('git',['rev-parse','refs/remotes/origin/main']);
  const event=process.env.GITHUB_EVENT_PATH?readJson(process.env.GITHUB_EVENT_PATH):{};
  const tagSha=eventName==='release'?exec('git',['rev-parse','refs/tags/'+tag+'^{commit}']):null;
  const result=validateMetadata({pkg,eventName,tag,
    expectedCommit:process.env.EXPECTED_COMMIT,
    release:event.release,commitSha:gitSha,mainSha,tagSha,
    repo:process.env.GITHUB_REPOSITORY,ref:process.env.GITHUB_REF});
  console.log('Wizard release gate:',result.mode,tag,gitSha);
  return result;
}
function run(cmd,args,opts={}){
  const res=spawnSync(cmd,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],...opts});
  if(res.status!==0)throw Error(cmd+' '+args.join(' ')+' failed: '+(res.stderr||res.stdout||'').slice(-800));
  return res.stdout;
}
function reportOutput(values){
  if(!process.env.GITHUB_OUTPUT)return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT,Object.entries(values)
    .map(([k,v])=>k+'='+v+'\n').join(''));
}
function ensureSafeFiles(files){
  assert.ok(files.length>0&&files.length<350,'Unexpected file count');
  const allowed=['bin/','src/','prompts/','docs/','package.json','README.md','LICENSE'];
  for(const entry of files){
    const f=entry.path.replaceAll('\\','/');
    assert.ok(allowed.some(a=>a.endsWith('/')?f.startsWith(a):f===a),
      'Unexpected packaged file: '+f);
    assert.ok(!/(\.env|\.npmrc|token|secret|credential|private-key)/i.test(f),
      'Sensitive-looking packaged path: '+f);
  }
  for(const required of ['package.json','README.md','LICENSE','bin/wizard.mjs',
    'docs/DOCUMENTED-DOMAIN.md','docs/ACCOUNT-PROVIDERS.md']){
    assert.ok(files.some(x=>x.path===required),'Release is missing '+required);
  }
}
export function validateArchiveInfo(info,pkg){
  assert.equal(info.name,PACKAGE_NAME);
  assert.equal(info.version,pkg.version);
  assert.ok(/^[a-f0-9]{40}$/.test(info.shasum),'Missing npm SHA-1 shasum');
  assert.ok(/^sha512-/.test(info.integrity),'Missing npm SHA-512 integrity');
  ensureSafeFiles(info.files);
}
function pack(){
  const pkg=currentPackage();
  const target=process.env.RUNNER_TEMP||fs.mkdtempSync(path.join(os.tmpdir(),'wizard-release-'));
  const result=JSON.parse(run('npm',['pack','--json','--pack-destination',target]));
  const info=result[0];
  validateArchiveInfo(info,pkg);
  const tarball=path.join(target,info.filename);
  assert.ok(fs.statSync(tarball).size>1000,'Unexpected empty package tarball');
  const install=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-install-'));
  try{
    run('npm',['install','--prefix',install,'--ignore-scripts','--no-audit','--no-fund',tarball]);
    const cli=path.join(install,'node_modules',PACKAGE_NAME,'bin','wizard.mjs');
    assert.equal(exec(process.execPath,[cli,'--version']),pkg.version,'Installed CLI version mismatch');
    assert.match(exec(process.execPath,[cli,'--help']),/Wizard of Skillz/);
  }finally{fs.rmSync(install,{recursive:true,force:true});}
  const record={package:PACKAGE_NAME,version:pkg.version,tag:NPM_TAG,tarball:info.filename,
    sha256:sha256(tarball),shasum:info.shasum,integrity:info.integrity};
  const manifest=path.join(target,'release-archive.json');
  fs.writeFileSync(manifest,JSON.stringify(record,null,2)+'\n');
  reportOutput({artifact_name:'wizard-release-'+pkg.version,tarball_name:info.filename,
    sha256:record.sha256,shasum:record.shasum,integrity:record.integrity});
  console.log(JSON.stringify({archive:tarball,manifest,...record},null,2));
}
export function verifyStoredArtifact(artifactDir,sha){
  const pkg=currentPackage();
  const record=readJson(path.join(artifactDir,'release-archive.json'));
  assert.equal(record.package,PACKAGE_NAME);
  assert.equal(record.version,pkg.version);
  assert.equal(record.tarball,PACKAGE_NAME+'-'+pkg.version+'.tgz');
  assert.ok(/^[a-f0-9]{64}$/.test(sha||''),'Missing trusted sha256 from gate job');
  assert.equal(record.sha256,sha,'Archive manifest does not match upstream gate');
  const tarball=path.join(artifactDir,record.tarball);
  assert.ok(fs.existsSync(tarball),'Verified tarball missing');
  assert.equal(sha256(tarball),sha,'Archive bytes changed after gates');
  return record;
}
async function registryMetadata(pkg,version){
  const url='https://registry.npmjs.org/'+encodeURIComponent(pkg)+'/'+encodeURIComponent(version);
  const res=await fetch(url,{headers:{accept:'application/json','cache-control':'no-cache'}});
  if(res.status===404)return null;
  if(!res.ok)throw Error('npm registry returned HTTP '+res.status);
  return res.json();
}
async function registryVacant(){
  ensureEvent();
  const pkg=currentPackage();
  const existing=await registryMetadata(pkg.name,pkg.version);
  assert.equal(existing,null,'This npm package version already exists; refuse republish');
  console.log('Version not published; npm credentials will be supplied via GitHub OIDC.');
}
async function registryVerify(){
  const record=verifyStoredArtifact(process.env.ARTIFACT_DIR,process.env.EXPECTED_SHA256);
  let matched=false;
  for(let i=0;i<8;i++){
    const meta=await registryMetadata(record.package,record.version);
    if(meta){
      assert.equal(meta.dist?.shasum,record.shasum,'npm dist.shasum mismatch');
      assert.equal(meta.dist?.integrity,record.integrity,'npm dist.integrity mismatch');
      matched=true;break;
    }
    await new Promise(resolve=>setTimeout(resolve,5000));
  }
  assert.ok(matched,'Published npm version did not become visible');
  const prefix=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-registry-'));
  try{
    run('npm',['install','--prefix',prefix,'--ignore-scripts','--no-audit','--no-fund',
      record.package+'@'+record.version]);
    const cli=path.join(prefix,'node_modules',record.package,'bin','wizard.mjs');
    assert.equal(exec(process.execPath,[cli,'--version']),record.version,'Registry CLI smoke failed');
  }finally{fs.rmSync(prefix,{recursive:true,force:true});}
  console.log('Published archive integrity and clean installation verified:',record.version);
}
const cmd=process.argv[2];
if(cmd){
  try{
    if(cmd==='gate')ensureEvent();
    else if(cmd==='pack')pack();
    else if(cmd==='verify-artifact'){
      const record=verifyStoredArtifact(process.env.ARTIFACT_DIR,process.env.EXPECTED_SHA256);
      console.log('Archive verified: '+record.tarball);
    }else if(cmd==='prepublish')await registryVacant();
    else if(cmd==='verify-registry')await registryVerify();
    else throw Error('Unknown release-guard command '+cmd);
  }catch(error){console.error('RELEASE BLOCKED:',error.message);process.exitCode=1;}
}
