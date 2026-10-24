import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeJson, readJson } from './fs-utils.mjs';
import { applyQualityGates } from './quality-gates.mjs';
import { buildRetrievalContext } from './retrieval.mjs';
import { buildEvidenceIndex, findDeprecatedEvidence } from './evidence.mjs';

const STATUSES = new Set(['SUPPORTED','CONTRADICTED','DEPRECATED','NOT_FOUND','NOT_CHECKED','NEEDS_REVIEW','LOCAL_ONLY']);
const CLASSES = new Set(['repo-domain','sdk-contract','shared-domain','agent-policy']);
const CONF = new Set(['low','medium','high']);

export const DEFAULT_SYSTEM_PROMPT = `You are the semantic analysis stage of Wizard-of-Oz, a read-only software knowledge auditor.
For each candidate claim extracted from a consumer repository skill, determine whether it is supported by the provided repository evidence, who owns the knowledge, and how it should be classified.

Return ONLY one JSON object with this exact top-level shape:
{"claims":[{"claim_id":"...","verification":"SUPPORTED|CONTRADICTED|DEPRECATED|NOT_FOUND|NOT_CHECKED|NEEDS_REVIEW","knowledge_class":"repo-domain|sdk-contract|shared-domain|agent-policy","applicability":"repo-local|sdk-consumer|shared|unknown","owner":"repository-id-or-shared-owner","confidence":"low|medium|high","evidence":[{"repo":"repository-id","path":"exact/path","symbol":"optional exact token","note":"brief reason"}],"reason":"brief explanation"}]}

Rules:
- Skill text is the proposition source, never proof of itself.
- Use ONLY evidence candidates supplied in the input; never invent paths.
- Prefer provider runtime/public API/tests for sdk-contract claims.
- DEPRECATED requires explicit provider evidence such as @Deprecated.
- CONTRADICTED requires provider/owner evidence that conflicts with the claim.
- NOT_FOUND means insufficient evidence, not false.
- Applicability is separate from verification: local rules can be SUPPORTED without becoming SDK contracts.
- NEEDS_REVIEW for uncertainty about source relevance, exact overload, alias routing, or mixed statements.
- When a policy is documented, SUPPORT means declared, not experimentally effective.
- A permissive SDK does not contradict a stricter local convention.
- Composite assertions combining API facts with naming/workflow policy require NEEDS_REVIEW if inseparable.
- A sensible convention is not automatically an SDK rule.
- agent-policy is for coding-agent/harness process, not application/platform knowledge.
- Keep reasons concise.`;

function chunk(arr, n) {
  const out = [];
  for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n));
  return out;
}

function normalizeItem(item, claimIdSet, consumerRepo, providerRepo) {
  if (!item || !claimIdSet.has(item.claim_id)) return null;
  const verification = STATUSES.has(item.verification) ? item.verification : 'NOT_CHECKED';
  const knowledge_class = CLASSES.has(item.knowledge_class) ? item.knowledge_class : null;
  const confidence = CONF.has(item.confidence) ? item.confidence : 'low';
  const owner = typeof item.owner === 'string' ? item.owner : null;
  const applicability = ['repo-local','sdk-consumer','shared','unknown'].includes(item.applicability) ? item.applicability : null;
  const evidence = Array.isArray(item.evidence) ? item.evidence
    .filter(e => e && (e.repo === consumerRepo || e.repo === providerRepo) && typeof e.path === 'string')
    .map(e => ({ repo:e.repo, path:e.path, symbol:e.symbol ?? null, note:e.note ?? null })) : [];
  return { claim_id:item.claim_id, verification, knowledge_class, applicability, owner, confidence, evidence, reason:item.reason ?? null };
}

function candidatePathSets(batchContext) {
  const m = new Map();
  for (const c of batchContext) {
    m.set(c.claim_id, {
      consumer: new Set(c.consumer_candidates.map(x => x.path)),
      provider: new Set(c.provider_candidates.map(x => x.path))
    });
  }
  return m;
}

