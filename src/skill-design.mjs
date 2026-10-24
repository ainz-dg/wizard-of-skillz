const INVOCATIONS = new Set(['model','user']);
const CONFIDENCE = new Set(['low','medium','high']);

export const WRITING_FOR_AGENTS_SYSTEM_PROMPT = `You are the Skill Design stage of Wizard of Skillz.
Your job is to turn VERIFIED software knowledge into a skill design for a coding agent.

The design rules below are derived from Matt Pocock's writing-for-agents and skill-mechanics guidance supplied to this project. Treat them as agent-document design guidance, not as software-domain truth.

Principles:
- A skill should make the agent follow a predictable PROCESS, not force identical output.
- The skill description is a context pointer. It should state what the skill is and the distinct trigger branches that should cause invocation. Avoid duplicate synonyms for the same branch.
- Distinguish steps from reference. Put ordered actions in steps; facts/rules belong in reference.
- Every step should have a clear, checkable completion criterion. Prefer exhaustive criteria where feasible.
- Use progressive disclosure: keep material needed on every branch in the main skill, and put branch-specific or bulky reference behind explicit pointers.
- Only create a disclosed reference when a validated claim-backed rule belongs there. Each disclosed rule must appear in exactly one named reference file. Use a safe, unique flat .md filename such as api.md. Don't create empty reference files or split merely because a skill is long.
- Co-locate a concept's definition, rules and caveats.
- Prune duplication. The environment (scripts, config, directory layout, --help, types) is already a source of truth; do not cache cheap lookups in the skill unless the lookup is expensive or the skill adds an unwritten convention/gotcha/reason.
- Prefer positive target behavior. Use prohibitions only for hard guardrails and pair them with what to do instead.
- Avoid sprawl. Split only when the sequence or invocation cut earns the extra cognitive/context load.
- Model-invoked skills pay permanent context load through their description; choose model invocation only when autonomous discovery is needed. Otherwise prefer user invocation.
- Leading words and no-op detection are model-relative optimization techniques. Do not claim them as proven unless eval evidence is supplied.

Use ONLY the verified claims provided. Do not invent SDK/application rules.
First decide whether the verified claims actually deserve a skill. A skill is justified when the knowledge encodes a recurring, non-obvious, multi-step or high-risk process that benefits from agent guidance. A single cheap lookup or isolated fact should usually be NO_SKILL and remain reference/environment knowledge.

Return ONLY JSON with this shape:
{
  "decision": "SKILL|NO_SKILL",
  "decision_reason": "brief skill-worthiness rationale",
  "skill": {
    "name": "kebab-case",
    "invocation": "model|user",
    "description": "one concise context pointer",
    "trigger_branches": ["distinct trigger branch"],
    "steps": [
      {
        "id": "step-id",
        "instruction": "positive imperative",
        "completion_criterion": "checkable done condition",
        "claim_ids": ["verified claim id"]
      }
    ],
    "reference": [
      {"claim_id":"...","rule":"concise reference rule","placement":"inline|disclosed","reason":"why this placement"}
    ],
    "disclosed_references": [
      {"name":"file-name.md","pointer":"when to read it","claim_ids":["..."]}
    ]
  },
  "rationale": {
    "invocation": "...",
    "pruned_as_environment_cache": ["item"],
    "not_promoted": ["claim id or note"]
  }
}
If decision is NO_SKILL, set "skill": null and explain what should hold the knowledge instead in decision_reason/rationale.`;

// agentskills.io: canonical directory name is 1-64 chars, lowercase ASCII
// letters/digits and single internal hyphens; no leading/trailing hyphens.
const SKILL_NAME=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_NAME_LIMIT=64;
const SKILL_DESCRIPTION_LIMIT=1024;
// Reference files are deliberately one level under references/.
// Names cannot traverse directories or shadow SKILL.md.
const REFERENCE_NAME=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.md$/;
function cleanString(x) { return typeof x === 'string' ? x.trim() : ''; }
function listStrings(x) { return Array.isArray(x) ? x.map(cleanString).filter(Boolean) : []; }

