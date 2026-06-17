/**
 * Diversity-bucket key for the per-entity degree boost. Two facts
 * collapse to the same key when they have the same predicate AND
 * their normalized leading 3 tokens overlap — close enough to treat
 * them as the same piece of evidence (e.g. "broken washing machine
 * in unit 4B" and "washing machine broken since Tuesday" share
 * `complained_about|broken washing machine`).
 *
 * The bound is intentionally coarse: we want to penalize obvious
 * near-duplicates from LLM-extraction noise, not finely cluster
 * facts.
 */
export function diversityKey(predicate: string, object: string): string {
  const tokens = object
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 3)
    .sort()
    .join(' ');
  return `${predicate}|${tokens}`;
}
