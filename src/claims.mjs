import { createHash } from 'node:crypto';
import { thinAdapterTarget } from './skill-adapters.mjs';

const CUES = /\b(must|should|use|uses|always|never|do not|don't|cannot|can't|required|requires|must not|is the|are the|belongs|extends|matches|maps to|resolved|resolves|deprecated|follow)\b/i;
// Descriptive contracts without modal verbs are claims too, but constrain the
// subject and predicate to avoid treating arbitrary narrative as an API rule.
const API_BEHAVIOR = /^(?:the|a|an)\s+(?:sdk|api|client|loader|service|registry|dispatcher|handler|parser|serializer|runtime|mapping layer)\s+(?:returns|loads|maps|serializes|dispatches|registers|invokes|validates|rejects|emits|normalizes|resolves|throws)\b/i;
// Imperative rules in a skill need not contain modal verbs. Match only at
// the beginning of the actual statement, not embedded in quoted examples.
const IMPERATIVE = /^(?:avoid|ensure|prefer|reject|verify|check|preserve|record|document|confirm|validate)\b/i;
// Documentation about advice isn't itself the instruction being described.
const NARRATIVE = /^(?:this|the)\s+(?:guide|tutorial|example|overview|document|chapter|screenshot|section)\b|^for example\b|^in this (?:guide|tutorial|chapter|section)\b/i;
const isClaimCue = statement => !NARRATIVE.test(statement) &&
  (CUES.test(statement) || IMPERATIVE.test(statement) || API_BEHAVIOR.test(statement));
const IGNORE = /^(when to use|when not to use|inspect first|required process|validation checklist|red flags|common rationalizations|overview)$/i;
const API = /(?:`[^`]*(?:\w+\.\w+\(|@\w+|<[^>]+>)[^`]*`|@(?:ServiceMethod|Deprecated)|\b(?:startServer|dispatch|executeFun)\s*\()/i;
const POLICY = /\b(agent|skill|router|eval|completion|knowledge.base|Mockito|user explicitly|test naming)\b/i;
const CONVENTION = /\b(convention|naming|subpackage|package |location|placed|must be named|class name)\b/i;
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^\s*#{1,6}\s+(.+)$/;
const TABLE = /^\s*\|/;

function stripMd(s) {
  return s.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '')
    .replace(/^\[(?: |x|X)\]\s+/, '')
    .replace(/^>\s?/, '').replace(/\*\*/g, '').trim();
}

export function classifyClaimKind(statement) {
  if (API.test(statement)) return 'api-behavior';
  if (CONVENTION.test(statement)) return 'local-convention';
  if (POLICY.test(statement)) return 'agent-instruction';
  return 'domain-rule';
}

function atomicity(statement) {
  // Detection, not automatic splitting: clauses can depend on shared qualifiers.
  const clauses = statement.split(/\s*;\s*|\s+—\s+|\s+--\s+/).filter(Boolean);
  const mixed = API.test(statement) && /\b(?:must|should|never|do not|convention|naming)\b/i.test(statement);
  return { status: clauses.length > 1 || mixed ? 'REVIEW_SPLIT' : 'SINGLE_CANDIDATE',
    reason: clauses.length > 1 ? 'Multiple clauses' : mixed ? 'API behavior and prescription may be coupled' : null };
}

function eligibleSingleLine(raw) {
  const candidate = stripMd(raw.trim());
  return candidate.length >= 20 && candidate.length <= 420 && isClaimCue(candidate) && !/^\[.\]/.test(candidate);
}

/**
 * Build conservative Markdown prose blocks, preserving their exact source span.
 * Fence bodies, tables, HTML comments and indented code are not prose evidence.
 * A new list marker ALWAYS starts a new block, including nested list markers.
 */
function markdownBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let heading = '', block = null, fence = null, inFrontmatter = lines[0]?.trim() === '---', htmlComment = false;

  function flush() {
    if (block) blocks.push(block);
    block = null;
  }
  function add(raw, n, type, indent) {
    // Unlike soft wrapping, two complete technical sentences on consecutive
    // Markdown lines should remain separately reviewable. This conservative
    // boundary requires a full stop and a fresh, independently claim-like
    // uppercase sentence; lines ending mid-sentence are still joined.
    if (type === 'paragraph' && block?.type === 'paragraph' &&
        /[.!?]\s*$/.test(block.lines.at(-1)) &&
        /^[A-Z]/.test(raw) && isClaimCue(stripMd(raw))) flush();
    if (block && block.type === type && (type !== 'list' || indent >= block.continuationIndent)) {
      block.lines.push(raw);
      block.end = n;
    } else {
      flush();
      block = { lines:[raw], start:n, end:n, heading, type,
        continuationIndent:type === 'list' ? indent : 0 };
    }
  }

  for (let i=0; i<lines.length; i++) {
    const raw=lines[i], trimmed=raw.trim(), n=i+1;
    if (inFrontmatter) {
      if (i > 0 && (trimmed === '---' || trimmed === '...')) inFrontmatter=false;
      continue;
    }
    if (htmlComment) {
      if (raw.includes('-->')) htmlComment=false;
      continue;
    }
    const fenceMatch=trimmed.match(FENCE);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length) fence=null;
      continue;
    }
    if (fenceMatch) { flush(); fence={char:fenceMatch[1][0],length:fenceMatch[1].length}; continue; }
    if (trimmed.startsWith('<!--')) { flush(); htmlComment = !trimmed.includes('-->'); continue; }
    if (!trimmed || trimmed === '---' || TABLE.test(raw)) { flush(); continue; }
    const head=raw.match(HEADING);
    if (head) { flush(); heading=head[1].trim(); continue; }
    if (IGNORE.test(heading)) { flush(); continue; }
    const marker=raw.match(ITEM);
    if (marker) {
      flush();
      // Required indentation for soft-wrapped list content: at least the marker width.
      add(raw.trim(),n,'list',marker[0].length);
      continue;
    }
    // Do not interpret standalone indented code blocks as prose. List continuation
    // has already been accepted above when its indentation fits the marker.
    const indent = raw.length - raw.trimStart().length;
    if (block?.type === 'list') {
      // Four-space indentation may denote a Markdown code block. Avoid
      // absorbing code examples into a normative list item's claim text.
      if (indent >= 4) { flush(); continue; }
      if (indent >= block.continuationIndent && !/^\s*(?:>|\|)/.test(raw)) {
        block.lines.push(trimmed); block.end=n; continue;
      }
      flush();
    }
    if (indent >= 4) { flush(); continue; }
    // Blockquote changes context; don't merge it into preceding prose.
    const type = trimmed.startsWith('>') ? 'quote' : 'paragraph';
    add(trimmed,n,type,0);
  }
  flush();
  return blocks;
}

