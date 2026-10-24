/** Conservative, read-only decision normalization and evidence review.
 * Evidence existence is NOT entailment. A semantically alleged contradiction is
 * not a verified contradiction until an independent, targeted check establishes it.
 */
import { assessEvidence } from './evidence-integrity.mjs';

const VALID = new Set(['SUPPORTED','CONTRADICTED','DEPRECATED','NOT_FOUND','NOT_CHECKED','NEEDS_REVIEW']);
const VALID_SCOPE = new Set(['repo-local','sdk-consumer','shared','unknown']);

function scopeFor(c, consumerRepo, providerRepo) {
  if (c.applicability && VALID_SCOPE.has(c.applicability)) return c.applicability;
  if (c.knowledge_class === 'shared-domain' && c.owner !== consumerRepo && c.owner !== providerRepo) return 'shared';
  if (c.owner === providerRepo && c.knowledge_class === 'sdk-contract') return 'sdk-consumer';
  if (c.owner === consumerRepo) return 'repo-local';
  return 'unknown';
}

export function applyQualityGates(analysis, {
  extractedClaims = [], consumerRepo = analysis.consumer_repo, providerRepo = analysis.provider_repo,
  consumerRoot = null, providerRoot = null,
  sourceContractInspection = null, contractReferenceProof = null
} = {}) {
  const original = new Map(extractedClaims.map(c => [c.id, c]));
  const source_contracts = sourceContractInspection??{
    schema_version:1,contracts:[],status:'NOT_INSPECTED'
  };
  const claims = (analysis.claims || []).map(raw => {
    const src = original.get(raw.claim_id) || raw;
    const issues = [...(raw.review_flags || [])];
    const evidence = Array.isArray(raw.evidence) ? [...raw.evidence] : [];
    let verification = raw.verification;
    let confidence = raw.confidence || 'low';
    let evidence_quality = 'UNVERIFIED_SEMANTICS';
    let reason = raw.reason || null;

    // An older positional result may refer only to a fragment of a newly
    // reconstructed multiline claim. Never silently inherit that verdict.
    const legacyMultiline = (src.extraction_form === 'MULTILINE_PROPOSITION' || src.requires_content_identity) && !raw.stable_id;
    const contentMismatch = Boolean(raw.stable_id && src.stable_id && raw.stable_id !== src.stable_id);
    if (legacyMultiline || contentMismatch) {
      verification = 'NOT_CHECKED';
      confidence = 'low';
      issues.push('STALE_ANALYSIS_CLAIM: rerun semantic verification for updated claim text');
      reason = 'Existing LLM verdict is not bound to the complete current claim; semantic re-verification required.';
    }

    // v0.4.4 treated locality as truth; migrate without pretending it was verified.
    if (!legacyMultiline && !contentMismatch && verification === 'LOCAL_ONLY') {
      verification = 'NEEDS_REVIEW';
      issues.push('LEGACY_LOCAL_ONLY: locality is not verification');
    }
    if (!VALID.has(verification)) {
      verification = 'NOT_CHECKED';
      issues.push('INVALID_VERIFICATION');
    }
    const sourcePath = src.source_path || src.skill_path;
    let evidence_integrity = assessEvidence(evidence, {
      consumerRepo, providerRepo, consumerRoot, providerRoot, claimSourcePath:sourcePath
    });
    const independent = evidence_integrity.checks.filter(e => e.status === 'REFERENCE_VALID');
    if (evidence.length === 0) evidence_quality = 'NONE';
    else if (evidence_integrity.status === 'NOT_INSPECTED') evidence_quality = 'ROOT_NOT_AVAILABLE';
    else if (evidence_integrity.status === 'INVALID_ONLY') evidence_quality = 'INVALID_CITATIONS';
    else if (evidence_integrity.status === 'PARTIALLY_VALID') evidence_quality = 'PARTIALLY_INVALID_CITATIONS';
    else if (independent.length === 0) evidence_quality = 'DECLARATION_ONLY';
    else if (independent.some(e => e.repo === providerRepo)) evidence_quality = 'PROVIDER_CITATION_NOT_ENTAILMENT';
    else evidence_quality = 'INDEPENDENT_CITATION_NOT_ENTAILMENT';
    if (evidence_integrity.invalid_count > 0) {
      issues.push('INVALID_EVIDENCE_REFERENCE: path, file or cited symbol cannot be verified');
      if (verification === 'SUPPORTED' && evidence_integrity.valid_count === 0) {
        verification = 'NEEDS_REVIEW';
        confidence = 'low';
        issues.push('SUPPORTED_WITHOUT_VALID_CITATION');
      }
    }
    if (evidence_integrity.status === 'NOT_INSPECTED') {
      issues.push('EVIDENCE_ROOT_UNAVAILABLE: cannot check source references offline');
    }
    if (evidence_integrity.status === 'SELF_REFERENCE_ONLY' && verification === 'SUPPORTED') {
      // A skill claiming something in its own text is not technical evidence.
      verification = 'NEEDS_REVIEW';
      confidence = 'low';
      issues.push('SUPPORTED_ONLY_BY_OWN_SKILL: find an independent source');
    }

    // A citation to a path/identifier is not a proof of contradiction.
    if (verification === 'CONTRADICTED') {
      verification = 'NEEDS_REVIEW';
      issues.push('CONTRADICTION_REQUIRES_ENTAILMENT: verify scope, aliases and source meaning');
      confidence = 'low';
    }
    if (verification === 'DEPRECATED') {
      verification = 'NEEDS_REVIEW';
      issues.push('DEPRECATION_REQUIRES_EXACT_OVERLOAD');
    }
    const statement = src.claim_text || src.statement || raw.claim_text || raw.statement || '';
    const extractionForm = src.extraction_form || (statement.trim().endsWith(':') ? 'INCOMPLETE_LEAD_IN' : 'PROPOSITION');
    if (extractionForm === 'INCOMPLETE_LEAD_IN') issues.push('INCOMPLETE_LEAD_IN: not a complete actionable proposition');
    // Presence of a deprecated overload proves API metadata, NOT the claim
    // that a particular consumer invokes it. Do not promote normative advice
    // or a consumer call-site assertion to a verified fact.
    let referenced_api_status = null;
    let contract_proof = null;
    const contract=typeof contractReferenceProof==='function'?
      contractReferenceProof(statement):null;
    if(contract){
      if(contract.status!=='DEPRECATED'||!Array.isArray(contract.evidence))
        throw Error('Invalid optional source contract proof');
      referenced_api_status=contract.status;
      issues.push('DEPRECATED_API_REFERENCE: externally proven contract');
      for(const anchor of contract.evidence){
        if(!evidence.some(e=>e.repo===anchor.repo&&e.path===anchor.path&&e.line===anchor.line)){
          evidence.push({repo:anchor.repo,path:anchor.path,line:anchor.line,
            note:'Source contract: exact anchored declaration'});
        }
      }
      if(contract.explicit){
        verification='DEPRECATED';evidence_quality='EXACT_SOURCE_MATCH';
        confidence='high';contract_proof=contract.proof_id;
        reason=contract.reason;issues.push('EXACT_DEPRECATED_OVERLOAD');
      }else if(verification==='SUPPORTED'||verification==='NOT_FOUND'){
        verification='NEEDS_REVIEW';confidence='low';reason=contract.caveat;
      }
    }
    // The exact-contract checker may add a source-level citation; ensure
    // the integrity snapshot reflects what is actually returned. Do not
    // mutate analysis input evidence arrays.
    if (referenced_api_status) {
      evidence_integrity = assessEvidence(evidence, {
        consumerRepo, providerRepo, consumerRoot, providerRoot, claimSourcePath:sourcePath
      });
    }
    const verification_basis = contract_proof ? 'DETERMINISTIC_PROOF' :
      (evidence_integrity.independent_count > 0 || referenced_api_status) ? 'CITATION_ONLY' : 'UNVERIFIED';
    const applicability = scopeFor(raw,consumerRepo,providerRepo);
    if (raw.knowledge_class === 'shared-domain' && applicability === 'repo-local') {
      issues.push('CLASS_SCOPE_CONFLICT: shared-domain with repo-local owner');
    }
    if (src.atomicity?.status === 'REVIEW_SPLIT') issues.push('COMPOUND_CLAIM_REVIEW_SPLIT');
    if (verification === 'SUPPORTED' && evidence_quality === 'NONE') {
      verification = 'NEEDS_REVIEW'; issues.push('SUPPORTED_WITHOUT_EVIDENCE');
    }
    return {
      ...raw, claim_text:statement || undefined, source_path:sourcePath || undefined,
      source_line_start:src.source_line_start ?? raw.source_line_start ?? null,
      source_line_end:src.source_line_end ?? raw.source_line_end ?? null,
      claim_kind:src.claim_kind || raw.claim_kind || null,
      extraction_form:extractionForm, source_hash:src.source_hash || raw.source_hash || null,
      atomicity:src.atomicity || raw.atomicity || null,
      original_verification:raw.original_verification || raw.verification,
      verification, applicability, evidence_quality, evidence_integrity, verification_basis,
      referenced_api_status, contract_proof, evidence, confidence, reason,
      review_flags:[...new Set(issues)]
    };
  });
  return {...analysis,claims,source_contracts,_meta:{...(analysis._meta||{}),
    quality_gates:sourceContractInspection?'optional-source-contracts':'generic-evidence-first',
    note:'Quality gates conservatively downgrade uncertain claims; legacy inputs are reinterpreted, not re-verified by a live model.'}};
}

export function qualitySummary(analysis) {
  const count = field => (analysis.claims||[]).reduce((acc,c)=>{
    const x=field.split('.').reduce((v,k)=>v?.[k],c)||'unknown'; acc[x]=(acc[x]||0)+1; return acc;
  },{});
  return { claims:(analysis.claims||[]).length, verification:count('verification'),
    applicability:count('applicability'), evidence_quality:count('evidence_quality'),
    evidence_integrity:count('evidence_integrity.status'), verification_basis:count('verification_basis'),
    needing_review:(analysis.claims||[]).filter(c=>(c.review_flags||[]).length>0).length };
}
