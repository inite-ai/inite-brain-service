/**
 * The fact's index text — the basis for the stored embedding vector:
 * `${predicate}: ${object}`. One builder shared by every write path
 * (mention extraction, record_fact, document candidates, the resolver),
 * so the vector basis cannot drift between them.
 */
export function factIndexText(predicate: string, object: string): string {
  return `${predicate}: ${object}`;
}
