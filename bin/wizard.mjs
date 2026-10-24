#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { profileRepository } from '../src/profile.mjs';
import { inventorySkills, auditSkillReferenceLinks } from '../src/skills.mjs';
import { inspectSkillAdapters } from '../src/skill-adapters.mjs';
import { inspectSourceConsistency, sourceConsistencyMarkdown, consistencyUpdateProposals } from '../src/source-consistency.mjs';
import { extractClaims } from '../src/claims.mjs';
import { buildEvidenceIndex, searchEvidence, findDeprecatedEvidence } from '../src/evidence.mjs';
import { readJson, writeJson, ensureDir } from '../src/fs-utils.mjs';
import { validateAnalysis, joinAnalysis } from '../src/analysis.mjs';
import { deriveFindings } from '../src/findings.mjs';
import { markdownReport } from '../src/report.mjs';
import { applyQualityGates, qualitySummary } from '../src/quality-gates.mjs';
import { createLlmClient, closeLlmClient } from '../src/llm-provider.mjs';
import { analyzeClaimsWithLlm } from '../src/semantic.mjs';
import { designSkillWithLlm, deterministicAgentQuality, renderSkillPackage } from '../src/skill-design.mjs';
import { evaluateSkillWithLlm } from '../src/agent-eval.mjs';
import { evaluatePairedAgentOutputs } from '../src/paired-agent-eval.mjs';
import { buildReviewCatalog, planHumanSelection, renderReviewMarkdown } from '../src/review-selection.mjs';
import {runReviewTui} from '../src/review-tui.mjs';
import {createLocalScan} from '../src/local-scan.mjs';
import {generateUpdateDraft,editUpdateDraft} from '../src/update-drafting.mjs';
import {stageLifecycle} from '../src/skill-lifecycle.mjs';
import {stageUpdateCandidate} from '../src/review-candidates.mjs';
import { proposeSkillReferenceRepairs } from '../src/skill-reference-proposals.mjs';
import { detectOwnershipMoves } from '../src/skill-ownership-detection.mjs';
import { proposeSkillMoveReview } from '../src/skill-move-proposals.mjs';
import { analyzeSkillScope, skillScopeMarkdown, renderScopeReviewSection } from '../src/skill-scope-hints.mjs';
import { resolveInstalledScope } from '../src/skill-install-scope.mjs';
import { proposeSkillDesignReview, renderSkillDesignDiff } from '../src/skill-design-proposals.mjs';
import { buildTriage, triageMarkdown } from '../src/triage.mjs';

function arg(name, def=null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i+1] : def;
}
function has(name) { return process.argv.includes(name); }
function positional(n) { return process.argv[2+n]; }
// Repository identities are local by default. Explicit --*-id flags override them.
function localRepoId(root) {
  return 'local/' + (path.basename(path.resolve(root)).replace(/[^A-Za-z0-9._-]/g,'-') || 'repository');
}
function fail(msg) { console.error(msg); process.exit(1); }

function progress(stage, data = {}) {
  const suffix = Object.keys(data).length ? ` ${JSON.stringify(data)}` : '';
  process.stderr.write(`[wizard] ${stage}${suffix}\n`);
}

function assertOutputOutsideSources(out, roots) {
  const resolved = path.resolve(out);
  // Canonicalize the nearest existing ancestor so a symlinked output folder
  // (or parent directory) cannot bypass the source-root write barrier.
  let ancestor = resolved;
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) fail('Cannot resolve audit output directory');
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const canonical = path.resolve(fs.realpathSync(ancestor), ...suffix);
  for (const root of roots) {
    const source = fs.realpathSync(root);
    if (canonical === source || canonical.startsWith(source + path.sep))
      fail(`Refusing to write audit output inside an inspected repository: ${canonical}`);
  }
  return canonical;
}

function assertRepoPath(label, root) {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved)) fail(`${label} path does not exist: ${resolved}`);
  if (!fs.statSync(resolved).isDirectory()) fail(`${label} path is not a directory: ${resolved}`);
  return resolved;
}

