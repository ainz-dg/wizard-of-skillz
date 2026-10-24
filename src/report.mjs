export function markdownReport({ consumerProfile, providerProfile, skills, claims, findings }) {
  const counts = (arr, key) => arr.reduce((m,x) => (m[x[key]]=(m[x[key]]||0)+1,m),{});
  const lines = [];
  lines.push('# Wizard-of-Oz 0.4.5 knowledge audit report','');
  lines.push(`- Consumer: \`${consumerProfile.repository.id}\``);
  lines.push(`- Provider: \`${providerProfile.repository.id}\``);
  lines.push(`- Existing skills: **${skills.length}**`);
  lines.push(`- Extracted claims: **${claims.length}**`);
  lines.push(`- Findings: **${findings.length}**`,'');
  lines.push('## Verification states','');
  for (const [k,v] of Object.entries(counts(claims,'verification')).sort()) lines.push(`- ${k}: ${v}`);
  lines.push('','## Evidence-quality states','');
  for (const [k,v] of Object.entries(counts(claims,'evidence_quality')).sort()) lines.push(`- ${k}: ${v}`);
  lines.push('','## Verification basis','');
  for (const [k,v] of Object.entries(counts(claims,'verification_basis')).sort()) lines.push(`- ${k}: ${v}`);
  lines.push('','## Review policy','',
    'A valid evidence path or matching symbol is **not semantic proof**. CITATION_ONLY claims remain hypotheses about meaning. Only narrowly checked source rules are DETERMINISTIC_PROOF.',
    'All **REVIEW_REQUIRED** findings are hypotheses, not proven defects. No repository files were modified.','', '## Findings','');
  for (const f of findings) {
    lines.push(`### ${f.id} — ${f.type}`,'');
    lines.push(`**Skill:** \`${f.skill}\`  `);
    lines.push(`**Severity:** ${f.severity}  `);
    lines.push(`**Recommendation:** ${f.recommendation}  `);
    lines.push(`**Claim:** ${f.statement}`,'');
    if (f.evidence?.length) {
      lines.push('Evidence:');
      for (const e of f.evidence) lines.push(`- \`${e.repo}:${e.path}${e.symbol ? `#${e.symbol}` : ''}\`${e.note ? ` — ${e.note}` : ''}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
