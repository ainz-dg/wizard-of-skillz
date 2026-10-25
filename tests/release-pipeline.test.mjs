import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {validateMetadata,validateArchiveInfo,verifyStoredArtifact,alreadyPublishedIdentity}
  from '../scripts/release/guard.mjs';

const SHA='a'.repeat(40);
const record={name:'wizard-of-skillz',version:'0.5.0-rc.3',private:false,
  repository:{url:'git+https://github.com/ainz-dg/wizard-of-skillz.git'},
  publishConfig:{tag:'next'}};
const common={pkg:record,tag:'v0.5.0-rc.3',
  repo:'ainz-dg/wizard-of-skillz',commitSha:SHA,mainSha:SHA};

test('release event is the ONLY source of publication permission',()=>{
  const check=validateMetadata({...common,eventName:'workflow_dispatch',
    expectedCommit:SHA,ref:'refs/heads/main'});
  assert.equal(check.publish,false);
  assert.equal(check.mode,'DRY_RUN');
  assert.deepEqual(validateMetadata({...common,eventName:'release',
    tagSha:SHA,release:{draft:false,prerelease:true,tag_name:'v0.5.0-rc.3'}}),
  {mode:'PUBLISH',publish:true});
});
test('reject mismatch, renamed repo, stale main, wrong channel or non-rc release',()=>{
  const dry={...common,eventName:'workflow_dispatch',expectedCommit:SHA,ref:'refs/heads/main'};
  assert.throws(()=>validateMetadata({...dry,expectedCommit:'b'.repeat(40)}),/Approved commit/);
  assert.throws(()=>validateMetadata({...dry,mainSha:'b'.repeat(40)}),/main HEAD/);
  assert.throws(()=>validateMetadata({...dry,repo:'untrusted/fork'}),/repository/);
  assert.throws(()=>validateMetadata({...dry,ref:'refs/heads/unsafe'}),/only on main/);
  assert.throws(()=>validateMetadata({...dry,pkg:{...record,version:'0.5.0'}}),/rc versions/);
  assert.throws(()=>validateMetadata({...dry,pkg:{...record,publishConfig:{tag:'latest'}}}),/next tag/);
});
test('reject draft release, stable release, mismatched tag and private package',()=>{
  const pub={...common,eventName:'release',tagSha:SHA,
    release:{draft:false,prerelease:true,tag_name:'v0.5.0-rc.3'}};
  assert.throws(()=>validateMetadata({...pub,release:{...pub.release,draft:true}}),/prerelease/);
  assert.throws(()=>validateMetadata({...pub,release:{...pub.release,prerelease:false}}),/prerelease/);
  assert.throws(()=>validateMetadata({...pub,tagSha:'b'.repeat(40)}),/Tag must point/);
  assert.throws(()=>validateMetadata({...pub,pkg:{...record,private:true}}),/publishable/);
});
test('inspect the real set of shipped files, not just source package metadata',()=>{
  const files=['package.json','README.md','LICENSE','bin/wizard.mjs',
    'src/review-tui.mjs','docs/DOCUMENTED-DOMAIN.md','docs/ACCOUNT-PROVIDERS.md']
    .map(path=>({path}));
  const info={name:'wizard-of-skillz',version:'0.5.0-rc.3',
    shasum:'0'.repeat(40),integrity:'sha512-sample',files};
  assert.doesNotThrow(()=>validateArchiveInfo(info,record));
  assert.throws(()=>validateArchiveInfo({...info,files:[
    ...files,{path:'.env.production'}]},record),/Unexpected packaged file/);
  assert.throws(()=>validateArchiveInfo({...info,files:[
    ...files,{path:'docs/secret-token.md'}]},record),/Sensitive-looking/);
  assert.throws(()=>validateArchiveInfo({...info,files:files.slice(0,4)},record),/Release is missing/);
});
test('exact release bytes must match previous immutable sha256 job output',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-artifact-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file='wizard-of-skillz-0.5.0-rc.3.tgz';
  const content=Buffer.from('safe test fixture, not a real tarball');
  fs.writeFileSync(path.join(dir,file),content);
  const hash=crypto.createHash('sha256').update(content).digest('hex');
  fs.writeFileSync(path.join(dir,'release-archive.json'),JSON.stringify({
    package:'wizard-of-skillz',version:'0.5.0-rc.3',
    tarball:file,sha256:hash}));
  assert.equal(verifyStoredArtifact(dir,hash).sha256,hash);
  assert.throws(()=>verifyStoredArtifact(dir,'0'.repeat(64)),/upstream gate/);
  fs.writeFileSync(path.join(dir,file),'tampered');
  assert.throws(()=>verifyStoredArtifact(dir,hash),/bytes changed/);
});

test('first npm bootstrap can be recognized only for byte-identical archives',()=>{
  const release={package:'wizard-of-skillz',version:'0.5.0-rc.3',
    shasum:'f'.repeat(40),integrity:'sha512-example'};
  const existing={name:release.package,version:release.version,
    dist:{shasum:release.shasum,integrity:release.integrity}};
  assert.deepEqual(alreadyPublishedIdentity(null,release),{publishRequired:true});
  assert.deepEqual(alreadyPublishedIdentity(existing,release),{publishRequired:false});
  assert.throws(()=>alreadyPublishedIdentity({...existing,
    dist:{...existing.dist,shasum:'b'.repeat(40)}},release),/different bytes/);
  assert.throws(()=>alreadyPublishedIdentity({...existing,
    dist:{...existing.dist,integrity:'sha512-mismatched'}},release),/integrity differs/);
});