const cmd = positional(0);
const wizardVersion=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
if (['-V','-v','--version','version'].includes(cmd)) {
  console.log(wizardVersion);
  process.exit(0);
}
if (['-h','--help','help'].includes(cmd)) {
  console.log(`Wizard of Skillz ${wizardVersion}

Commands:
  wizard (no arguments)                 scan current directory locally; open TUI if terminal
  scan [repo] [--out new-directory]  local scan; L choose Copilot/Ollama in TUI; M explicit drafting
  tui <audit-output-dir> --consumer-root repo [--provider-root repo] [--move-dir /local/skills]  review; L select LLM; M draft; G/Y Apply
  stage-update <audit-output-dir> --proposal ID --consumer-root repo --from-file revised-SKILL.md  stage existing revision
  stage-action <audit-output-dir> --proposal ID --consumer-root repo [--from-file new-SKILL.md] [--destination-dir /local/skills]  stage lifecycle
  prepare-update <audit-output-dir> --proposal ID | --proposals ID,ID --consumer-root repo [--llm|--editor [command]]  draft consolidated UPDATE
  doctor [--llm-provider copilot|ollama|openai-compatible]  verify provider and list models
  probe [--llm-provider copilot|ollama|openai-compatible]   one minimal LLM round-trip
  profile <repo> [--id org/repo]
  inventory <repo> [--check-references]
  review-references <repo> [--id org/repo] [--none|--all|--select ID,ID] [--format json|md]    read-only skill link repair proposals
  detect-moves <source-root> --source-id org/repo --target-root <repo> --target-id org/repo --ownership-file <relative.json> --skills-dir <relative/path> [--none|--all|--select ID,ID] [--format json|md]
  review-move <source-root> --source-id org/repo --skill-path <relative/SKILL.md> --target-root <repo> --target-id org/repo --skills-dir <relative/path> [--reason text] [--none|--all|--select ID] [--format json|md]
  review-design <skill-design.json> --repo-root <repo> --repo-id org/repo --skills-dir <relative/path> [--none|--all|--select ID] [--format json|md|diff]
  claims <repo>
  evidence <provider> --term <text>
  analyze <consumer> --provider <provider> --llm [--checkpoint file --resume] [--out analysis.json]
  audit <consumer> --provider <provider> --analysis <existing.json> [--installed-scope auto|repo|shared] [--out dir]
  review <analysis.json> [--consumer-root dir --provider-root dir] [--out review.json]
  plan-repairs <repair-proposals.json> [--previews <repair-previews.json>] [--none|--all|--select ID,ID] [--format json|md]
  design <consumer> --claims <claims.json> --skill <skill-id> --target-owner <repo-id> --llm [--eval] [--out dir] [--review-root <repo> --skills-dir <relative/path>]
       Writes a draft under <out>/candidate/<name>/SKILL.md + optional references/
  evaluate <design.json> --llm [--out eval.json]
  eval-paired <tasks.json> --runs <runs.json> --original-skill <file> --candidate-skill <file>

LLM defaults:
  --llm-provider copilot              default; federated auth, no API key
  --llm-provider ollama               Ollama local or explicitly configured server
  --llm-provider openai-compatible    custom OpenAI-compatible endpoint
  --llm-model <name>                  required for Ollama requests; Copilot defaults to auto
  --llm-url <url>                      Ollama defaults to http://127.0.0.1:11434/v1
  --llm-reasoning <effort>            Copilot only: low|medium|high|xhigh|max

Environment:
  WIZARD_LLM_PROVIDER=copilot|ollama|openai-compatible
  WIZARD_LLM_MODEL=<name>             select a model for Ollama
  WIZARD_LLM_BASE_URL=<url>           optional Ollama or compatible server URL
  WIZARD_LLM_JSON_MODE=true|false    Ollama defaults to JSON mode
  WIZARD_OLLAMA_API_KEY=<token>       optional for gateways requiring authentication
  WIZARD_LLM_API_KEY=<token>          for other OpenAI-compatible servers
`);
  process.exit(0);
}

function llmOptions(){
  return {
    provider:arg('--llm-provider', process.env.WIZARD_LLM_PROVIDER||'copilot'),
    baseUrl:arg('--llm-url', process.env.WIZARD_LLM_BASE_URL||undefined),
    model:arg('--llm-model', process.env.WIZARD_LLM_MODEL||undefined)
  };
}
function makeLlmClient() {
  return createLlmClient({
    ...llmOptions(),
    timeoutMs: arg('--llm-timeout', undefined),
    reasoningEffort: arg('--llm-reasoning', undefined),
    progress
  });
}
const interactiveLlmFactory=options=>createLlmClient({
  ...options,
  timeoutMs:arg('--llm-timeout',undefined),
  reasoningEffort:arg('--llm-reasoning',undefined),
  progress
});

function llmMeta(client) {
  return {
    provider: client.provider ?? 'unknown',
    auth: client.auth ?? 'unknown',
    model: client.model ?? null,
    ...(client.baseUrl ? { base_url: client.baseUrl } : {})
  };
}

