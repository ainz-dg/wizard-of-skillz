import fs from 'node:fs';
import path from 'node:path';
import { walk, readText, rel } from './fs-utils.mjs';

function firstMatch(text, re) {
  return text.match(re)?.[1]?.trim() ?? null;
}

export function profileRepository(root, repoId = path.basename(path.resolve(root))) {
  root = path.resolve(root);
  const files = walk(root);
  const pomPath = path.join(root, 'pom.xml');
  const readmePath = files.find(f => /^README\.md$/i.test(path.basename(f)) && path.dirname(f) === path.resolve(root));
  const pom = fs.existsSync(pomPath) ? readText(pomPath) : '';
  const readme = readmePath ? readText(readmePath) : '';

  const artifactId = firstMatch(pom, /<artifactId>([^<]+)<\/artifactId>/);
  const groupId = firstMatch(pom, /<groupId>([^<]+)<\/groupId>/);
  const version = firstMatch(pom, /<version>([^<]+)<\/version>/);
  const modules = [...pom.matchAll(/<module>([^<]+)<\/module>/g)].map(m => m[1].trim());
  const dependencyArtifacts = [...pom.matchAll(/<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?(?:<version>([^<]+)<\/version>)?[\s\S]*?<\/dependency>/g)]
    .map(m => ({ ecosystem: 'maven', id: `${m[1].trim()}:${m[2].trim()}`, version: m[3]?.trim() ?? null }));

  const haystack = `${repoId}\n${artifactId ?? ''}\n${readme}`.toLowerCase();
  const roles = new Set();
  if (modules.length) roles.add('monorepo');
  if (/sdk|framework/.test(haystack)) roles.add('sdk');
  if (/micro executor|microexecutor|\bmex\b/.test(haystack)) roles.add('micro-executor');
  if (/frontend|application|app\b/.test(haystack)) roles.add('application');
  if (/library|components library/.test(haystack)) roles.add('library');
  if (!roles.size) roles.add('application');

  const skillRoots = [...new Set(files.filter(f => /(^|\/)SKILL\.md$/i.test(rel(root, f))).map(f => rel(root, path.dirname(f)).split('/').slice(0, 3).join('/')))].filter(Boolean);
  const entrypoints = files.filter(f => ['AGENTS.md','CLAUDE.md','GEMINI.md'].includes(path.basename(f))).map(f => rel(root, f));

  return {
    schema_version: '0.3',
    repository: { id: repoId, root: path.resolve(root) },
    roles: [...roles],
    artifact: artifactId ? { ecosystem: 'maven', id: groupId ? `${groupId}:${artifactId}` : artifactId, version } : null,
    modules,
    dependencies: dependencyArtifacts,
    agent_knowledge: { skill_roots: skillRoots, entrypoints },
    evidence: [
      ...(fs.existsSync(pomPath) ? [{ path: 'pom.xml', kind: 'manifest' }] : []),
      ...(readmePath ? [{ path: rel(root, readmePath), kind: 'docs' }] : [])
    ]
  };
}
