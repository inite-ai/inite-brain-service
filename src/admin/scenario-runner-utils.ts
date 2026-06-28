// Pure helpers shared across the scenario-runner phase services
// (write / lifecycle / eval) and the orchestrator.

export function parseRefTag(ref: string): { refKey: string; id: string } {
  const [vertical, id] = ref.split('.', 2);
  return { refKey: `${safe(vertical)}__${safe(id)}`, id };
}

export function formatTopRef(
  refs: Record<string, string> | undefined,
): string | null {
  if (!refs) return null;
  const entries = Object.entries(refs);
  if (entries.length === 0) return null;
  const [k, v] = entries[0];
  const dot = k.indexOf('__');
  if (dot === -1) return `${k}.${v}`;
  return `${k.slice(0, dot)}.${v}`;
}

export function safe(s: string): string {
  return s.replace(/\./g, '__');
}

export function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]+/g, '_').slice(0, 40);
}