async function llmAnalysis({consumerRoot, providerRoot, consumerId, providerId, client}) {
  consumerRoot = assertRepoPath('consumer', consumerRoot);
  providerRoot = assertRepoPath('provider', providerRoot);
  progress('profile:start');
  const consumerProfile = profileRepository(consumerRoot, consumerId);
  const providerProfile = profileRepository(providerRoot, providerId);
  progress('profile:done', { consumer_roles: consumerProfile.roles, provider_roles: providerProfile.roles });
  progress('skills:start');
  const skills = inventorySkills(consumerRoot);
  const extracted = extractClaims(skills);
  progress('skills:done', { skills: skills.length, claims: extracted.length });
  if (has('--resume') && !arg('--checkpoint')) fail('--resume requires --checkpoint <file>');
  const result = await analyzeClaimsWithLlm({
    client,
    extractedClaims: extracted,
    consumerProfile,
    providerProfile,
    consumerRoot,
    providerRoot,
    batchSize: Number(arg('--llm-batch', 6)),
    evidencePerRepo: Number(arg('--evidence-per-repo', 5)),
    onProgress: progress,
    qualityOptions:null,
    retrievalOptions:null,
    checkpointPath: arg('--checkpoint'),
    resume: has('--resume')
  });
  return {
    consumer_repo: consumerId,
    provider_repo: providerId,
    claims: result.claims,
    _meta: {
      generated_by: 'llm',
      ...llmMeta(client),
      claims_extracted: extracted.length,
      version: wizardVersion
    }
  };
}

if (!cmd || cmd === 'scan') {
  const candidate=cmd==='scan' && positional(1) && !positional(1).startsWith('--')
    ?positional(1):process.cwd();
  const root=assertRepoPath('repository',candidate);
  let scan;
  try {scan=createLocalScan(root,{out:arg('--out')});}
  catch(e){fail('Local scan failed: '+e.message);}
  if(process.stdin.isTTY && process.stdout.isTTY && process.stdin.setRawMode){
    process.stderr.write('[wizard] Local structural scan only; no LLM, provider or semantic verification.\\n');
    try {await runReviewTui(scan.output_directory,{
      consumerRoot:root,
      moveDestinationDir:arg('--move-dir'),
      providerFactory:interactiveLlmFactory,
      initialProvider:llmOptions()
    });}
    catch(e){fail(e.message);}
    process.stderr.write('[wizard] Review artifacts: '+scan.output_directory+'\\n');
  } else {
    console.log(JSON.stringify(scan,null,2));
  }
  process.exit(0);
}

if (cmd === 'prepare-update') {
  const outputFolder=assertRepoPath('audit output',positional(1)??fail('missing audit output dir'));
  const consumerRoot=assertRepoPath('consumer',arg('--consumer-root')??fail('missing --consumer-root'));
  if(has('--proposal')===has('--proposals'))
    fail('Choose exactly one of --proposal or --proposals');
  const proposalIds=(arg('--proposals')??arg('--proposal')??'').split(',').map(x=>x.trim());
  if(proposalIds.some(x=>!x)||new Set(proposalIds).size!==proposalIds.length)
    fail('Supply unique, nonempty proposal IDs');
  if(has('--llm')===has('--editor'))
    fail('Select exactly one of --llm or --editor');
  try{
    let result;
    if(has('--editor')){
      const command=arg('--editor');
      result=editUpdateDraft(outputFolder,{
        consumerRoot,proposalIds,editor:command && !command.startsWith('--')?command:undefined
      });
    }else{
      const client=makeLlmClient();
      try{
        result=await generateUpdateDraft(outputFolder,{consumerRoot,proposalIds,client});
      }finally{await closeLlmClient(client);}
    }
    console.log(JSON.stringify(result,null,2));
  }catch(error){fail('Draft preparation failed: '+error.message);}
  process.exit(0);
}

if (cmd === 'stage-action') {
  const outputFolder=assertRepoPath('audit output',positional(1)??fail('missing audit output dir'));
  const consumerRoot=assertRepoPath('consumer',arg('--consumer-root')??fail('missing --consumer-root'));
  const proposalId=arg('--proposal')??fail('missing --proposal');
  const source=arg('--from-file');
  try{
    const result=stageLifecycle(outputFolder,{
      consumerRoot,proposalId,content:source?fs.readFileSync(source,'utf8'):null,
      destinationDir:arg('--destination-dir')
    });
    console.log(JSON.stringify(result,null,2));
  }catch(error){fail('Lifecycle stage failed: '+error.message);}
  process.exit(0);
}

if (cmd === 'stage-update') {
  const outputFolder=assertRepoPath('audit output',positional(1)??fail('missing audit output dir'));
  const consumerRoot=assertRepoPath('consumer',arg('--consumer-root')??fail('missing --consumer-root'));
  const proposalId=arg('--proposal')??fail('missing --proposal');
  const candidateFile=arg('--from-file')??fail('missing --from-file');
  try{
    const result=stageUpdateCandidate(outputFolder,{consumerRoot,proposalId,candidateFile});
    console.log(JSON.stringify(result,null,2));
  }catch(error){fail('Candidate staging failed: '+error.message);}
  process.exit(0);
}

