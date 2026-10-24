import { deterministicAgentQuality } from './skill-design.mjs';

export const AGENT_QUALITY_SYSTEM_PROMPT = `You evaluate a coding-agent skill design.
Use only the supplied skill and the following source-derived criteria from writing-for-agents / skill-mechanics:
- context pointer quality and distinct trigger branches;
- information hierarchy: steps vs reference;
- checkable, demanding completion criteria;
- progressive disclosure for branch-specific/bulky material;
- co-location of definition/rules/caveats;
- sprawl avoidance;
- single source of truth and avoidance of environment caches;
- positive target behavior over unnecessary negation;
- invocation choice: model-invoked only when autonomous/skill-to-skill discovery earns permanent context load;
- leading words and no-op instructions are model-relative; report them only as eval hypotheses, not facts.

Do not judge software-domain correctness; that belongs to the knowledge audit.
Return ONLY JSON:
{
 "scores":{"invocation":0,"hierarchy":0,"completion":0,"disclosure":0,"pruning":0},
 "issues":[{"type":"...","severity":"low|medium|high","detail":"...","source_principle":"..."}],
 "eval_hypotheses":["behavior to A/B test with agents"],
 "summary":"..."
}
Scores are integers 0..2: 0 poor, 1 mixed, 2 strong.`;

export function validateAgentEval(value) {
  const errors = [];
  const dims = ['invocation','hierarchy','completion','disclosure','pruning'];
  for (const d of dims) {
    const v = value?.scores?.[d];
    if (!Number.isInteger(v) || v < 0 || v > 2) errors.push(`invalid score ${d}: ${v}`);
  }
  if (!Array.isArray(value?.issues)) errors.push('issues must be an array');
  if (!Array.isArray(value?.eval_hypotheses)) errors.push('eval_hypotheses must be an array');
  return errors;
}

export async function evaluateSkillWithLlm({client, design, systemPrompt=AGENT_QUALITY_SYSTEM_PROMPT}) {
  const result = await client.completeJson({system:systemPrompt,user:JSON.stringify({skill:design.skill})});
  const errors = validateAgentEval(result);
  if (errors.length) throw new Error(`invalid agent eval:\n- ${errors.join('\n- ')}`);
  return { deterministic: deterministicAgentQuality(design), semantic: result, _meta:{generated_by:'llm',provider:client.provider ?? 'unknown',auth:client.auth ?? 'unknown',model:client.model} };
}
