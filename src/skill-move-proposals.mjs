/**
 * Read-only MOVE review for an explicitly identified Agent Skills folder.
 * This is a relocation plan, not automatic detection of wrong ownership.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = data => createHash('sha256').update(data).digest('hex');
const MAX_FILES = 256;
const MAX_BYTES = 8 * 1024 * 1024;

function relative(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 ||
      value.includes('\\') || value.includes('\0') || value.startsWith('/') ||
      value.startsWith('~') || /^[A-Za-z]:/.test(value) ||
      value.split('/').some(p => !p || p === '.' || p === '..'))
    throw Error('Unsafe repository-relative ' + label);
  return value;
}

function rootDir(value) {
  const root = fs.realpathSync(value);
  if (!fs.statSync(root).isDirectory()) throw Error('Repository root must be a directory');
  return root;
}

function inspect(root, rel, kind) {
  const parts = rel.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      if (kind === 'source') throw Error('Source skill path does not exist: ' + rel);
      return current;
    }
    if (stat.isSymbolicLink()) throw Error('Symlink in ' + kind + ' path: ' + rel);
    if (i < parts.length - 1 && !stat.isDirectory())
      throw Error('Non-directory parent in ' + kind + ' path: ' + rel);
    if (i === parts.length - 1) {
      if (kind === 'target') throw Error('Destination skill folder is occupied: ' + rel);
      if (!stat.isFile()) throw Error('Source SKILL.md is not a file: ' + rel);
    }
  }
  return current;
}

function filesInSkill(folder, sourceDir, targetDir) {
  const files = [];
  let size = 0;
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error('Symlink inside skill folder: ' + entry.name);
      if (entry.isDirectory()) { visit(absolute); continue; }
      if (!entry.isFile()) throw Error('Unsupported filesystem entry inside skill folder: ' + entry.name);
      const stat = fs.statSync(absolute);
      size += stat.size;
      if (files.length >= MAX_FILES || size > MAX_BYTES)
        throw Error('Skill exceeds bounded MOVE review size');
      const bytes = fs.readFileSync(absolute);
      if (bytes.length !== stat.size) throw Error('Source changed during inventory: ' + entry.name);
      const suffix = path.relative(folder, absolute).split(path.sep).join('/');
      files.push({
        from: sourceDir + '/' + suffix,
        to: targetDir + '/' + suffix,
        sha256: hash(bytes),
        size_bytes: bytes.length
      });
    }
  };
  visit(folder);
  return files;
}

/** Produces a source-hashed, destination-collision-checked review. Never writes. */
export function proposeSkillMoveReview({
  sourceRoot, sourceRepo, sourceSkill, targetRoot, targetRepo, skillsDir, reason
}) {
  if (typeof sourceRepo !== 'string' || !sourceRepo.trim() ||
      typeof targetRepo !== 'string' || !targetRepo.trim())
    throw Error('Explicit source and destination repository IDs are required');
  const from = relative(sourceSkill, 'source SKILL.md');
  if (!from.endsWith('/SKILL.md')) throw Error('Source must identify a SKILL.md inside a skill folder');
  const base = relative(skillsDir, 'destination skills directory');
  const source = rootDir(sourceRoot), target = rootDir(targetRoot);
  if ((source === target) !== (sourceRepo === targetRepo))
    throw Error('Repository IDs and roots disagree');
  const name = path.posix.basename(path.posix.dirname(from));
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    throw Error('Source skill directory does not use a portable Agent Skills name');
  const sourceFolderRel = path.posix.dirname(from);
  const targetFolderRel = base + '/' + name;
  const destinationMain = targetFolderRel + '/SKILL.md';
  const sourceMain = inspect(source, from, 'source');
  const fromFolder = path.dirname(sourceMain);
  const toFolder = path.join(target, ...targetFolderRel.split('/'));
  if (toFolder === fromFolder || toFolder.startsWith(fromFolder + path.sep) ||
      target === fromFolder || target.startsWith(fromFolder + path.sep))
    throw Error('Destination may not be the source skill or inside its folder');
  inspect(target, targetFolderRel, 'target');

  const file_manifest = filesInSkill(fromFolder, sourceFolderRel, targetFolderRel);
  const main = file_manifest.find(f => f.from === from);
  if (!main) throw Error('SKILL.md missing from source manifest');
  const motive = typeof reason === 'string' && reason.trim()
    ? reason.trim() : 'Explicit human-supplied relocation candidate; ownership has not been inferred';
  const proposal = {
    id: 'move-' + hash([sourceRepo, from, targetRepo, destinationMain].join('\0')).slice(0, 16),
    action: 'MOVE', title: 'Review relocation of ' + name, skill: name,
    reason: motive,
    source: { repo: sourceRepo, path: from },
    target: { repo: targetRepo, path: destinationMain },
    evidence: file_manifest.map(f => ({repo:sourceRepo,path:f.from,sha256:f.sha256})),
    auto_apply: false,
    steps: file_manifest.map(f => 'MOVE ' + f.from + ' -> ' + f.to + ' (SHA-256 ' + f.sha256.slice(0,12) + '…)'),
    limits: [
      'Relocation scope is explicitly supplied; no automatic proof of misplaced ownership.',
      'Cross-repository inbound links, consumers, and semantic validity are not verified.',
      'The destination folder is unoccupied at review time, not reserved; recheck before any apply.',
      'This review does not move, copy, delete or modify any file.'
    ]
  };
  return {schema_version:1,consumer_repo:sourceRepo,provider_repo:targetRepo,
    proposals:[proposal],file_manifest,write_authorized:false};
}