if (cmd === 'tui') {
  const outputFolder=assertRepoPath('review output',positional(1)??fail('missing audit output dir'));
  const consumerRoot=arg('--consumer-root');
  const providerRoot=arg('--provider-root');
  try {await runReviewTui(outputFolder,{
    consumerRoot:consumerRoot?assertRepoPath('consumer',consumerRoot):null,
    providerRoot:providerRoot?assertRepoPath('provider',providerRoot):null,
    moveDestinationDir:arg('--move-dir'),
    providerFactory:interactiveLlmFactory,
    initialProvider:llmOptions()
  });} catch(e){fail(e.message);}
  process.exit(0);
}

if (cmd === 'review') {
  const file = positional(1) ?? fail('missing analysis.json');
  const input = readJson(file);
  const consumerRoot = arg('--consumer-root');
  const providerRoot = arg('--provider-root');
  const extracted = consumerRoot ? extractClaims(inventorySkills(assertRepoPath('consumer',consumerRoot))) : [];
  const inspected={consumerRoot,providerRoot,consumerRepo:input.consumer_repo,providerRepo:input.provider_repo};
  const reviewed = applyQualityGates(input, { extractedClaims:extracted,
    ...inspected });
  const summary = qualitySummary(reviewed);
  const out = arg('--out');
  if(out) writeJson(out,reviewed);
  console.log(JSON.stringify({ ...(out ? {out:path.resolve(out)} : {}), ...summary,
    repo_sources_checked:Boolean(consumerRoot && providerRoot),
    warning:!consumerRoot||!providerRoot?'Source-independent review only; check source paths before relying on evidence.':undefined
  },null,2));
  process.exit(0);
}

if (cmd === 'plan-repairs') {
  const file = positional(1) ?? fail('missing repair-proposals.json');
  const proposalSet = readJson(file);
  const previewFile = arg('--previews');
  const modes = [has('--none'),has('--all'),has('--select')].filter(Boolean).length;
  if(modes > 1)fail('Choose exactly one of --none, --all or --select ID,ID');
  const mode = has('--all')?'ALL':has('--select')?'SUBSET':'NONE';
  const chosen = mode==='SUBSET' ? String(arg('--select')??'').split(',') : [];
  const catalog = buildReviewCatalog(proposalSet,{
    previews:previewFile ? readJson(previewFile) : null
  });
  const plan = planHumanSelection(catalog,{mode,ids:chosen});
  // Purely a preview: this command never edits an inspected repository.
  const format = arg('--format','json');
  if(!['json','md'].includes(format))fail('Use --format json or --format md');
  console.log(format==='md' ? renderReviewMarkdown(catalog,plan)
    : JSON.stringify({catalog,selection:plan},null,2));
  process.exit(0);
}

if (cmd === 'review-design') {
  const file = positional(1) ?? fail('missing skill-design.json');
  const repoRoot = assertRepoPath('destination', arg('--repo-root') ?? fail('missing --repo-root'));
  const repoId = arg('--repo-id') ?? fail('missing --repo-id');
  const skillsDir = arg('--skills-dir') ?? fail('missing --skills-dir');
  const review = proposeSkillDesignReview({design:readJson(file), repoRoot, repoId, skillsDir});
  const catalog = buildReviewCatalog(review);
  const modes = [has('--none'), has('--all'), has('--select')].filter(Boolean).length;
  if (modes > 1) fail('Choose exactly one of --none, --all or --select ID');
  const mode = has('--all') ? 'ALL' : has('--select') ? 'SUBSET' : 'NONE';
  const ids = mode === 'SUBSET' ? String(arg('--select') ?? '').split(',') : [];
  const selection = planHumanSelection(catalog, {mode, ids});
  const format = arg('--format', 'json');
  if (!['json','md','diff'].includes(format)) fail('Use --format json, md or diff');
  if (format === 'diff') process.stdout.write(renderSkillDesignDiff(review));
  else console.log(format === 'md' ? renderReviewMarkdown(catalog,selection)
    : JSON.stringify({design_review:review,catalog,selection},null,2));
  process.exit(0);
}