export function extractClaimsFromSkill(skill) {
  const claims=[];
  const repeated=new Map();
  let legacyIndex=0;
  const blocks=markdownBlocks(skill.text);
  for (const block of blocks) {
    const eligible=block.lines.filter(eligibleSingleLine);
    const firstSlot=eligible.length ? legacyIndex+1 : null;
    legacyIndex+=eligible.length;
    const statement=block.lines.map(stripMd).join(' ').replace(/\s+/g,' ').trim();
    if (statement.length < 20 || statement.length > 420 || !isClaimCue(statement)) continue;
    if (/^\[.\]/.test(statement) || statement.endsWith(':')) continue;
    // A multiline statement did not necessarily have a complete claim at its old
    // positional ID. The old ID is kept for traceability, but old LLM results
    // must not be silently mapped to the new merged proposition.
    const id=firstSlot === null ? `${skill.id}:ml${block.start}` : `${skill.id}:${firstSlot}`;
    const canonical=[skill.id,block.heading.replace(/\s+/g,' ').trim(),statement.replace(/\s+/g,' ').trim()].join('\0');
    const contentHash=createHash('sha256').update(canonical).digest('hex').slice(0,20);
    const occurrence=(repeated.get(contentHash)??0)+1;
    repeated.set(contentHash,occurrence);
    const identifiers=[...statement.matchAll(/`([^`]+)`/g)].map(m=>m[1]);
    claims.push({
      id, stable_id:`${skill.id}@${contentHash}${occurrence>1?`-${occurrence}`:''}`,
      skill:skill.id,skill_path:skill.path,
      source_path:skill.path,source_line_start:block.start,source_line_end:block.end,
      source_hash:createHash('sha256').update(statement).digest('hex'),
      section:block.heading||null,statement,claim_text:statement,
      claim_kind:classifyClaimKind(statement),atomicity:atomicity(statement),
      identifiers,extraction_form:block.end>block.start?'MULTILINE_PROPOSITION':'PROPOSITION',
      // Paragraph segmentation has changed between extractor versions.
      // Position-only historical verdicts must not be reused without an
      // exact content-derived identity.
      requires_content_identity:block.type==='paragraph',
      verification:'NOT_CHECKED'
    });
  }
  return claims;
}

export function extractClaims(skills) { return skills.filter(s=>!thinAdapterTarget(s)).flatMap(extractClaimsFromSkill); }
