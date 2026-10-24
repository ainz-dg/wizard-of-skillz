/** Validate citation integrity, NOT whether the cited content entails a claim.
 * Security boundary: never read outside explicitly supplied repository roots.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 2_000_000;
const VALID = new Set(['REFERENCE_VALID','SELF_REFERENCE']);

function safeRelative(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024 || p.includes('\0') || p.includes('\\') ||
      path.posix.isAbsolute(p) || /^(?:[A-Za-z]:|~\/)/.test(p)) return false;
  const parts = p.split('/');
  return parts.every(x => x && x !== '.' && x !== '..');
}

export function checkEvidenceReference(ev, { consumerRepo, providerRepo, consumerRoot, providerRoot, claimSourcePath } = {}) {
  const base = { repo:ev?.repo ?? null, path:ev?.path ?? null, symbol:ev?.symbol ?? null };
  const root = ev?.repo === consumerRepo ? consumerRoot : ev?.repo === providerRepo ? providerRoot : null;
  if (ev?.repo !== consumerRepo && ev?.repo !== providerRepo) return {...base,status:'UNKNOWN_REPOSITORY'};
  if (!safeRelative(ev?.path)) return {...base,status:'UNSAFE_PATH'};
  if (!root) return {...base,status:'ROOT_UNAVAILABLE'};
  try {
    const realRoot = fs.realpathSync(root);
    const absolute = path.resolve(realRoot, ev.path);
    const realFile = fs.realpathSync(absolute);
    if (!realFile.startsWith(realRoot + path.sep)) return {...base,status:'OUTSIDE_REPOSITORY'};
    const stat = fs.statSync(realFile);
    if (!stat.isFile()) return {...base,status:'NOT_A_FILE'};
    if (stat.size > MAX_BYTES) return {...base,status:'TOO_LARGE'};
    if (typeof ev.symbol === 'string' && ev.symbol.length > 0) {
      if (ev.symbol.length > 512 || !fs.readFileSync(realFile, 'utf8').includes(ev.symbol)) {
        return {...base,status:'SYMBOL_NOT_FOUND'};
      }
    }
    const isSelf = ev.repo === consumerRepo && ev.path === claimSourcePath;
    return {...base,status:isSelf?'SELF_REFERENCE':'REFERENCE_VALID'};
  } catch (err) {
    return {...base,status:err?.code === 'ENOENT'?'FILE_NOT_FOUND':'READ_FAILED'};
  }
}

export function assessEvidence(evidence, opts = {}) {
  const checks = (Array.isArray(evidence)?evidence:[]).map(e=>checkEvidenceReference(e,opts));
  const valid = checks.filter(x=>VALID.has(x.status));
  const independent = valid.filter(x=>x.status === 'REFERENCE_VALID');
  const invalid = checks.filter(x=>!VALID.has(x.status) && x.status!=='ROOT_UNAVAILABLE');
  const unavailable = checks.filter(x=>x.status === 'ROOT_UNAVAILABLE');
  let status = 'NO_EVIDENCE';
  if (checks.length) {
    if (!valid.length && unavailable.length === checks.length) status='NOT_INSPECTED';
    else if (!valid.length) status='INVALID_ONLY';
    else if (invalid.length || unavailable.length) status='PARTIALLY_VALID';
    else if (!independent.length) status='SELF_REFERENCE_ONLY';
    else status='VALID_REFERENCES_ONLY';
  }
  return {status,checks,valid_count:valid.length,independent_count:independent.length,
    invalid_count:invalid.length,unavailable_count:unavailable.length,
    note:'File and optional symbol existence only; no semantic entailment performed.'};
}