if (cmd === 'detect-moves') {
  const sourceRoot=assertRepoPath('source',positional(1)??fail('missing source repository'));
  const targetRoot=assertRepoPath('destination',arg('--target-root')??fail('missing --target-root'));
  const sourceRepo=arg('--source-id')??fail('missing --source-id');
  const targetRepo=arg('--target-id')??fail('missing --target-id');
  const ownershipFile=arg('--ownership-file')??fail('missing --ownership-file');
  const skillsDir=arg('--skills-dir')??fail('missing --skills-dir');
  const detection=detectOwnershipMoves({
    sourceRoot,sourceRepo,targetRoot,targetRepo,ownershipFile,skillsDir
  });
  const catalog=buildReviewCatalog(detection);
  const modes=[has('--none'),has('--all'),has('--select')].filter(Boolean).length;
  if(modes>1)fail('Choose exactly one of --none, --all or --select IDs');
  const mode=has('--all')?'ALL':has('--select')?'SUBSET':'NONE';
  const ids=mode==='SUBSET'?String(arg('--select')??'').split(','):[];
  const selection=planHumanSelection(catalog,{mode,ids});
  const format=arg('--format','json');
  if(!['json','md'].includes(format))fail('Use --format json or --format md');
  console.log(format==='md'?renderReviewMarkdown(catalog,selection):
    JSON.stringify({detection,catalog,selection},null,2));
  process.exit(0);
}

if (cmd === 'review-move') {
  const sourceRoot = assertRepoPath('source', positional(1) ?? fail('missing source root'));
  const targetRoot = assertRepoPath('destination', arg('--target-root') ?? fail('missing --target-root'));
  const sourceRepo = arg('--source-id') ?? fail('missing --source-id');
  const targetRepo = arg('--target-id') ?? fail('missing --target-id');
  const sourceSkill = arg('--skill-path') ?? fail('missing --skill-path');
  const skillsDir = arg('--skills-dir') ?? fail('missing --skills-dir');
  const move_review = proposeSkillMoveReview({
    sourceRoot,sourceRepo,sourceSkill,targetRoot,targetRepo,skillsDir,
    reason:arg('--reason')
  });
  const catalog=buildReviewCatalog(move_review);
  const modes=[has('--none'),has('--all'),has('--select')].filter(Boolean).length;
  if(modes>1)fail('Choose exactly one of --none, --all or --select ID');
  const mode=has('--all')?'ALL':has('--select')?'SUBSET':'NONE';
  const ids=mode==='SUBSET'?String(arg('--select')??'').split(','):[];
  const selection=planHumanSelection(catalog,{mode,ids});
  const format=arg('--format','json');
  if(!['json','md'].includes(format))fail('Use --format json or --format md');
  console.log(format==='md'?renderReviewMarkdown(catalog,selection)
    : JSON.stringify({move_review,catalog,selection},null,2));
  process.exit(0);
}

if (cmd === 'review-references') {
  const root = assertRepoPath('repository', positional(1) ?? fail('missing repo path'));
  const repoId = arg('--id', path.basename(root));
  const skills = inventorySkills(root);
  const diagnostics = auditSkillReferenceLinks(root, skills);
  const proposals = proposeSkillReferenceRepairs({repoId, skills, audit:diagnostics});
  const catalog = buildReviewCatalog(proposals);
  const modes = [has('--none'), has('--all'), has('--select')].filter(Boolean).length;
  if (modes > 1) fail('Choose exactly one of --none, --all or --select ID,ID');
  const mode = has('--all') ? 'ALL' : has('--select') ? 'SUBSET' : 'NONE';
  const ids = mode === 'SUBSET' ? String(arg('--select') ?? '').split(',') : [];
  const selection = planHumanSelection(catalog, {mode, ids});
  const format = arg('--format', 'json');
  if (!['json', 'md'].includes(format)) fail('Use --format json or --format md');
  console.log(format === 'md' ? renderReviewMarkdown(catalog, selection)
    : JSON.stringify({reference_links:diagnostics, catalog, selection}, null, 2));
  process.exit(0);
}

// Every proposal batch starts with no items selected: this file is a
// review invitation, never an approval or authorization to change code.
function writePendingReview(out, proposals, previews, scopeHints=null) {
  const catalog=buildReviewCatalog(proposals,{previews});
  const plan=planHumanSelection(catalog);
  const base=renderReviewMarkdown(catalog,plan);
  const diagnostics=scopeHints ? renderScopeReviewSection(scopeHints) : '';
  fs.writeFileSync(path.join(out,'review-pending.md'),base+(diagnostics?'\n'+diagnostics:''));
}

if (cmd === 'doctor') {
  const client = makeLlmClient();
  try {
    if (typeof client.doctor !== 'function') {
      console.log(JSON.stringify({ok:true,...llmMeta(client),note:'Provider has no federated-auth doctor; client constructed successfully.'},null,2));
    } else {
      console.log(JSON.stringify(await client.doctor(), null, 2));
    }
  } finally {
    await closeLlmClient(client);
  }
  process.exit(0);
}

