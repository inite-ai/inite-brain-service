/**
 * Shared policy fence for knowledge_edge reads (graph research 2026-08,
 * action 1). Before this, none of the hot-path edge queries filtered
 * `invalidatedAt` or user scope — the fence every FACT read has had
 * since 0055 simply did not exist on edge walks, so a fenced user's
 * graph structure could steer edge expansion / rerank context for
 * every other caller of the tenant.
 *
 * Two layers, because scope lives on two rows:
 *  - `cond` filters the EDGE row (`invalidatedAt IS NONE` + fail-closed
 *    user scope on edge.userId) inside the traversal step — the
 *    `->(knowledge_edge WHERE …)` form, stand-verified on 3.2. Edges
 *    carry the scope of the turn that produced them (0153: the same
 *    `userId` as its facts; unique per scope).
 *  - `allowsPeer` filters the PEER entity JS-side: a tenant-global edge
 *    may still end on a user-scoped ENTITY (the user's own node, a
 *    personal contact), and the peer row is where that scope lives.
 *    Callers project `userId` into the peer and drop non-visible peers.
 *
 * Same contract as the fact lanes: caller with a userId sees
 * tenant-global + their own; caller without sees tenant-global only.
 */

export interface EdgeFence {
  /** Edge-row condition for `->(knowledge_edge WHERE <cond>)`. */
  cond: string;
  /**
   * The scope half of `cond` alone, for readers that fence the
   * transaction-time axis themselves (an `asOf` walk keeps edges that
   * were later invalidated).
   */
  scopeCond: string;
  /** Bind params the conditions reference. */
  params: Record<string, string | Date>;
  /** Peer-entity visibility: tenant-global always, own-scope when set. */
  allowsPeer(peerUserId: unknown): boolean;
}

/**
 * `asOf` asks what held at T — VALID time, as on every fact read (0164):
 * an edge counts when `validFrom <= T < validUntil`, an unknown start
 * (validFrom NONE — a relation recorded only as having ended) or end
 * (validUntil NONE — still holds) open on that side. The knowledge-time
 * close (invalidatedAt) does not hide it: a relation that ended after T
 * held at T. Without `asOf` the fence is the current state, as before.
 */
export function buildEdgeFence(userId?: string, asOf?: string | Date): EdgeFence {
  const scoped = userId
    ? {
        scopeCond: '(userId IS NONE OR userId = $edgeScopeUserId)',
        params: { edgeScopeUserId: userId } as Record<string, string | Date>,
        allowsPeer: (peerUserId: unknown) => peerUserId == null || peerUserId === userId,
      }
    : {
        scopeCond: 'userId IS NONE',
        params: {} as Record<string, string | Date>,
        allowsPeer: (peerUserId: unknown) => peerUserId == null,
      };
  if (asOf === undefined) {
    return { ...scoped, cond: `invalidatedAt IS NONE AND ${scoped.scopeCond}` };
  }
  return {
    ...scoped,
    cond:
      '(validFrom IS NONE OR validFrom <= $edgeAsOf) AND (validUntil IS NONE OR validUntil > $edgeAsOf) AND ' +
      scoped.scopeCond,
    params: { ...scoped.params, edgeAsOf: asOf instanceof Date ? asOf : new Date(asOf) },
  };
}
