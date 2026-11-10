import fs from 'node:fs';
import path from 'node:path';

const STATUSES = new Set(['SUPPORTED','CONTRADICTED','DEPRECATED','NOT_FOUND','LOCAL_ONLY','NOT_CHECKED','NEEDS_REVIEW']);
const CLASSES = new Set(['repo-domain','sdk-contract','shared-domain','agent-policy']);

export function validateAnalysis(analysis, {
  consumerRoot, providerRoot, consumerRepo, providerRepo
} = {}) {
  const errors = [];
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis))
    return ['analysis must be an object'];
  if (!Array.isArray(analysis.claims))
    return ['analysis.claims must be an array (raw batch checkpoints are not audit analyses)'];
  if (typeof analysis.consumer_repo !== 'string' || !analysis.consumer_repo.trim())
    errors.push('analysis.consumer_repo must be a non-empty string');
  if (typeof analysis.provider_repo !== 'string' || !analysis.provider_repo.trim())
    errors.push('analysis.provider_repo must be a non-empty string');
  if (consumerRepo && analysis.consumer_repo !== consumerRepo)
    errors.push(`analysis.consumer_repo does not match requested identity ${consumerRepo}`);
  if (providerRepo && analysis.provider_repo !== providerRepo)
    errors.push(`analysis.provider_repo does not match requested identity ${providerRepo}`);
  for (const [index, item] of analysis.claims.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`claims[${index}] must be an object`);
      continue;
    }
    if (!item.claim_id) errors.push('claim without claim_id');
    if (!STATUSES.has(item.verification)) errors.push(`${item.claim_id}: invalid verification ${item.verification}`);
    if (item.knowledge_class && !CLASSES.has(item.knowledge_class)) errors.push(`${item.claim_id}: invalid knowledge_class ${item.knowledge_class}`);
    if (item.evidence !== undefined && !Array.isArray(item.evidence)) {
      errors.push(`${item.claim_id}: evidence must be an array`);
      continue;
    }
    for (const ev of item.evidence ?? []) {
      if (!ev || typeof ev !== 'object' || typeof ev.repo !== 'string' ||
          typeof ev.path !== 'string' || ev.path.includes('\0')) {
        errors.push(`${item.claim_id}: invalid evidence reference`);
        continue;
      }
      const root = ev.repo === analysis.provider_repo ? providerRoot :
        ev.repo === analysis.consumer_repo ? consumerRoot : null;
      if (!root || !fs.existsSync(path.join(root, ev.path))) errors.push(`${item.claim_id}: missing evidence path ${ev.repo}:${ev.path}`);
    }
  }
  return errors;
}

export function joinAnalysis(extractedClaims, analysis) {
  const byId = new Map((analysis.claims ?? []).map(x => [x.claim_id, x]));
  const byStableId = new Map((analysis.claims ?? []).filter(x => x.stable_id).map(x => [x.stable_id, x]));
  return extractedClaims.map(c => {
    // Prefer the exact content identity. A legacy positional LLM result only
    // describes one physical line, so it cannot prove a merged multiline claim.
    const stableMatch = byStableId.get(c.stable_id);
    const oldMatch = c.extraction_form === 'MULTILINE_PROPOSITION' || c.requires_content_identity ? null : byId.get(c.id);
    const match = stableMatch ?? (oldMatch && (!oldMatch.stable_id || oldMatch.stable_id === c.stable_id) ? oldMatch : null);
    return { ...c, ...(match ?? {}), ...(match ? { claim_id:c.id } : {}) };
  });
}
