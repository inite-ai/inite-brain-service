/**
 * Whether a mention's facts disagree with an entity's on a slot that holds
 * one value at a time — the question the same-name check asks when no judge
 * is there to weigh it (no model key, harness mode, the resolver off).
 *
 * Disagreement here is not proof of two people: a single-valued slot can
 * change (a move, a new role). It is the absence of evidence that they are
 * one. That is enough to decide which mistake to risk: a wrong merge cannot
 * be seen again — one node holds both people, and one person's facts are
 * served as the other's — while a wrong split is a same-named pair the
 * dedup pass judges later. So a disagreement keeps them apart.
 *
 * `name` is left out: two people who share a name are the very case being
 * decided, and its surface forms differ for one person.
 */

/** A fact line as the ladder renders it: `predicate: object`. */
export function parseFactLine(line: string): { predicate: string; object: string } | null {
  const at = line.indexOf(': ');
  if (at <= 0) return null;
  return { predicate: line.slice(0, at).trim(), object: line.slice(at + 2).trim() };
}

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', '!']);

function normalizeValue(v: string): string {
  const s = v.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  let end = s.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(s[end - 1]!)) end -= 1;
  return s.slice(0, end);
}

export function conflictsOnSingleValuedSlot(
  incoming: ReadonlyArray<string>,
  existing: ReadonlyArray<{ predicate: string; object: string }>,
  singleValued: ReadonlySet<string>,
): boolean {
  const held = new Map<string, Set<string>>();
  for (const f of existing) {
    if (!singleValued.has(f.predicate) || f.predicate === 'name') continue;
    const values = held.get(f.predicate) ?? new Set<string>();
    values.add(normalizeValue(f.object));
    held.set(f.predicate, values);
  }
  for (const line of incoming) {
    const f = parseFactLine(line);
    if (!f) continue;
    const values = held.get(f.predicate);
    if (values && !values.has(normalizeValue(f.object))) return true;
  }
  return false;
}
