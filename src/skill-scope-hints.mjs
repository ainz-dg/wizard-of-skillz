/**
 * Directional scope hints for existing skills. A hint is not a MOVE operation:
 * no destination path is fabricated, and semantic claim labels are not proof.
 */
import {createHash} from 'node:crypto';

const sha = text => createHash('sha256').update(text).digest('hex');
const valid = x => typeof x === 'string' && x.trim().length > 0;

// Conflicting classifications and broken/uninspectable citations cannot
// support a directional recommendation, regardless of an LLM's SUPPORTED tag.
function usableScopeClaim(c) {
  if(c.verification !== 'SUPPORTED') return false;
  if((c.review_flags || []).some(flag =>
    /^(?:CLASS_SCOPE_CONFLICT|INVALID_EVIDENCE_REFERENCE|STALE_ANALYSIS_CLAIM)/.test(flag))) return false;
  const integrity=c.evidence_integrity;
  return !integrity || ['VALID_REFERENCES_ONLY','NO_EVIDENCE'].includes(integrity.status);
}

function evidenceAssessment(claims) {
  const checked=claims.filter(c =>
    c.evidence_integrity?.status === 'VALID_REFERENCES_ONLY' &&
    c.evidence_integrity.independent_count > 0).length;
  const status=checked===0?'CLASSIFICATION_ONLY':
    checked===claims.length?'SOURCE_REFERENCES_CHECKED':'PARTIAL_SOURCE_REFERENCES';
  return {status,checked_claims:checked,total_classified_claims:claims.length,
    note:'Verified reference existence is not proof of semantic correctness or ownership.'};
}

function claimRef(c) {
  return {
    claim_id:c.id, stable_id:c.stable_id??null,
    path:c.source_path??c.skill_path??null,
    line_start:c.source_line_start??null,
    owner:c.owner,
    knowledge_class:c.knowledge_class,
    applicability:c.applicability??null,
    verification:c.verification,
    verification_basis:c.verification_basis??null
  };
}

/**
 * Signals rely ONLY on attributed, SUPPORTED classifications already supplied
 * by an audit. They remain tentative: LLM SUPPORTED is not semantic entailment.
 * A mix calls for SPLIT, never moving the whole skill as if it had one owner.
 */
