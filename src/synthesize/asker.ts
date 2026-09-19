/**
 * Who is asking.
 *
 * A request's `userId` scopes what the answer plane may read; it also
 * names a person — the user whose memory this is — and that person has
 * an entity in the memory (ingest/user-entity.ts) the moment they first
 * spoke in the first person. Without this line the generator and the
 * auditor read "Do I own the Riga apartment?" beside evidence filed on
 * "Sasha" and cannot join the two: the auditor's verdict on the 2026-09-18
 * stand was, verbatim, "evidence attributes ownership to Sasha, not to
 * the user". The generator, the auditor and the L3 round all read the
 * same asker, so the question, the answer and its audit agree on who
 * "I" and "you" are — evidence parity, like Today.
 *
 * Pure module.
 */
export interface Asker {
  /** The asker's entity name as the memory holds it (the userId until named). */
  name: string;
}

/** The generator's line: resolve the first person, answer in the second. */
export function askerGeneratorLine(asker: Asker | undefined): string {
  if (!asker) return '';
  return (
    `Asker: "${asker.name}" — the person asking. First-person references in the query ` +
    `("I", "me", "my", "mine") are this person; evidence about "${asker.name}" is evidence ` +
    `about the asker. Address them in the second person ("you", "your").\n`
  );
}

/** The auditor's line: the query's first person and the answer's second person are the asker. */
export function askerVerifierLine(asker: Asker | undefined): string {
  if (!asker) return '';
  return (
    `Asker: "${asker.name}" — the query's first person ("I", "me", "my") and the answer's ` +
    `second person ("you", "your") denote this person; evidence about "${asker.name}" ` +
    `supports claims about the asker.\n`
  );
}
