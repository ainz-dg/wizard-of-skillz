import { createHash } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
const brokenStatuses = new Set(['MISSING', 'UNSAFE', 'NOT_A_FILE']);

/**
 * Turn existing read-only link diagnostics into one manually reviewable
 * UPDATE per affected SKILL.md. Never invent replacement content or writes.
 */
export function proposeSkillReferenceRepairs({ repoId, skills, audit }) {
  if (typeof repoId !== 'string' || !repoId.trim() ||
      !Array.isArray(skills) || !Array.isArray(audit?.links))
    throw Error('Invalid skill reference proposal input');
  const badLinks = new Map();
  for (const link of audit.links) {
    if (!brokenStatuses.has(link.status)) continue;
    if (typeof link.skill !== 'string' || typeof link.target !== 'string')
      throw Error('Malformed reference audit entry');
    const existing = badLinks.get(link.skill) ?? [];
    existing.push(link);
    badLinks.set(link.skill, existing);
  }
  const proposals = [];
  for (const skill of skills) {
    const links = badLinks.get(skill.path);
    if (!links?.length) continue;
    if (typeof skill.path !== 'string' || typeof skill.text !== 'string')
      throw Error('Malformed inventory entry');
    const location = { repo: repoId, path: skill.path };
    const statuses = [...new Set(links.map(link => link.status))].join(', ');
    proposals.push({
      id: 'skill-references-' + hash(repoId + '\0' + skill.path).slice(0, 16),
      action: 'UPDATE',
      title: 'Review broken references in ' + skill.path,
      skill: skill.id ?? null,
      source: location,
      target: location,
      reason: links.length + ' broken explicit reference link(s): ' + statuses,
      evidence: [{ repo: repoId, path: skill.path, sha256: hash(skill.text) }],
      steps: links.map(link =>
        'Review ' + link.status + ' link ' + link.target +
        '; correct the link or source only after checking the intended reference.'),
      limits: [
        'Only explicit Markdown links to references/ are checked; this is not full Markdown or semantic validation.',
        'No replacement path or content is inferred. A human must prepare and review any correction.'
      ],
      auto_apply: false
    });
  }
  return {
    schema_version: 1,
    consumer_repo: repoId,
    proposals,
    discovery: 'EXPLICIT_SKILL_REFERENCE_LINKS',
    read_only: true
  };
}
