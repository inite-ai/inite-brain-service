/**
 * Who is asking.
 *
 * A request's `userId` scopes what the answer plane may read; it also
 * names a person — the user whose memory this is — and that person has
 * an entity in the memory (ingest/user-entity.ts) the moment they first
 * spoke in the first person. In the asker's own prompts that entity is
 * "you": the fact and relation lines about it are headed "you" instead
 * of its name, so the query's first person and the evidence meet
 * structurally, whether or not the memory has learned the name yet
 * (Mem0 writes "User", Letta keeps a "human" block — the asker is a
 * role, not a string to match). Without this the auditor read "Do I own
 * the Riga apartment?" beside evidence filed on "Sasha" and rejected it:
 * "evidence attributes ownership to Sasha, not to the user" (2026-09-18).
 * The generator, the auditor and the L3 round all read the same asker —
 * evidence parity, like Today.
 *
 * Pure module.
 */
export interface Asker {
  /** The asker's own entity — the lines rendered "you". */
  entityId: string;
  /** The name the memory has learned for them; null until it has one. */
  name: string | null;
}

/** The label the asker's entity carries in their own evidence lines. */
export const ASKER_LABEL = 'you';

function knownAs(asker: Asker): string {
  return asker.name ? ` (${asker.name})` : ' (the memory has not learned their name yet)';
}

/** The generator's line: "you" is the asker; answer in the second person. */
export function askerGeneratorLine(asker: Asker | undefined): string {
  if (!asker) return '';
  return (
    `Asker: the evidence lines headed "${ASKER_LABEL}" are about the person asking${knownAs(asker)}; ` +
    `first-person references in the query ("I", "me", "my", "mine") are this person. ` +
    `Address them in the second person ("you", "your").\n`
  );
}

/** The auditor's line: the query's first person, "you" in the evidence and the answer's second person are one person. */
export function askerVerifierLine(asker: Asker | undefined): string {
  if (!asker) return '';
  return (
    `Asker: "${ASKER_LABEL}" in the evidence is the person asking${knownAs(asker)}; ` +
    `the query's first person ("I", "me", "my") and the answer's second person ("you", "your") ` +
    `denote this person, and evidence headed "${ASKER_LABEL}" supports claims about them.\n`
  );
}
