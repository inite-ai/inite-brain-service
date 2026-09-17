import { envFlagEnabled } from './env-validation';

/**
 * Source plane master switch — SOURCE_PLANE_ENABLED
 * (docs/roadmap/raw-evidence-sources-2026-09.md, W0).
 *
 * When on: the admin surface (/v1/admin/source-connections) answers, the
 * sync engine registers its job handlers and the scheduler enqueues due
 * connections. Off (default) ⇒ the routes answer a bare 404, no handler
 * is registered, no job is ever enqueued and no connector is ever run —
 * byte-identical prod. Read at call time (runtime-mutable); the handler
 * registration happens at boot, so a flip to ON needs a restart for the
 * scheduler while the admin verbs and sync-now work immediately.
 *
 * Per-connector kind switches (SOURCE_KIND_<X>) arrive with the natives
 * in W1; the master alone enables no connector.
 */
export function sourcePlaneEnabled(): boolean {
  return envFlagEnabled(process.env.SOURCE_PLANE_ENABLED);
}