if (cmd === 'probe') {
  const client = makeLlmClient();
  try {
    progress('probe:start', llmMeta(client));
    const result = await client.completeJson({
      system: 'You are a connectivity probe. Return JSON only.',
      user: 'Return exactly this JSON object: {"ping":"pong"}'
    });
    progress('probe:done');
    console.log(JSON.stringify({ok:true,...llmMeta(client),result}, null, 2));
  } finally {
    await closeLlmClient(client);
  }
  process.exit(0);
}

if (cmd === 'profile') {
  const root = assertRepoPath('repository',positional(1) ?? fail('missing repo path'));
  console.log(JSON.stringify(profileRepository(root, arg('--id', path.basename(path.resolve(root)))), null, 2));
  process.exit(0);
}
if (cmd === 'inventory') {
  const root = assertRepoPath('repository',positional(1) ?? fail('missing repo path'));
  const skills=inventorySkills(root);
  const inv=skills.map(({text,...x})=>x);
  console.log(JSON.stringify(has('--check-references')?
    {skills:inv,reference_links:auditSkillReferenceLinks(root,skills)}:inv,null,2));
  process.exit(0);
}
if (cmd === 'claims') {
  const root = assertRepoPath('repository',positional(1) ?? fail('missing repo path'));
  console.log(JSON.stringify(extractClaims(inventorySkills(root)), null, 2));
  process.exit(0);
}
if (cmd === 'evidence') {
  const root = positional(1) ?? fail('missing provider path');
  const term = arg('--term') ?? fail('missing --term');
  const idx = buildEvidenceIndex(root);
  console.log(JSON.stringify({ hits: searchEvidence(idx,[term]), deprecated: findDeprecatedEvidence(idx,term) }, null, 2));
  process.exit(0);
}
if (cmd === 'analyze') {
  const consumerRoot = positional(1) ?? fail('missing consumer path');
  const providerRoot = arg('--provider') ?? fail('missing --provider');
  if (!has('--llm')) fail('analyze currently requires --llm');
  const consumerId = arg('--consumer-id',localRepoId(consumerRoot));
  const providerId = arg('--provider-id',localRepoId(providerRoot));
  const client = makeLlmClient();
  try {
    const analysis = await llmAnalysis({consumerRoot,providerRoot,consumerId,providerId,client});
    const out = arg('--out');
    if (out) { writeJson(out, analysis); console.log(JSON.stringify({out:path.resolve(out),claims:analysis.claims.length,...llmMeta(client)},null,2)); }
    else console.log(JSON.stringify(analysis,null,2));
  } finally {
    await closeLlmClient(client);
  }
  process.exit(0);
}