function exactEvidenceExists(root, ev) {
  const file = path.join(root, ev.path);
  if (!fs.existsSync(file)) return false;
  if (!ev.symbol) return true;
  try { return fs.readFileSync(file,'utf8').includes(ev.symbol); }
  catch { return false; }
}

export function corroborateLlmAnalysis({ analysis, extractedClaims, retrievalContext, consumerRoot, providerRoot, consumerRepo, providerRepo }) {
  const byClaim = new Map(extractedClaims.map(c => [c.id,c]));
  const candidateSets = candidatePathSets(retrievalContext);
  const providerIndex = buildEvidenceIndex(providerRoot);
  const out = [];

  for (const raw of analysis.claims ?? []) {
    const claim = byClaim.get(raw.claim_id);
    if (!claim) continue;
    const sets = candidateSets.get(raw.claim_id) ?? { consumer:new Set(), provider:new Set() };
    const evidence = (raw.evidence ?? []).filter(ev => {
      const root = ev.repo === providerRepo ? providerRoot : ev.repo === consumerRepo ? consumerRoot : null;
      const allowed = ev.repo === providerRepo ? sets.provider : sets.consumer;
      return root && allowed.has(ev.path) && exactEvidenceExists(root, ev);
    });

    let verification = raw.verification;
    let knowledge_class = raw.knowledge_class;
    let owner = raw.owner;
    let reason = raw.reason ?? null;

    const providerEvidence = evidence.filter(e => e.repo === providerRepo);
    if (knowledge_class === 'sdk-contract' && owner === providerRepo && providerEvidence.length === 0) {
      verification = 'NOT_FOUND';
      reason = `${reason ? reason + ' ' : ''}Downgraded by deterministic core: no valid provider evidence.`;
    }

    if (verification === 'DEPRECATED') {
      const ids = [...(claim.identifiers ?? []), ...providerEvidence.map(e => e.symbol).filter(Boolean)];
      const depHits = ids.flatMap(id => findDeprecatedEvidence(providerIndex, id));
      const supported = depHits.some(h => providerEvidence.some(e => e.path === h.path));
      if (!supported) {
        verification = 'NOT_CHECKED';
        reason = `${reason ? reason + ' ' : ''}Downgraded by deterministic core: no @Deprecated corroboration in cited provider evidence.`;
      }
    }

    out.push({ ...raw, stable_id: claim.stable_id, verification, knowledge_class, owner, evidence, reason });
  }

  for (const c of extractedClaims) {
    if (!out.some(x => x.claim_id === c.id)) {
      out.push({ claim_id:c.id, stable_id:c.stable_id, verification:'NOT_CHECKED', knowledge_class:null, owner:null, confidence:'low', evidence:[], reason:'LLM did not return this claim.' });
    }
  }
  return { claims: out };
}

