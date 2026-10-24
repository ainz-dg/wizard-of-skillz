import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveInstalledScope} from '../src/skill-install-scope.mjs';

function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wizard-install-scope-'));
  const home=path.join(root,'home');
  const project=path.join(root,'project');
  fs.mkdirSync(path.join(home,'.agents/skills'),{recursive:true});
  fs.mkdirSync(path.join(home,'.claude/skills'),{recursive:true});
  fs.mkdirSync(path.join(project,'.agents/skills'),{recursive:true});
  return {root,home,project,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test('auto recognizes actual home-level Agent Skills and Claude skill roots',()=>{
  const f=fixture();
  try {
    for(const rel of ['.agents/skills','.claude/skills']) {
      const result=resolveInstalledScope(path.join(f.home,rel),{homeDir:f.home});
      assert.equal(result.scope,'shared');
      assert.equal(result.basis,'USER_LEVEL_INSTALL_PATH');
      assert.equal(result.install_root,'~/'+rel);
    }
  } finally {f.cleanup();}
});

test('project .agents/skills does not become global merely because of directory name',()=>{
  const f=fixture();
  try {
    const result=resolveInstalledScope(f.project,{homeDir:f.home});
    const nested=resolveInstalledScope(path.join(f.project,'.agents/skills'),{homeDir:f.home});
    assert.equal(result.scope,'repo');
    assert.equal(nested.scope,'repo');
    assert.equal(nested.basis,'AUDIT_REPOSITORY_DEFAULT');
    assert.equal(nested.install_root,null);
  } finally {f.cleanup();}
});

test('explicit operator scope overrides auto, with clear origin and invalid options rejected',()=>{
  const f=fixture();
  try {
    const global=path.join(f.home,'.agents/skills');
    assert.deepEqual(resolveInstalledScope(global,{homeDir:f.home,requested:'repo'}),{
      scope:'repo',basis:'EXPLICIT_REPOSITORY_INSTALLATION',install_root:null
    });
    assert.deepEqual(resolveInstalledScope(f.project,{homeDir:f.home,requested:'shared'}),{
      scope:'shared',basis:'EXPLICIT_SHARED_INSTALLATION',install_root:null
    });
    assert.throws(()=>resolveInstalledScope(f.project,{homeDir:f.home,requested:'global'}),/auto, repo or shared/);
  } finally {f.cleanup();}
});

test('unverified paths resembling global installs outside home are not promoted',()=>{
  const f=fixture();
  try {
    const fake=path.join(f.project,'home/.agents/skills');
    fs.mkdirSync(fake,{recursive:true});
    assert.equal(resolveInstalledScope(fake,{homeDir:f.home}).scope,'repo');
  } finally {f.cleanup();}
});
