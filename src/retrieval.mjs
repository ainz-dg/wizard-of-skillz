import { buildEvidenceIndex, searchEvidence } from './evidence.mjs';

// Generic lexical retrieval: candidate paths and excerpts are references,
// not proof that a skill claim is semantically true.
const STOP = new Set('the a an and or to of in for with from into on by as is are be this that it use uses must should do not never always when then than only any all new class method service repository file code project test tests'.split(/\s+/));
function words(statement) {
  return [...new Set(String(statement).replaceAll(String.fromCharCode(96),' ').split(/[^A-Za-z0-9_.$@<>-]+/)
    .map(x => x.trim()).filter(x => x.length >= 4 && !STOP.has(x.toLowerCase())))]
    .sort((a,b) => b.length-a.length).slice(0,10);
}
function lineOf(text,pos){return text.slice(0,Math.max(0,pos)).split('\n').length;}
function makeSnippet(text, terms, radius=750, preferred=null) {
  let pos=-1,term=null;
  if (preferred) { const p=text.indexOf(preferred); if(p>=0){pos=p;term=preferred;} }
  if(pos<0) for(const t of terms){const p=text.indexOf(t);if(p>=0&&(pos<0||p<pos)){pos=p;term=t;}}
  if(pos<0) return {line:1,snippet:text.slice(0,radius*2),matched:null};
  const start=Math.max(0,pos-radius),end=Math.min(text.length,pos+(term?.length??0)+radius);
  return {line:lineOf(text,start),snippet:text.slice(start,end),matched:term};
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
      return {path:hit.path,score:hit.score,matched:hit.matches,
        line:sn.line,snippet:sn.snippet};
    });
}
export function buildRetrievalContext({
  consumerRoot,providerRoot,claims,perRepo=5,retrievalOptions=null
}){
  const consumerIndex=buildEvidenceIndex(consumerRoot);
  const providerIndex=buildEvidenceIndex(providerRoot);
  return claims.map(claim=>{
    // A skill statement may define the question, but cannot independently prove itself.
    const ownSkill=claim.source_path??claim.skill_path??null;
    const independentlyAvailable=list=>ownSkill?
      list.filter(doc=>doc.path!==ownSkill):list;
    return {claim_id:claim.id,
      consumer_candidates:retrieveForClaim(independentlyAvailable(consumerIndex),
        claim,perRepo,retrievalOptions??{}),
      provider_candidates:retrieveForClaim(independentlyAvailable(providerIndex),
        claim,perRepo,retrievalOptions??{})};
  });
}
