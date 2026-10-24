export function parseResult(name: string): string {
  const normalized = name.trim();
  if (!normalized) return 'anonymous';
  return normalized.toLowerCase();
}
