/**
 * Whether a mention's facts disagree with an entity's — on a slot that holds
 * one value at a time, or on who the person is (city, employer, profession)
 * — the question the same-name check asks when no judge is there to weigh
 * it (no model key, harness mode, the resolver off) or the judge was unsure.
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

/**
 * What says WHO a person is, by kind: where they live, whom they work for,
 * what they do. The extractor coins predicates freely, so one attribute
 * arrives under several names — "Anna Schmidt" the vet came in as
 * `occupation: vet` with her city on a `located_in` edge, the engineer as
 * `role: software engineer`, `lives_in: Lisbon` and a `works_at` edge
 * (#815). A comparison of identical predicates saw two disjoint profiles
 * and nothing to disagree on. A move (`moved_to`) and an industry
 * (`works_in`) are left out: neither places the person.
 */
export type IdentityClass = 'place' | 'employer' | 'profession';

const IDENTITY_PREDICATES: ReadonlyArray<[IdentityClass, ReadonlyArray<string>]> = [
  [
    'place',
    [
      'lives_in',
      'lives_at',
      'located_in',
      'based_in',
      'based_at',
      'resides_in',
      'residence',
      'city',
      'home_city',
      'hometown',
      'location',
      'works_in_city',
    ],
  ],
  [
    'employer',
    ['works_at', 'works_for', 'employer', 'employed_by', 'employed_at', 'workplace', 'company'],
  ],
  ['profession', ['occupation', 'profession', 'works_as', 'job', 'job_title', 'role']],
];

const CLASS_OF = new Map<string, IdentityClass>(
  IDENTITY_PREDICATES.flatMap(([cls, preds]) => preds.map((p) => [p, cls] as const)),
);

export function identityClassOf(predicate: string): IdentityClass | undefined {
  return CLASS_OF.get(predicate.trim().toLowerCase());
}

function words(v: string): Set<string> {
  return new Set(
    normalizeValue(v)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w !== ''),
  );
}

/**
 * Two values of one attribute agree when one's words are all in the
 * other's: "Munich" and "Munich, Bavaria", "engineer" and "software
 * engineer", "a vet" and "vet".
 */
function valuesAgree(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  for (const w of small) if (!big.has(w)) return false;
  return true;
}

function byClass(
  pairs: Iterable<{ predicate: string; object: string }>,
): Map<IdentityClass, string[]> {
  const out = new Map<IdentityClass, string[]>();
  for (const { predicate, object } of pairs) {
    const cls = identityClassOf(predicate);
    if (!cls) continue;
    out.set(cls, [...(out.get(cls) ?? []), object]);
  }
  return out;
}

/**
 * How the mention's identifying attributes meet the entity's:
 * - `agrees` — some attribute both state has a value in common (the same
 *   employer after a move to another city is one person);
 * - `contradicts` — some attribute both state has no value in common, and
 *   none agrees: someone else who shares the name;
 * - `unrelated` — no attribute is stated on both sides; nothing to compare.
 * `existing` is the entity's live facts and edges (`predicate` = the edge kind).
 */
export type IdentityMatch = 'agrees' | 'contradicts' | 'unrelated';

export function compareIdentity(
  incoming: ReadonlyArray<string>,
  existing: ReadonlyArray<{ predicate: string; object: string }>,
): IdentityMatch {
  const mine = byClass(
    incoming.map(parseFactLine).filter((f): f is { predicate: string; object: string } => !!f),
  );
  const theirs = byClass(existing);
  let clash = false;
  for (const [cls, values] of mine) {
    const held = theirs.get(cls);
    if (!held) continue;
    if (values.some((v) => held.some((h) => valuesAgree(v, h)))) return 'agrees';
    clash = true;
  }
  return clash ? 'contradicts' : 'unrelated';
}