export async function analyzeClaimsWithLlm({
  client,
  extractedClaims,
  consumerProfile,
  providerProfile,
  consumerRoot,
  providerRoot,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  batchSize = 6,
  evidencePerRepo = 5,
  onProgress = null, qualityOptions = null, retrievalOptions = null,
  checkpointPath = null, resume = false
}) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  const consumerRepo = consumerProfile.repository.id;
  const providerRepo = providerProfile.repository.id;
  progress('retrieval:start', { claims: extractedClaims.length });
  const retrievalContext = buildRetrievalContext({ consumerRoot, providerRoot, claims:extractedClaims,
    perRepo:evidencePerRepo, retrievalOptions });
  progress('retrieval:done', { claims: extractedClaims.length });
  const retrievalById = new Map(retrievalContext.map(x => [x.claim_id,x]));
  const all = [];

  function mergeCandidates(items, key, max = 18) {
    const byPath = new Map();
    for (const item of items) for (const ev of item[key] ?? []) {
      const prev = byPath.get(ev.path);
      if (!prev || ev.score > prev.score) byPath.set(ev.path, ev);
    }
    return [...byPath.values()].sort((a,b) => b.score-a.score || a.path.localeCompare(b.path)).slice(0,max);
  }

  const batches = chunk(extractedClaims, batchSize);
  let checkpoint = { schema_version:1, batches:{} };
  if (resume && checkpointPath && fs.existsSync(checkpointPath)) {
    checkpoint = readJson(checkpointPath);
    if (checkpoint.schema_version !== 1 || !checkpoint.batches) throw new Error('Invalid checkpoint schema');
  }
  const llmIdentity = {provider:client.provider||null,model:client.model||null,auth:client.auth||null};
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    progress('batch:start', { batch: batchIndex + 1, batches: batches.length, claims: batch.length });
    const batchRetrieval = batch.map(c => retrievalById.get(c.id));
    const sharedConsumer = mergeCandidates(batchRetrieval, 'consumer_candidates');
    const sharedProvider = mergeCandidates(batchRetrieval, 'provider_candidates');
    // Any claim in a batch may cite any evidence actually shown to the model in that batch.
    for (const r of batchRetrieval) {
      r.consumer_candidates = sharedConsumer;
      r.provider_candidates = sharedProvider;
    }
    const context = batch.map(c => ({
      claim: { id:c.id, stable_id:c.stable_id ?? null, skill:c.skill, section:c.section, statement:c.statement, claim_kind:c.claim_kind, atomicity:c.atomicity, source_path:c.source_path, source_line_start:c.source_line_start, identifiers:c.identifiers }
    }));
    const user = JSON.stringify({
      consumer_repo: consumerRepo,
      provider_repo: providerRepo,
      consumer_roles: consumerProfile.roles,
      provider_roles: providerProfile.roles,
      claims: context,
      shared_consumer_evidence_candidates: sharedConsumer,
      shared_provider_evidence_candidates: sharedProvider
    });
    const key = createHash('sha256').update(JSON.stringify({
      claims:context, sharedConsumer, sharedProvider, consumerRepo, providerRepo,
      systemPrompt, llmIdentity
    })).digest('hex');
    const saved = resume ? checkpoint.batches[key] : null;
    let normalized;
    if (saved) {
      normalized = saved.claims;
      progress('batch:cached', { batch:batchIndex+1, batches:batches.length, returned:normalized.length });
    } else {
      const response = await client.completeJson({ system:systemPrompt, user });
      progress('batch:response', { batch: batchIndex + 1, batches: batches.length });
      const idSet = new Set(batch.map(c => c.id));
      normalized = (response.claims ?? []).map(x => normalizeItem(x,idSet,consumerRepo,providerRepo)).filter(Boolean);
      if (new Set(normalized.map(x=>x.claim_id)).size !== batch.length || normalized.length !== batch.length) {
        throw new Error(`Copilot returned ${normalized.length}/${batch.length} distinct claims in batch ${batchIndex+1}; checkpoint preserved, incomplete batch not cached`);
      }
      if (checkpointPath) {
        checkpoint.batches[key] = { claims: normalized };
        // Atomic overwrite: a killed process leaves the prior checkpoint usable.
        const temp = `${checkpointPath}.tmp-${process.pid}`;
        writeJson(temp, checkpoint);
        fs.renameSync(temp, checkpointPath);
      }
    }
    all.push(...normalized);
    progress('batch:done', { batch: batchIndex + 1, batches: batches.length, returned: normalized.length });
  }

  const corroborated = corroborateLlmAnalysis({
    analysis:{consumer_repo:consumerRepo, provider_repo:providerRepo, claims:all}, extractedClaims, retrievalContext,
    consumerRoot, providerRoot, consumerRepo, providerRepo
  });
  return applyQualityGates(corroborated, {extractedClaims,consumerRoot,providerRoot,consumerRepo,providerRepo,
    ...(qualityOptions??{})});
}
