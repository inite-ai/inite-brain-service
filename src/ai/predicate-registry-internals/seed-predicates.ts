import type { Surreal } from 'surrealdb';
import type { EmbedderService } from '../embedder.service';
import type { PredicateDefinition } from './types';
import { embeddingTextFor, serializeForInsert } from './db-mapping';

/**
 * Insert any of `predicates` not already present in the tenant's
 * knowledge_predicate table (matched by predicateId), embedding their cards in
 * ONE batched call. Idempotent — existing rows (incl. admin overrides) are left
 * untouched. Shared by first-access bootstrap (core + builtin packs) and
 * runtime Domain Pack install (a pack's namespaced predicates), so both paths
 * seed identically. Returns the number of rows created.
 */
export async function seedMissingPredicates(opts: {
  db: Surreal;
  predicates: PredicateDefinition[];
  embedder: EmbedderService;
  log?: (message: string) => void;
}): Promise<number> {
  const { db, predicates, embedder } = opts;
  const [existingRows] = await db.query<[Array<{ predicateId: string }>]>(
    `SELECT predicateId FROM knowledge_predicate`,
  );
  const existingIds = new Set(
    ((existingRows as Array<{ predicateId: string }>) ?? []).map(
      (r) => r.predicateId,
    ),
  );
  const missing = predicates.filter((p) => !existingIds.has(p.predicateId));
  if (missing.length === 0) return 0;

  opts.log?.(
    `Seeding ${missing.length} predicate(s): ${missing.map((p) => p.predicateId).join(', ')}`,
  );

  // Batched embed of the predicate "cards"; fall back to no-embedding inserts
  // rather than failing the whole seed on an embedder hiccup.
  let embeddings: Array<number[] | null>;
  try {
    embeddings = await embedder.embedMany(missing.map((p) => embeddingTextFor(p)));
  } catch {
    embeddings = missing.map(() => null);
  }
  for (const [i, item] of missing.entries()) {
    await db.query(`CREATE knowledge_predicate CONTENT $content`, {
      content: {
        ...serializeForInsert(item),
        ...(embeddings[i] ? { embedding: embeddings[i] } : {}),
      },
    });
  }
  return missing.length;
}
