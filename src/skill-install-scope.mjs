/**
 * Minimal, read-only installation scope resolver.
 * User-level paths are a distribution signal, NOT proof a client loaded them.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const USER_SKILL_ROOTS = ['.agents/skills', '.claude/skills'];

export function resolveInstalledScope(repoRoot, {
  requested='auto', homeDir=os.homedir()
}={}) {
  if (!['auto','repo','shared'].includes(requested))
    throw Error('Installed scope must be auto, repo or shared');
  if (requested !== 'auto') return {
    scope:requested,
    basis:requested==='shared'?'EXPLICIT_SHARED_INSTALLATION':'EXPLICIT_REPOSITORY_INSTALLATION',
    install_root:null
  };

  // Compare a user-level entry point, not a skill's arbitrary directory name.
  // No filesystem traversal and no reading agents' private configuration.
  const given=path.resolve(repoRoot);
  const home=path.resolve(homeDir);
  for(const relative of USER_SKILL_ROOTS) {
    if(given===path.join(home,...relative.split('/'))) {
      // Ensure the entry point really exists; audit already requires it.
      if(!fs.statSync(given).isDirectory())throw Error('Skill installation root must be a directory');
      return {scope:'shared',basis:'USER_LEVEL_INSTALL_PATH',install_root:'~/'+relative};
    }
  }
  // Existing audit always receives an inspected repository root. Do not
  // infer user/shared scope from .agents/skills inside a project checkout.
  return {scope:'repo',basis:'AUDIT_REPOSITORY_DEFAULT',install_root:null};
}
