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
  params: Record<string, string>;
  /** Peer-entity visibility: tenant-global always, own-scope when set. */
  allowsPeer(peerUserId: unknown): boolean;
}

export function buildEdgeFence(userId?: string): EdgeFence {
  if (userId) {
    const scopeCond = '(userId IS NONE OR userId = $edgeScopeUserId)';
    return {
      cond: `invalidatedAt IS NONE AND ${scopeCond}`,
      scopeCond,
      params: { edgeScopeUserId: userId },
      allowsPeer: (peerUserId) => peerUserId == null || peerUserId === userId,
    };
  }
  const scopeCond = 'userId IS NONE';
  return {
    cond: `invalidatedAt IS NONE AND ${scopeCond}`,
    scopeCond,
    params: {},
    allowsPeer: (peerUserId) => peerUserId == null,
  };
}