if (cmd === 'design') {
  const consumerRoot = assertRepoPath('consumer',positional(1) ?? fail('missing consumer path'));
  const claimsPath = arg('--claims') ?? fail('missing --claims <claims.json>');
  const skillId = arg('--skill') ?? fail('missing --skill <skill-id>');
  if (!has('--llm')) fail('design currently requires --llm');
  const out = arg('--out', '.wizard/design');
  const reviewRootFlag = arg('--review-root');
  const skillsDir = arg('--skills-dir');
  if (Boolean(reviewRootFlag) !== Boolean(skillsDir))
    fail('Use --review-root and --skills-dir together for a design review');
  if (reviewRootFlag && !has('--target-owner'))
    fail('Design review requires explicit --target-owner');
  const reviewRoot = reviewRootFlag ? assertRepoPath('review destination',reviewRootFlag) : null;
  const protectedRoots = reviewRoot ? [consumerRoot,reviewRoot] : [consumerRoot];
  assertOutputOutsideSources(out,protectedRoots);
  const claims = readJson(claimsPath).filter(c => c.skill === skillId);
  if (!claims.length) fail(`no claims found for skill ${skillId}`);
  const sourceSkill = inventorySkills(consumerRoot).find(s => s.id === skillId) ?? null;
  const targetOwner = arg('--target-owner', arg('--consumer-id',localRepoId(consumerRoot)));
  const client = makeLlmClient();
  try {
    const design = await designSkillWithLlm({client, skillId, claims, targetOwner, sourceSkill});
    const quality = deterministicAgentQuality(design);
    const candidate = design.decision==='SKILL' ? renderSkillPackage(design) : null;
    const packageDir = candidate && path.join(out,'candidate',candidate.name);
    const review = reviewRoot ? proposeSkillDesignReview({
      design,repoRoot:reviewRoot,repoId:targetOwner,skillsDir
    }) : null;
    if (packageDir) {
      assertOutputOutsideSources(packageDir,protectedRoots);
      if (fs.existsSync(packageDir))
        fail('Refusing to overwrite an existing skill draft package: '+packageDir);
      assertOutputOutsideSources(path.join(out,'SKILL.candidate.md'),protectedRoots);
    }
    ensureDir(out);
    writeJson(path.join(out,'skill-design.json'), design);
    writeJson(path.join(out,'agent-quality-deterministic.json'), quality);
    let semanticEval = null;
    if (candidate) {
      // A complete Agent Skills draft lives under candidate/<name>/;
      // keep the established standalone preview for older consumers.
      for (const file of candidate.files) {
        const destination=path.join(packageDir,file.path);
        assertOutputOutsideSources(destination,protectedRoots);
        fs.mkdirSync(path.dirname(destination),{recursive:true});
        fs.writeFileSync(destination,file.content,{flag:'wx'});
      }
      fs.writeFileSync(path.join(out,'SKILL.candidate.md'),candidate.files[0].content);
      if (has('--eval')) {
        semanticEval = await evaluateSkillWithLlm({client, design});
        writeJson(path.join(out,'agent-quality.json'), semanticEval);
      }
    }
    if (review) {
      const catalog = buildReviewCatalog(review);
      const selection = planHumanSelection(catalog); // NONE, never inferred approval
      writeJson(path.join(out,'design-review.json'),{design_review:review,catalog,selection});
      fs.writeFileSync(path.join(out,'design-review.diff'),renderSkillDesignDiff(review));
      fs.writeFileSync(path.join(out,'review-pending.md'),renderReviewMarkdown(catalog,selection));
    }
    console.log(JSON.stringify({out:path.resolve(out),skill:skillId,decision:design.decision,eligible_claims:design._meta.eligible_claims,issues:quality.issues.length,semantic_eval:Boolean(semanticEval),...(review ? {review_proposals:review.proposals.length,review_only:true} : {}),...llmMeta(client)},null,2));
  } finally {
    await closeLlmClient(client);
  }
  process.exit(0);
}
if (cmd === 'eval-paired') {
  const tasksFile=positional(1) ?? fail('missing tasks.json');
  const runsFile=arg('--runs') ?? fail('missing --runs');
  const originalFile=arg('--original-skill') ?? fail('missing --original-skill');
  const candidateFile=arg('--candidate-skill') ?? fail('missing --candidate-skill');
  const manifestBytes=fs.readFileSync(tasksFile,'utf8');
  const report=evaluatePairedAgentOutputs({
    manifest:JSON.parse(manifestBytes),manifestBytes,
    originalSkillBytes:fs.readFileSync(originalFile,'utf8'),
    candidateSkillBytes:fs.readFileSync(candidateFile,'utf8'),
    artifact:readJson(runsFile)
  });
  // STDOUT only: raw run output could contain proprietary or secret content.
  console.log(JSON.stringify(report,null,2));
  process.exit(0);
}

if (cmd === 'evaluate') {
  const designPath = positional(1) ?? fail('missing design json path');
  const design = readJson(designPath);
  let result = {deterministic: deterministicAgentQuality(design)};
  let client = null;
  try {
    if (has('--llm')) {
      client = makeLlmClient();
      result = await evaluateSkillWithLlm({client, design});
    }
    const out = arg('--out');
    if (out) { writeJson(out,result); console.log(JSON.stringify({out:path.resolve(out),...(client?llmMeta(client):{})},null,2)); }
    else console.log(JSON.stringify(result,null,2));
  } finally {
    await closeLlmClient(client);
  }
  process.exit(0);
}