export function validateSkillDesign(design, verifiedClaimIds = new Set()) {
  const errors = [];
  if (!['SKILL','NO_SKILL'].includes(design?.decision)) errors.push(`invalid decision: ${design?.decision}`);
  if (design?.decision === 'NO_SKILL') {
    if (design.skill !== null) errors.push('NO_SKILL decision must set skill to null');
    if (!cleanString(design.decision_reason)) errors.push('NO_SKILL requires decision_reason');
    return errors;
  }
  const s = design?.skill;
  if (!s || typeof s !== 'object') return [...errors,'missing skill object'];
  if (!SKILL_NAME.test(cleanString(s.name)) || cleanString(s.name).length > SKILL_NAME_LIMIT ||
      s.name !== cleanString(s.name))
    errors.push('skill.name must be 1-64 lowercase letters/digits with single internal hyphens');
  if (!cleanString(s.description) || typeof s.description !== 'string' ||
      s.description !== cleanString(s.description) || s.description.length > SKILL_DESCRIPTION_LIMIT)
    errors.push('skill.description must be 1-1024 non-whitespace characters');
  if (!INVOCATIONS.has(s.invocation)) errors.push(`invalid invocation: ${s.invocation}`);
  // Required description length is checked above, independent of quality.
  if (!Array.isArray(s.trigger_branches) || s.trigger_branches.length === 0) errors.push('at least one trigger branch is required');
  if (!Array.isArray(s.steps) || s.steps.length === 0) errors.push('at least one step is required');

  for (const [i, step] of (s.steps ?? []).entries()) {
    if (!cleanString(step.instruction)) errors.push(`step ${i+1}: missing instruction`);
    if (!cleanString(step.completion_criterion)) errors.push(`step ${i+1}: missing completion criterion`);
    for (const id of listStrings(step.claim_ids)) {
      if (verifiedClaimIds.size && !verifiedClaimIds.has(id)) errors.push(`step ${i+1}: unknown/unverified claim ${id}`);
    }
  }
  const sourceRefs = Array.isArray(s.reference) ? s.reference : [];
  const disclosedFiles = Array.isArray(s.disclosed_references) ? s.disclosed_references : [];
  if (s.reference !== undefined && !Array.isArray(s.reference)) errors.push('reference must be an array');
  if (s.disclosed_references !== undefined && !Array.isArray(s.disclosed_references))
    errors.push('disclosed_references must be an array');

  for (const [i, ref] of sourceRefs.entries()) {
    if (!cleanString(ref?.claim_id)) errors.push(`reference ${i+1}: missing claim_id`);
    else if (verifiedClaimIds.size && !verifiedClaimIds.has(ref.claim_id))
      errors.push(`reference ${i+1}: unknown/unverified claim ${ref.claim_id}`);
    if (!['inline','disclosed'].includes(ref?.placement))
      errors.push(`reference ${i+1}: invalid placement ${ref?.placement}`);
    if (!cleanString(ref?.rule))
      errors.push(`reference ${i+1}: missing rule content`);
  }

  const names = new Set(), owners = new Map();
  for (const [i, ref] of disclosedFiles.entries()) {
    const name = cleanString(ref?.name);
    if (!REFERENCE_NAME.test(name) || name.toLowerCase()==='skill.md' || name!==ref?.name)
      errors.push(`disclosed reference ${i+1}: unsafe filename (use a single .md filename)`);
    if (names.has(name.toLowerCase()))
      errors.push(`disclosed reference ${i+1}: duplicate filename ${name}`);
    names.add(name.toLowerCase());
    if (!cleanString(ref?.pointer) || /[\r\n]/.test(ref.pointer))
      errors.push(`disclosed reference ${i+1}: missing or multiline context pointer`);
    if (!Array.isArray(ref?.claim_ids) || !ref.claim_ids.length ||
        ref.claim_ids.some(id=>!cleanString(id)) ||
        new Set(ref.claim_ids).size!==ref.claim_ids.length)
      errors.push(`disclosed reference ${i+1}: require unique claim_ids`);
    for (const id of Array.isArray(ref?.claim_ids)?ref.claim_ids:[]) {
      if (verifiedClaimIds.size && !verifiedClaimIds.has(id))
        errors.push(`disclosed reference ${i+1}: unknown/unverified claim ${id}`);
      if (owners.has(id)) errors.push(`disclosed reference ${i+1}: claim ${id} assigned to multiple files`);
      owners.set(id,name);
      if (!sourceRefs.some(r=>r.placement==='disclosed' && r.claim_id===id && cleanString(r.rule)))
        errors.push(`disclosed reference ${i+1}: no rule content for claim ${id}`);
    }
  }
  for (const ref of sourceRefs.filter(r=>r.placement==='disclosed')) {
    if (!owners.has(ref.claim_id))
      errors.push(`disclosed rule ${ref.claim_id} has no reference file`);
  }
  return errors;
}

