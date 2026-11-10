import { buildEvidenceIndex, searchEvidence } from './evidence.mjs';
import fs from 'node:fs';

// Generic lexical retrieval: candidate paths and excerpts are references,
// not proof that a skill claim is semantically true.
const STOP = new Set('the a an and or to of in for with from into on by as is are be this that it use uses must should do not never always when then than only any all new class method service repository file code project test tests'.split(/\s+/));
const MAX_OCCURRENCES = 64;
function words(statement) {
  return [...new Set(String(statement).replaceAll(String.fromCharCode(96),' ').split(/[^A-Za-z0-9_.$@<>-]+/)
    .map(x => x.trim()).filter(x => x.length >= 4 && !STOP.has(x.toLowerCase())))]
    .sort((a,b) => b.length-a.length).slice(0,10);
}
function lineOf(text,pos){return text.slice(0,Math.max(0,pos)).split('\n').length;}
function implementationCue(text, start, end, term) {
  const before=text.slice(Math.max(0,start-240),start);
  const after=text.slice(end,Math.min(text.length,end+240));
  const lineStart=text.lastIndexOf('\n',start-1)+1;
  const lineEnd=text.indexOf('\n',start);
  const line=text.slice(lineStart,lineEnd<0?text.length:lineEnd).trim();
  const escaped=term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const declaration=new RegExp(`(?:function|class|interface|type|const|let|var|def|func|fn|struct|enum|trait)\\s+${escaped}\\b|\\b${escaped}\\s*\\(`,'i').test(line);
  const comment=/^(?:\/\/|\/\*|\*|#|<!--)/.test(line);
  const importLike=/^(?:import|export\s+.*\s+from\b|require\s*\()/.test(line);
  const window=(before+line+' '+after).toLowerCase();
  const localMatches=(window.match(new RegExp(escaped,'ig'))||[]).length;
  return (declaration?7:0)+(comment?-5:0)+(importLike?-6:0)+Math.min(localMatches,4);
}

function makeSnippet(text, terms, radius=750, preferred=null) {
  const ordered=[...(preferred?[preferred]:[]),...terms];
  const unique=[...new Set(ordered.filter(x=>typeof x==='string'&&x.length))];
  const candidates=[];
  for(let termIndex=0;termIndex<unique.length&&candidates.length<MAX_OCCURRENCES;termIndex++){
    const term=unique[termIndex];
    let from=0;
    while(from<text.length&&candidates.length<MAX_OCCURRENCES){
      const pos=text.indexOf(term,from);
      if(pos<0)break;
      const end=pos+term.length;
      candidates.push({pos,end,term,termIndex,score:implementationCue(text,pos,end,term)});
      from=Math.max(end,pos+1);
    }
  }
  if(!candidates.length) return {line:1,snippet:text.slice(0,radius*2),matched:null,score:0};
  candidates.sort((a,b)=>b.score-a.score||a.termIndex-b.termIndex||a.pos-b.pos);
  const best=candidates[0];
  const start=Math.max(0,best.pos-radius),end=Math.min(text.length,best.end+radius);
  return {line:lineOf(text,start),snippet:text.slice(start,end),matched:best.term,score:best.score};
}
export function retrievalTerms(claim){
  return [...new Set([...(claim.identifiers||[]),...words(claim.statement)])].slice(0,14);
}
/** Specialized adapters MAY supply hints explicitly, never by default. */
export function retrieveForClaim(index,claim,max=6,{
  anchorHints=null,preferredSnippet=null
}={}){
  const terms=retrievalTerms(claim);
  const hints=typeof anchorHints==='function'?anchorHints(claim):[];
  const hits=searchEvidence(index,terms,Math.max(max*3,20));
  const scored=new Map(hits.map(h=>[h.path,{...h}]));
  for(const hint of hints)for(const d of index){
    if(!d.path.endsWith('/'+hint.filename)&&d.path!==hint.filename)continue;
    const hit=scored.get(d.path)||{path:d.path,score:0,matches:[]};
    hit.score+=hint.priority;hit.preferred=hint.symbol;scored.set(d.path,hit);
  }
  const documents=new Map(index.map(d=>[d.path,d]));
  return [...scored.values()]
    .sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path))
    .slice(0,max).map(hit=>{
      const doc=documents.get(hit.path);
      const override=typeof preferredSnippet==='function'?
        preferredSnippet({doc,claim,hit}):null;
      const sn=makeSnippet(doc?.text||'',terms,750,override||hit.preferred);
      return {path:hit.path,score:hit.score,snippet_score:sn.score,matched:hit.matches,
        line:sn.line,snippet:sn.snippet};
    });
}
export function buildRetrievalContext({
  consumerRoot,providerRoot,claims,perRepo=5,retrievalOptions=null
}){
  const sameRoot=Boolean(consumerRoot&&providerRoot&&
    fs.realpathSync(consumerRoot)===fs.realpathSync(providerRoot));
  const consumerIndex=buildEvidenceIndex(consumerRoot);
  const providerIndex=sameRoot?consumerIndex:buildEvidenceIndex(providerRoot);
  return claims.map(claim=>{
    // A skill statement may define the question, but cannot independently prove itself.
    const ownSkill=claim.source_path??claim.skill_path??null;
    const independentlyAvailable=list=>ownSkill?
      list.filter(doc=>doc.path!==ownSkill):list;
    const consumer=retrieveForClaim(independentlyAvailable(consumerIndex),
      claim,perRepo,retrievalOptions??{});
    return {claim_id:claim.id,
      // In one repository, expose each source once. Treat it as provider evidence
      // for the existing directional corroboration checks; there is no second corpus.
      consumer_candidates:sameRoot?[]:consumer,
      provider_candidates:sameRoot?consumer:retrieveForClaim(
        independentlyAvailable(providerIndex),claim,perRepo,retrievalOptions??{})};
  });
}
