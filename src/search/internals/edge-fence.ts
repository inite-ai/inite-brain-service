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
 *    `->(knowledge_edge WHERE …)` form, stand-verified on 3.2.
 *  - `allowsPeer` filters the PEER entity JS-side: edges are written
 *    without userId today, but user-scoped ENTITIES exist (user-forget
 *    deletes edges via in.userId/out.userId), so the peer row is where
 *    today's actual scope lives. Callers project `userId` into the
 *    peer and drop non-visible peers.
 *
 * Same contract as the fact lanes: caller with a userId sees
 * tenant-global + their own; caller without sees tenant-global only.
 */

export interface EdgeFence {
  /** Edge-row condition for `->(knowledge_edge WHERE <cond>)`. */
  cond: string;
  /** Bind params the condition references. */
  params: Record<string, string>;
  /** Peer-entity visibility: tenant-global always, own-scope when set. */
  allowsPeer(peerUserId: unknown): boolean;
}

export function buildEdgeFence(userId?: string): EdgeFence {
  if (userId) {
    return {
      cond: 'invalidatedAt IS NONE AND (userId IS NONE OR userId = $edgeScopeUserId)',
      params: { edgeScopeUserId: userId },
      allowsPeer: (peerUserId) => peerUserId == null || peerUserId === userId,
    };
  }
  return {
    cond: 'invalidatedAt IS NONE AND userId IS NONE',
    params: {},
    allowsPeer: (peerUserId) => peerUserId == null,
  };
}
