import fs from 'node:fs';
import path from 'node:path';

// Conservative, bounded text corpus. Missing or skipped files are NOT evidence
// that an instruction is false; the semantic auditor must be able to abstain.
const TEXT_EXTS = new Set([
  '.java','.kt','.xml','.md','.txt','.yaml','.yml','.json','.properties',
  '.js','.jsx','.mjs','.cjs','.ts','.tsx','.mts','.cts','.py'
]);
const SKIP_DIRS=new Set([
  '.git','node_modules','target','dist','build','coverage','.next',
  '.venv','venv','__pycache__','.cache'
]);
const MAX_FILES=2000,MAX_BYTES=16*1024*1024,MAX_FILE_BYTES=512*1024;
const MAX_DEPTH=24,MAX_ENTRIES=25000;

export function buildEvidenceIndex(root) {
  if(!root)return [];
  const base=fs.realpathSync(root);
  if(!fs.statSync(base).isDirectory())throw Error('Evidence root must be a directory');
  const docs=[];
  const stack=[{directory:base,relative:'',depth:0}];
  let totalBytes=0,visited=0;
  while(stack.length && docs.length<MAX_FILES && totalBytes<MAX_BYTES &&
        visited<MAX_ENTRIES){
    const current=stack.pop();
    let entries;
    try {entries=fs.readdirSync(current.directory,{withFileTypes:true});}
    catch {continue;}
    // Descend in stable path order regardless of OS directory enumeration.
    entries.sort((a,b)=>a.name.localeCompare(b.name,'en'));
    const children=[];
    for(const entry of entries){
      if(++visited>MAX_ENTRIES)break;
      if(entry.isSymbolicLink())continue; // Do not read through repo symlinks.
      const relative=current.relative?current.relative+'/'+entry.name:entry.name;
      const absolute=path.join(current.directory,entry.name);
      if(entry.isDirectory()){
        if(current.depth<MAX_DEPTH&&!SKIP_DIRS.has(entry.name))
          children.push({directory:absolute,relative,depth:current.depth+1});
        continue;
      }
      if(!entry.isFile()||!TEXT_EXTS.has(path.extname(entry.name).toLowerCase()))
        continue;
      let size;
      try {size=fs.lstatSync(absolute).size;} catch {continue;}
      if(size>MAX_FILE_BYTES||size+totalBytes>MAX_BYTES)continue;
      let buffer;
      try {buffer=fs.readFileSync(absolute);} catch {continue;}
      if(buffer.includes(0)||buffer.length>MAX_FILE_BYTES)continue;
      docs.push({path:relative,text:buffer.toString('utf8')});
      totalBytes+=buffer.length;
      if(docs.length>=MAX_FILES || totalBytes>=MAX_BYTES)break;
    }
    for(let i=children.length-1;i>=0;i--)stack.push(children[i]);
  }
  return docs;
}

export function searchEvidence(index, terms, max = 12) {
  const normalized = [...new Set(terms.filter(Boolean).map(String))];
  if (!normalized.length) return [];
  const hits = [];
  for (const doc of index) {
    let score = 0;
    const matches = [];
    for (const term of normalized) {
      const pos = doc.text.indexOf(term);
      if (pos >= 0) {
        score += term.length > 12 ? 3 : 1;
        matches.push(term);
      }
    }
    if (score) hits.push({ path: doc.path, score, matches });
  }
  return hits.sort((a,b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, max);
}

export function findDeprecatedEvidence(index, identifier) {
  if (!identifier) return [];
  const method = identifier.includes('(') ? identifier.slice(0, identifier.indexOf('(')).split('.').at(-1) : identifier.split('.').at(-1);
  const hits = [];
  for (const doc of index.filter(d => d.path.endsWith('.java'))) {
    const lines = doc.text.split('\n');
    lines.forEach((line, i) => {
      if (!line.includes(method)) return;
      const from = Math.max(0, i - 8);
      const to = Math.min(lines.length, i + 8);
      const window = lines.slice(from, to).join('\n');
      if (window.includes('@Deprecated')) hits.push({ path: doc.path, line: i + 1, symbol: method });
    });
  }
  return hits;
}