export function analyzeSkillScope({skills, claims, consumerRepo, providerRepo, installedScope='repo', installedScopeBasis=null}) {
  if (!Array.isArray(skills) || !Array.isArray(claims) ||
      !valid(consumerRepo) || !valid(providerRepo) || consumerRepo === providerRepo)
    throw Error('Scope hints need skills, claims and distinct explicit repository IDs');
  if (!['repo','shared'].includes(installedScope))
    throw Error('Installed skill scope must be repo or shared');
  const hints = [], abstentions=[];
  for (const skill of skills) {
    if (!valid(skill?.id) || !valid(skill.path) || typeof skill.text !== 'string')
      throw Error('Scope analysis requires source inventory with exact skill text');
    const members = claims.filter(c => c.skill_path === skill.path &&
      c.skill === skill.id);
    const provider = members.filter(c => usableScopeClaim(c) &&
      c.owner === providerRepo && c.knowledge_class === 'sdk-contract');
    const local = members.filter(c => usableScopeClaim(c) &&
      c.owner === consumerRepo && c.applicability === 'repo-local');
    const unclassified = members.filter(c => !provider.includes(c) && !local.includes(c));
    const mixed = provider.length > 0 && local.length > 0;
    // Never mark ordinary repository-local skills as "too broad". A narrower
    // hint needs an explicitly identified shared installation and *all*
    // audited claims to be consistently classified as local.
    const narrower = installedScope === 'shared' && provider.length === 0 &&
      local.length > 0 && unclassified.length === 0;
    if (!provider.length && !narrower) {
      abstentions.push({skill:skill.id,path:skill.path,reason:
        local.length && installedScope==='shared' && unclassified.length ?
          'INCOMPLETE_SCOPE_EVIDENCE' :
          local.length && installedScope==='repo' && !unclassified.length ?
          'ALREADY_REPOSITORY_LOCAL' : 'INSUFFICIENT_SCOPE_EVIDENCE'});
      continue;
    }
    const kind = mixed ? 'SPLIT_SCOPE_CANDIDATE' :
      narrower ? 'NARROWER_SCOPE_CANDIDATE' : 'BROADER_SCOPE_CANDIDATE';
    const sourceHash = sha(skill.text);
    const evidence_review = evidenceAssessment([...provider,...local]);
    hints.push({
      id:'scope-'+sha(consumerRepo+'\0'+skill.path+'\0'+kind).slice(0,16),
      kind, skill:skill.id,
      current:{repo:consumerRepo,path:skill.path,sha256:sourceHash},
      target:null,
      target_known:false,
      installed_scope:installedScope,
      installed_scope_basis:installedScopeBasis ?? (installedScope==='shared' ?
        'EXPLICIT_SHARED_INSTALLATION' : 'DEFAULT_REPOSITORY_INSTALLATION'),
      suggested_action:'REVIEW_SCOPE', // NOT a MOVE/UPDATE instruction.
      directions:mixed?['BROADER_FOR_PROVIDER_CLAIMS','NARROWER_FOR_LOCAL_CLAIMS']:
        narrower?['NARROWER_FOR_LOCAL_CLAIMS']:['BROADER_FOR_PROVIDER_CLAIMS'],
      reason:mixed?
        'Skill contains provider contract knowledge and repository-local knowledge; review splitting their scopes.' :
        narrower?
        'A skill explicitly installed at shared scope contains only classified repository-local claims; consider a narrower local scope.' :
        'Classified provider-owned SDK contract knowledge may belong at a broader shared scope.',
      provider_claims:provider.map(claimRef),
      local_claims:local.map(claimRef),
      unresolved_claim_count:unclassified.length,
      confidence:'TENTATIVE',
      proof:'AUDIT_CLASSIFICATION_ONLY',
      evidence_review,
      limits:[
        'SUPPORTED classifications do not establish independent semantic entailment or ownership.',
        'The proper destination is unknown; do not invent one or treat this as a MOVE.',
        ...(unclassified.length?['Other claims in the skill have not established either ownership category.']:[]),
        ...(mixed?['Moving the entire skill would also move local knowledge; consider splitting instead.']:[]),
        ...(narrower?['Shared scope is evidenced by explicit input or an exact user-level installation path, never a repository directory name.']:[])
      ],
      write_authorized:false
    });
  }
  return {
    schema_version:1,
    basis:'DIRECTIONAL_HINTS_FROM_EXISTING_AUDIT_CLASSIFICATIONS',
    source_repo:consumerRepo,provider_repo:providerRepo,
    installed_scope:installedScope,
    installed_scope_basis:installedScopeBasis ?? (installedScope==='shared' ?
      'EXPLICIT_SHARED_INSTALLATION' : 'DEFAULT_REPOSITORY_INSTALLATION'),
    hints,abstentions,
    summary:{
      inspected_skills:skills.length,
      scope_hints:hints.length,
      with_checked_references:hints.filter(h=>h.evidence_review.status==='SOURCE_REFERENCES_CHECKED').length,
      classification_only:hints.filter(h=>h.evidence_review.status==='CLASSIFICATION_ONLY').length,
      abstained:abstentions.length
    },
    confirmation_required:true,write_authorized:false,
    note:'Scope hints are non-applying diagnostics. They cannot be selected as executable MOVE proposals.'
  };
}

export function skillScopeMarkdown(report) {
  if (!report || report.schema_version !== 1 || !Array.isArray(report.hints) ||
      report.write_authorized !== false) throw Error('Invalid read-only scope report');
  const lines = [
    '# Wizard — possibili correzioni di scope','',
    '**Diagnosi, non MOVE. Destinazione sconosciuta. Nessuna modifica autorizzata.**','',
    'Le classificazioni dei claim sono indizi da verificare, non dimostrazioni di ownership.',''
  ];
  if (report.summary) lines.push('Skill analizzate: '+report.summary.inspected_skills+
    '; diagnosi: '+report.summary.scope_hints+'; astensioni: '+report.summary.abstained+'.','');
  if (!report.hints.length) lines.push('Nessun indizio sufficientemente classificato per suggerire una variazione di scope.','');
  for (const skipped of report.abstentions??[])
    lines.push('- Nessuna diagnosi per '+skipped.skill+': '+skipped.reason);
  if (report.abstentions?.length) lines.push('');
  for (const h of report.hints) {
    lines.push('## '+h.skill,'',
      '- Direzione: '+(h.kind==='SPLIT_SCOPE_CANDIDATE' ?
        '**separare scope condiviso e scope locale**' :
        h.kind==='NARROWER_SCOPE_CANDIDATE' ?
        '**scope più specifico / locale**' : '**scope più alto / condiviso**'),
      '- Skill attuale: '+h.current.repo+':'+h.current.path,
      '- Ambito di installazione: '+h.installed_scope+' ('+h.installed_scope_basis+')',
      '- SHA-256: '+h.current.sha256,
      '- Destinazione: **non determinata**',
      '- Claim attribuiti al provider: '+h.provider_claims.length,
      '- Claim locali: '+h.local_claims.length,
      '- Altri claim: '+h.unresolved_claim_count,
      '- Affidabilità: **da verificare**',
      '- Evidenze: '+(h.evidence_review?.status??'CLASSIFICATION_ONLY')+
        ' ('+(h.evidence_review?.checked_claims??0)+' / '+
        (h.evidence_review?.total_classified_claims??0)+' claim con riferimenti indipendenti controllati; non è prova semantica)',
      '- Motivo: '+h.reason,
      '- Claim da esaminare: '+[...h.provider_claims,...h.local_claims].map(x=>x.claim_id).join(', '),
      '- Nessun file modificato.','');
  }
  return lines.join('\n');
}