export function deterministicAgentQuality(design) {
  if (design?.decision === 'NO_SKILL') return {checks:{skill_created:false},issues:[]};
  const s = design?.skill ?? {};
  const steps = Array.isArray(s.steps) ? s.steps : [];
  const refs = Array.isArray(s.reference) ? s.reference : [];
  const branches = listStrings(s.trigger_branches);
  const issues = [];

  const desc = cleanString(s.description);
  if (!desc) issues.push({type:'WEAK_CONTEXT_POINTER', severity:'high', detail:'Missing skill description/context pointer.'});
  if (desc.length > 280) issues.push({type:'CONTEXT_POINTER_SPRAWL', severity:'medium', detail:'Description is unusually long for always-loaded invocation text.'});

  const normalizedBranches = branches.map(x => x.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim());
  if (new Set(normalizedBranches).size !== normalizedBranches.length) {
    issues.push({type:'DUPLICATE_TRIGGER_BRANCH', severity:'medium', detail:'Trigger branches contain duplicates after normalization.'});
  }

  for (const [i, step] of steps.entries()) {
    if (!cleanString(step.completion_criterion)) issues.push({type:'MISSING_COMPLETION_CRITERION', severity:'high', detail:`Step ${i+1} has no completion criterion.`});
    const inst = cleanString(step.instruction);
    if (/^(do not|don't|never|must not)\b/i.test(inst)) {
      issues.push({type:'NEGATION_FIRST_INSTRUCTION', severity:'low', detail:`Step ${i+1} begins with a prohibition rather than target behavior.`});
    }
  }

  const claimUse = new Map();
  const touch = (id, where) => {
    if (!id) return;
    if (!claimUse.has(id)) claimUse.set(id, []);
    claimUse.get(id).push(where);
  };
  steps.forEach((x,i) => listStrings(x.claim_ids).forEach(id => touch(id,`step:${i+1}`)));
  refs.forEach((x,i) => touch(cleanString(x.claim_id),`reference:${i+1}`));
  (s.disclosed_references ?? []).forEach((x,i) => listStrings(x.claim_ids).forEach(id => touch(id,`disclosed:${i+1}`)));
  for (const [id, places] of claimUse) {
    if (places.length > 2) issues.push({type:'POSSIBLE_DUPLICATED_MEANING', severity:'low', detail:`Claim ${id} is represented in ${places.length} locations: ${places.join(', ')}.`});
  }

  return {
    checks: {
      has_context_pointer: Boolean(desc),
      trigger_branch_count: branches.length,
      step_count: steps.length,
      steps_with_completion_criteria: steps.filter(x => cleanString(x.completion_criterion)).length,
      disclosed_reference_count: Array.isArray(s.disclosed_references) ? s.disclosed_references.length : 0
    },
    issues
  };
}

export function renderSkillMarkdown(design) {
  if (design?.decision === 'NO_SKILL') throw new Error('cannot render SKILL.md for NO_SKILL decision');
  const errors=validateSkillDesign(design);
  if(errors.length)throw new Error('Cannot render invalid Agent Skills candidate: '+errors.join('; '));
  const s = design.skill;
  const lines = ['---', `name: ${s.name}`];
  if (s.invocation === 'user') {
    lines.push('disable-model-invocation: true');
    if (s.description) lines.push(`description: ${JSON.stringify(s.description)}`);
  } else {
    lines.push(`description: ${JSON.stringify(s.description)}`);
  }
  lines.push('---','');

  if (s.trigger_branches?.length) {
    lines.push('## When to use','');
    for (const b of s.trigger_branches) lines.push(`- ${b}`);
    lines.push('');
  }

  lines.push('## Process','');
  for (const [i, step] of (s.steps ?? []).entries()) {
    lines.push(`### ${i+1}. ${step.instruction}`,'');
    lines.push(`**Done when:** ${step.completion_criterion}`,'');
  }

  const inlineRefs = (s.reference ?? []).filter(x => x.placement === 'inline');
  if (inlineRefs.length) {
    lines.push('## Reference','');
    for (const r of inlineRefs) lines.push(`- ${r.rule}`);
    lines.push('');
  }

  const disclosed = s.disclosed_references ?? [];
  if (disclosed.length) {
    lines.push('## References','');
    for (const r of disclosed) lines.push(`- Read [\`${r.name}\`](references/${r.name}) ${r.pointer}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Render a portable Agent Skills draft, not install it.
 * Reference content comes exclusively from explicit disclosed design rules.
 */
export function renderSkillPackage(design) {
  const main=renderSkillMarkdown(design); // includes full validation
  const refs=design.skill.disclosed_references ?? [];
  const rules=design.skill.reference ?? [];
  const files=[{path:'SKILL.md',content:main}];
  for (const ref of refs) {
    const matched=rules.filter(rule=>rule.placement==='disclosed' &&
      ref.claim_ids.includes(rule.claim_id));
    const heading=ref.name.slice(0,-3).replace(/[-_]/g,' ');
    const content=['# '+heading,'',...matched.map(rule=>'- '+rule.rule.trim()),''].join('\n');
    files.push({path:'references/'+ref.name,content});
  }
  return {name:design.skill.name,files};
}

export async function designSkillWithLlm({ client, skillId, claims, targetOwner = null, sourceSkill = null, systemPrompt = WRITING_FOR_AGENTS_SYSTEM_PROMPT }) {
  const verified = claims.filter(c => c.verification === 'SUPPORTED');
  const eligible = targetOwner ? verified.filter(c => c.owner === targetOwner) : verified;
  const user = JSON.stringify({
    target_skill: skillId,
    target_owner: targetOwner,
    current_description: sourceSkill?.description ?? null,
    verified_claims: eligible.map(c => ({
      id:c.id,
      statement:c.statement,
      verification:c.verification,
      knowledge_class:c.knowledge_class,
      owner:c.owner,
      confidence:c.confidence,
      evidence:c.evidence ?? []
    }))
  });
  const result = await client.completeJson({system:systemPrompt,user});
  const errors = validateSkillDesign(result, new Set(eligible.map(c => c.id)));
  if (errors.length) throw new Error(`invalid skill design:\n- ${errors.join('\n- ')}`);
  return {
    ...result,
    _meta: {
      generated_by: 'llm',
      provider: client.provider ?? 'unknown',
      auth: client.auth ?? 'unknown',
      model: client.model,
      source_skill: skillId,
      target_owner: targetOwner,
      eligible_claims: eligible.length,
      design_guidance: 'mattpocock/skills writing-for-agents + skill-mechanics (source-derived)'
    }
  };
}
