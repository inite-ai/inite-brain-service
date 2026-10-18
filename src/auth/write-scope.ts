/**
 * The scope an ingest writes under, for the span of one ingest (G6 step
 * 3, W5).
 *
 * `scopeForUser(userId)` is already the single place a write turns into
 * a scope — every writer in the engine calls it (documents, chunks,
 * episodes, entities, facts, scenes, segments). What it could not
 * express is a write that belongs to a GROUP rather than to one person:
 * an org connection reading a private repository writes rows that the
 * repository's members may see and nobody else.
 *
 * Rather than thread a `scope` argument through the document DTO, the
 * candidate store, the resolver and the entity upsert — five signatures
 * and a dozen call sites, each a place to forget it — the source plane
 * declares the scope ONCE around the door call and every writer below
 * picks it up. AsyncLocalStorage is the same mechanism the request
 * context already uses for the caller's identity.
 *
 * Two rules keep it from becoming a way to widen a write by accident:
 *
 *  - A personal write wins. `scopeForUser(userId)` with a userId still
 *    returns that user's tag: the ambient scope only ever fills the
 *    case that used to be tenant-global (`[]`).
 *  - It never escapes its span. An ingest that hands work to a JOB
 *    leaves this stack, and the job will see no ambient scope — so the
 *    scope has to ride on the row the job reads (the asset's meta), not
 *    on a hope that ALS survives. `sourceAssetMeta` carries it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<readonly string[]>();

/** Run `fn` with every tenant-global write inside it scoped to `scope`. */
export function runWithWriteScope<T>(scope: readonly string[], fn: () => T): T {
  if (scope.length === 0) return fn();
  return storage.run(scope, fn);
}

/** The ambient write scope, or undefined outside any declared span. */
export function ambientWriteScope(): readonly string[] | undefined {
  const scope = storage.getStore();
  return scope && scope.length > 0 ? scope : undefined;
}