/**
 * Compact companion section for the existing review-pending.md. Scope hints
 * have no checkbox: NONE/ALL/SUBSET select only real repository operations.
 */
export function renderScopeReviewSection(report) {
  if (!report || report.schema_version !== 1 ||
      report.write_authorized !== false || !Array.isArray(report.hints))
    throw Error('Invalid non-applying scope report');
  if (!report.hints.length) return '';
  const md = value => String(value ?? '').replace(/\s+/g,' ').trim()
    .replace(/[\\*_[\]#|<>]/g,'\\$&')
    .replaceAll(String.fromCharCode(96), '\\'+String.fromCharCode(96));
  const instructions = {
    BROADER_SCOPE_CANDIDATE: {
      direction:'Valutare uno scope più alto',
      next:'Verificare ownership dei contratti e possibili consumatori condivisi'
    },
    NARROWER_SCOPE_CANDIDATE: {
      direction:'Valutare uno scope più specifico',
      next:'Verificare installazione e consumatori prima di restringere lo scope'
    },
    SPLIT_SCOPE_CANDIDATE: {
      direction:'Valutare la separazione condiviso / locale',
      next:'Verificare i due gruppi di claim; non spostare l’intera skill'
    }
  };
  const lines=[
    '## Diagnosi di scope — non selezionabili','',
    '**Sono indizi, non MOVE e non autorizzazioni alla scrittura.**',
    'Le selezioni NONE / ALL / SUBSET sopra riguardano solo le proposte operative.',
    'La destinazione resta sconosciuta. Per l’analisi completa: [scope-hints.md](scope-hints.md).',''
  ];
  for (const h of report.hints) {
    if (!h || !instructions[h.kind] || h.target !== null ||
        h.target_known !== false || h.suggested_action !== 'REVIEW_SCOPE' ||
        h.write_authorized !== false || !h.current ||
        !Array.isArray(h.provider_claims) || !Array.isArray(h.local_claims))
      throw Error('Invalid non-applying scope hint');
    const info=instructions[h.kind];
    const providerIds=h.provider_claims.map(c=>md(c.claim_id)).join(', ') || 'nessuno';
    const localIds=h.local_claims.map(c=>md(c.claim_id)).join(', ') || 'nessuno';
    lines.push('### '+md(h.skill),'',
      '- Direzione: **'+info.direction+'** (da verificare)',
      '- Origine: '+md(h.current.repo)+':'+md(h.current.path)+
        ' (SHA-256 '+md(h.current.sha256)+')',
      '- Scope osservato: '+md(h.installed_scope)+
        ' — origine: '+md(h.installed_scope_basis),
      '- Claim provider: '+providerIds,
      '- Claim locali: '+localIds,
      '- Claim non risolti: '+Number(h.unresolved_claim_count||0),
      '- Destinazione: **non determinata**',
      '- Stato delle fonti: '+md(h.evidence_review?.status??'CLASSIFICATION_ONLY')+
        ' ('+(h.evidence_review?.checked_claims??0)+' / '+
        (h.evidence_review?.total_classified_claims??0)+' claim con riferimenti controllati)',
      '- Prossima verifica: '+(h.evidence_review?.status==='SOURCE_REFERENCES_CHECKED'?
        info.next:'Controllare le fonti dei claim, poi: '+info.next),
      '');
  }
  return lines.join('\n');
}
