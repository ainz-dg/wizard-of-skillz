function prescribesDeprecatedInvocation(statement='') {
  // A deprecated declaration is not proof of the consumer's current call site.
  // A positive instruction to *use* that overload is outdated guidance.
  return /^(?:use|always use|you must use|you should use|call|invoke|start)\b/i.test(statement.trim())
    && !/^(?:do not|never|avoid)\b/i.test(statement.trim());
}

export function deriveFindings(claims, { consumerRepo, providerRepo }) {
  const findings = [];
  let n = 0;
  const nextId = () => `W-${String(++n).padStart(3,'0')}`;

  for (const c of claims) {
    const base = {
      id: nextId(),
      claim_id: c.id,
      skill: c.skill,
      statement: c.statement,
      evidence: c.evidence ?? [],
      confidence: c.confidence ?? 'medium'
    };

    if (c.referenced_api_status === 'DEPRECATED' && prescribesDeprecatedInvocation(c.statement)) {
      findings.push({ ...base, type: 'STALE_SKILL', severity: 'high', recommendation: 'UPDATE', owner: c.owner ?? providerRepo,
        source_contract:'JAVA-BOOTSTRAP-DEPRECATED',
        note:'The instruction prescribes an overload whose deprecation is source-backed; this is not evidence of current consumer call sites.' });
      continue;
    }
    if (c.verification === 'DEPRECATED') {
      findings.push({ ...base, type: 'API_DEPRECATION_CONFIRMED', severity: 'info', recommendation: 'CHECK_USAGE', owner:c.owner ?? providerRepo });
      continue;
    }
    if (c.verification === 'CONTRADICTED' || c.verification === 'NEEDS_REVIEW') {
      findings.push({ ...base, type: 'REVIEW_REQUIRED', severity: 'medium', recommendation: 'VERIFY_BEFORE_EDIT', owner: c.owner ?? null, review_flags:c.review_flags??[] });
      continue;
    }
    if (c.verification === 'SUPPORTED' && c.knowledge_class === 'sdk-contract' && c.owner === providerRepo) {
      findings.push({ ...base, type: 'PROMOTION_CANDIDATE', severity: 'medium', recommendation: 'VERIFY_SDK_OWNER_BEFORE_PROMOTE', owner: providerRepo });
      continue;
    }
    if (c.knowledge_class === 'agent-policy') {
      findings.push({ ...base, type: 'AGENT_POLICY', severity: 'info', recommendation: 'EXCLUDE_FROM_APP_KNOWLEDGE', owner: c.owner ?? consumerRepo });
      continue;
    }
    if (c.applicability === 'repo-local' && c.verification === 'SUPPORTED') {
      findings.push({ ...base, type: 'LOCAL_CONVENTION', severity: 'info', recommendation: 'KEEP_LOCAL', owner: consumerRepo });
    }
  }

  const bySkill = new Map();
  for (const c of claims) {
    if (!bySkill.has(c.skill)) bySkill.set(c.skill, []);
    bySkill.get(c.skill).push(c);
  }
  for (const [skill, group] of bySkill) {
    const sdkOwned = group.filter(c => c.knowledge_class === 'sdk-contract' && c.owner === providerRepo && c.verification === 'SUPPORTED');
    const local = group.filter(c => c.owner === consumerRepo && c.knowledge_class !== 'sdk-contract' && c.verification === 'SUPPORTED');
    if (sdkOwned.length && local.length) {
      findings.push({
        id: nextId(),
        claim_id: null,
        skill,
        statement: `Skill mixes ${sdkOwned.length} provider-owned claim(s) with ${local.length} local claim(s).`,
        evidence: [],
        confidence: 'high',
        type: 'SPLIT_CANDIDATE',
        severity: 'medium',
        recommendation: 'SPLIT',
        owner: null
      });
    }
  }

  return findings;
}