if (cmd === 'audit') {
  const consumerRoot = assertRepoPath('consumer',positional(1) ?? fail('missing consumer path'));
  const providerRoot = assertRepoPath('provider',arg('--provider') ?? fail('missing --provider'));
  const out = arg('--out', '.wizard');
  assertOutputOutsideSources(out,[consumerRoot,providerRoot]);
  const consumerId = arg('--consumer-id',localRepoId(consumerRoot));
  const providerId = arg('--provider-id',localRepoId(providerRoot));
  // Auto recognizes only exact user-level skill installation roots.
  // An inspected checkout's .agents/skills remains repository-local.
  const install = resolveInstalledScope(consumerRoot,{
    requested:arg('--installed-scope','auto')
  });
  const installedScope = install.scope;

  const consumerProfile = profileRepository(consumerRoot, consumerId);
  const providerProfile = profileRepository(providerRoot, providerId);
  const skills = inventorySkills(consumerRoot);
  const extracted = extractClaims(skills);

  let analysis;
  let client = null;
  try {
    if (has('--llm')) {
      client = makeLlmClient();
      analysis = await llmAnalysis({consumerRoot,providerRoot,consumerId,providerId,client});
    } else {
      const analysisPath = arg('--analysis') ?? fail('use either --llm or --analysis <analysis.json>');
      analysis = readJson(analysisPath);
      const errors = validateAnalysis(analysis, { consumerRoot, providerRoot });
      if (errors.length) fail(`analysis validation failed:\n- ${errors.join('\n- ')}`);
    }
    analysis = applyQualityGates(analysis, {extractedClaims:extracted,consumerRoot,providerRoot,
      consumerRepo:consumerId,providerRepo:providerId});

    const claims = joinAnalysis(extracted, analysis);
    const adapterReport = inspectSkillAdapters(skills);
    const sourceChecks = inspectSourceConsistency(consumerRoot,skills);
    const findings = deriveFindings(claims, { consumerRepo: consumerId, providerRepo: providerId });
    const scopeHints = analyzeSkillScope({skills,claims,consumerRepo:consumerId,providerRepo:providerId,installedScope,installedScopeBasis:install.basis});
    // The generic audit reports evidence and manual-only proposals;
    // it never fabricates ready-to-apply mechanical patches.
    const legacyRepairs = {
      schema_version:1,generated_by:'generic-source-review',read_only:true,
      consumer_repo:consumerId,provider_repo:providerId,proposals:[],checks:{}
    };
    const sourceReview = consistencyUpdateProposals(sourceChecks,consumerId);
    const repairs = {...legacyRepairs,proposals:[...legacyRepairs.proposals,...sourceReview.proposals]};
    const previews = {schema_version:1,consumer_repo:consumerId,provider_repo:providerId,previews:[],ready_count:0};
    const triage = buildTriage({analysis,findings,repairProposals:legacyRepairs});

    ensureDir(out);
    writeJson(path.join(out,'consumer-profile.json'), consumerProfile);
    writeJson(path.join(out,'provider-profile.json'), providerProfile);
    writeJson(path.join(out,'skill-inventory.json'), skills.map(({text,...x}) => x));
    writeJson(path.join(out,'skill-adapters.json'), adapterReport);
    writeJson(path.join(out,'source-consistency.json'), sourceChecks);
    fs.writeFileSync(path.join(out,'source-consistency.md'),sourceConsistencyMarkdown(sourceChecks));
    writeJson(path.join(out,'skill-reference-links.json'),auditSkillReferenceLinks(consumerRoot,skills));
    writeJson(path.join(out,'analysis.json'), analysis);
    writeJson(path.join(out,'claims.json'), claims);
    writeJson(path.join(out,'quality-summary.json'), qualitySummary(analysis));
    writeJson(path.join(out,'source-contracts.json'), analysis.source_contracts);
    writeJson(path.join(out,'findings.json'), findings);
    writeJson(path.join(out,'scope-hints.json'), scopeHints);
    fs.writeFileSync(path.join(out,'scope-hints.md'),skillScopeMarkdown(scopeHints));
    writeJson(path.join(out,'repair-proposals.json'), repairs);
    fs.writeFileSync(path.join(out,'repair-proposals.md'),renderReviewMarkdown(buildReviewCatalog(repairs),planHumanSelection(buildReviewCatalog(repairs))));
    writeJson(path.join(out,'repair-previews.json'),previews);
    fs.writeFileSync(path.join(out,'repair-previews.diff'),'# No auto-applied patches. Review and prepare explicit candidates.\n');
    writePendingReview(out,repairs,previews,scopeHints);
    if(sourceChecks.observations.length){
      const reviewFile=path.join(out,'review-pending.md');
      fs.appendFileSync(reviewFile,'\n## Controlli di coerenza sorgenti — non selezionabili\n\n'+
        'Trovati '+sourceChecks.observations.length+' casi da verificare manualmente. '+
        'Dettagli ed evidenze: [source-consistency.md](source-consistency.md). '+
        'Non sono diff né autorizzazioni a modificare skill.\n');
    }
    writeJson(path.join(out,'triage-summary.json'),triage);
    fs.writeFileSync(path.join(out,'triage.md'),triageMarkdown(triage));
    fs.writeFileSync(path.join(out,'report.md'),triageMarkdown(triage));
    fs.writeFileSync(path.join(out,'report-detailed.md'), markdownReport({ consumerProfile, providerProfile, skills, claims, findings }));
    console.log(JSON.stringify({ out: path.resolve(out), mode:has('--llm')?'llm':'analysis-file', skills: skills.length, claims: claims.length, findings: findings.length, quality:qualitySummary(analysis),repair_candidates:repairs.proposals.length,scope_hints:scopeHints.hints.length,source_consistency:sourceChecks.observations.length,thin_adapters:adapterReport.summary.valid,installed_scope:install.scope,scope_basis:install.basis,triage:triage.headline, ...(client?llmMeta(client):{}) }, null, 2));
  } finally {
    await closeLlmClient(client);
  }
  process.exit(0);
}

fail(`unknown command: ${cmd}`);
