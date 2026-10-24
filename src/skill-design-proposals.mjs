/**
 * Turn an existing, LLM-generated Agent Skills design into a review-only
 * CREATE/UPDATE proposal. Target scope is supplied explicitly; never write.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { renderSkillPackage, validateSkillDesign } from './skill-design.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') ||
      value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value) ||
      value.startsWith('~') || value.split('/').some(part => !part || part === '.' || part === '..'))
    throw Error('Expected a safe repository-relative skills directory');
  return value;
}

// Explicitly reject symlinked paths, including existing parents. A broken
// symlink also counts as occupied and must not become a CREATE target.
function inspectFile(root, relative) {
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw Error('Symlink in target path: ' + relative);
    if (i < parts.length - 1 && !stat.isDirectory())
      throw Error('Non-directory parent in target path: ' + relative);
    if (i === parts.length - 1) {
      if (!stat.isFile()) throw Error('Non-file target: ' + relative);
      return fs.readFileSync(current, 'utf8');
    }
  }
  return null;
}

export function proposeSkillDesignReview({ design, repoRoot, repoId, skillsDir }) {
  if (typeof repoId !== 'string' || !repoId.trim())
    throw Error('Explicit destination repository ID is required');
  const base = relativePath(skillsDir);
  const root = fs.realpathSync(repoRoot);
  if (!fs.statSync(root).isDirectory()) throw Error('Destination root must be a directory');
  const owner = design?._meta?.target_owner;
  if (owner && owner !== repoId)
    throw Error('Design owner does not match destination repository');
  const errors = validateSkillDesign(design);
  if (errors.length) throw Error('Invalid skill design: ' + errors.join('; '));
  const result = {
    schema_version: 1, consumer_repo: repoId, provider_repo: null,
    decision: design.decision, decision_reason: design.decision_reason ?? '',
    proposals: [], candidate_files: []
  };
  if (design.decision === 'NO_SKILL') return result;

  const candidate = renderSkillPackage(design);
  const directory = base + '/' + candidate.name;
  const mainPath = directory + '/SKILL.md';
  const currentMain = inspectFile(root, mainPath);
  // An occupied skill folder without SKILL.md is not evidence of a new skill.
  if (currentMain === null) {
    const folder = path.join(root, ...directory.split('/'));
    if (fs.lstatSync(folder, {throwIfNoEntry:false}) !== undefined)
      throw Error('Destination skill folder already exists without SKILL.md: ' + directory);
  }
  const action = currentMain === null ? 'CREATE' : 'UPDATE';
  for (const file of candidate.files) {
    const target = directory + '/' + relativePath(file.path);
    const existing = inspectFile(root, target);
    result.candidate_files.push({
      path: target,
      change: existing === null ? 'CREATE' : existing === file.content ? 'UNCHANGED' : 'UPDATE',
      current_sha256: existing === null ? null : sha(existing),
      candidate_sha256: sha(file.content),
      original_content: existing,
      candidate_content: file.content
    });
  }
  const changed = result.candidate_files.filter(f => f.change !== 'UNCHANGED');
  if (!changed.length) return result;
  const evidence = currentMain === null ? [] :
    [{repo:repoId,path:mainPath,sha256:sha(currentMain)}];
  result.proposals.push({
    id: 'design-' + sha(repoId + '\0' + mainPath).slice(0,16),
    action, skill: candidate.name,
    title: action + ' skill ' + candidate.name,
    reason: design.decision_reason || 'Review the generated Agent Skills candidate',
    source: action === 'UPDATE' ? {repo:repoId,path:mainPath} : undefined,
    target: {repo:repoId,path:mainPath},
    evidence, auto_apply: false,
    steps: changed.map(f=>f.change + ' ' + f.path + ' (candidate SHA-256 ' + f.candidate_sha256.slice(0,12) + '…)'),
    limits: [
      'Generated skill designs require human validation of source claims and ownership.',
      'Candidate file contents and original file contents are in candidate_files; no automatic patch is prepared.',
      'Other existing files in the skill folder are outside this proposal and will not be removed.'
    ]
  });
  return result;
}


/**
 * Exact, review-only full-file unified diff for generated CREATE/UPDATE
 * candidates. It deliberately uses one whole-file hunk per changed file
 * instead of hiding edits behind a patch algorithm.
 */
export function renderSkillDesignDiff(review) {
  if (!review || review.schema_version !== 1 ||
      !Array.isArray(review.candidate_files) || !Array.isArray(review.proposals))
    throw Error('Invalid design review');
  const paths = new Set();
  const output = [];
  const fileLines = (content, prefix) => {
    if (content === '') return [];
    const parts = content.split('\n');
    const newline = parts.at(-1) === '';
    if (newline) parts.pop();
    const lines = parts.map(x => prefix + x);
    if (!newline) lines.push('\\ No newline at end of file');
    return lines;
  };
  for (const f of review.candidate_files) {
    if (!f || typeof f.path !== 'string' || paths.has(f.path))
      throw Error('Invalid or duplicate candidate path');
    relativePath(f.path);
    paths.add(f.path);
    if (!['CREATE', 'UPDATE', 'UNCHANGED'].includes(f.change) ||
        typeof f.candidate_content !== 'string' ||
        sha(f.candidate_content) !== f.candidate_sha256)
      throw Error('Invalid candidate content or SHA-256: ' + f.path);
    const original = f.original_content;
    if (original !== null && (typeof original !== 'string' ||
        sha(original) !== f.current_sha256))
      throw Error('Original content does not match SHA-256: ' + f.path);
    const correct = original === null ? 'CREATE' :
      original === f.candidate_content ? 'UNCHANGED' : 'UPDATE';
    if (correct !== f.change || (original === null && f.current_sha256 !== null))
      throw Error('Candidate change classification does not match content: ' + f.path);
    if (f.change === 'UNCHANGED') continue;
    const oldLines = original === null ? [] : original.split('\n');
    if (original !== null && oldLines.at(-1) === '') oldLines.pop();
    const newLines = f.candidate_content === '' ? [] : f.candidate_content.split('\n');
    if (newLines.at(-1) === '') newLines.pop();
    output.push(
      '--- ' + (original === null ? '/dev/null' : 'a/' + f.path),
      '+++ b/' + f.path,
      '@@ -' + (oldLines.length ? 1 : 0) + ',' + oldLines.length +
        ' +' + (newLines.length ? 1 : 0) + ',' + newLines.length + ' @@',
      ...fileLines(original ?? '', '-'),
      ...fileLines(f.candidate_content, '+')
    );
  }
  return output.length ? output.join('\n') + '\n' : '';
}
