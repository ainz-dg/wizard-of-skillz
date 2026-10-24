/** Separate action-oriented findings from the complete claim/policy inventory. */
export function buildTriage({analysis,findings=[],repairProposals}={}) {
  const claims=analysis?.claims||[];
  const defects=repairProposals?.proposals||[];
  const countBy=field=>claims.reduce((acc,c)=>{const x=c[field]||'unknown';acc[x]=(acc[x]||0)+1;return acc;},{});
  const policyInventory=claims.filter(c=>c.knowledge_class==='agent-policy');
  const fragments=claims.filter(c=>c.extraction_form==='INCOMPLETE_LEAD_IN' || /:\s*$/.test(c.claim_text||''));
  const localDeclarations=claims.filter(c=>c.applicability==='repo-local' && c.knowledge_class==='agent-policy');
  const reviewCandidates=claims.filter(c=>c.verification==='NEEDS_REVIEW' && c.knowledge_class!=='agent-policy' && !/legacy_local_only/i.test((c.review_flags||[]).join(' ')));
  return {schema_version:1,
    headline:{confirmed_source_drift:defects.length,unresolved_nonpolicy_claims:reviewCandidates.length,
      incomplete_fragments:fragments.length,agent_policy_inventory:policyInventory.length},
    verification:countBy('verification'),
    recommendation:'Review the source-backed repair proposals first. Do not interpret NEEDS_REVIEW, NOT_FOUND or a local policy as a defect.',
    priority_proposals:defects.map(p=>({id:p.id,priority:p.priority,skill:p.skill,title:p.title,evidence_files:p.evidence.map(e=>e.path)})),
    review_queue:reviewCandidates.map(c=>({claim_id:c.claim_id,skill:c.claim_id?.split(':')[0],reason:c.reason||null,review_flags:c.review_flags||[]})),
    inventory:{policy_claims:policyInventory.length,local_policy_declarations:localDeclarations.length,
      incomplete_fragments:fragments.map(c=>({id:c.claim_id,statement:c.claim_text})),
      full_findings:findings.length},
    read_only:true};
}
export function triageMarkdown(triage) {
  const a=triage.headline;
  const lines=['# Wizard Knowledge Audit — Triage','',
    `- Source-backed repair candidates: **${a.confirmed_source_drift}**`,
    `- Other non-policy review hypotheses: **${a.unresolved_nonpolicy_claims}**`,
    `- Incomplete lead-in claims excluded from repairs: **${a.incomplete_fragments}**`,
    `- Agent-policy claims retained separately: **${a.agent_policy_inventory}**`,'',
    '## Prioritized repair queue',''];
  if(!triage.priority_proposals.length) lines.push('No source-backed repair candidate found.','');
  else for(const p of triage.priority_proposals)lines.push(`- **${p.priority}** \`${p.id}\` — ${p.title} (\`${p.skill}\`)`);
  lines.push('','## Interpretation','',triage.recommendation,'',
    'See `repair-proposals.md` for source references and review steps, `triage-summary.json` for secondary hypotheses, and `findings.json` for the full raw inventory.','');
  return lines.join('\n');
}
