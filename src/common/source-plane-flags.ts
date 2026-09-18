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

/**
 * Per-connector switch — SOURCE_KIND_<KIND> (e.g. SOURCE_KIND_FS). The
 * master alone enables no connector: a kind that is off is "not
 * installed" to the engine (a connection of it records a failed run,
 * never runs). Read at call time.
 */
export function sourceKindEnabled(kind: string): boolean {
  return envFlagEnabled(process.env[`SOURCE_KIND_${kind.toUpperCase()}`]);
}

/**
 * The `fs` connector's root jail — SOURCE_FS_ROOTS: a `:`-separated list
 * of absolute directories a connection's `config.root` must resolve
 * inside. Unset ⇒ NO root is permitted (fail closed): brain's own
 * process reading arbitrary paths on the host is exactly the capability
 * an operator must grant by name.
 */
export function sourceFsRoots(): string[] {
  const raw = process.env.SOURCE_FS_ROOTS;
  if (raw === undefined) return [];
  return raw
    .split(':')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/**
 * SOURCE_EGRESS_ALLOW_PRIVATE — the operator half of a DOUBLE opt-in for
 * reaching loopback / private / link-local hosts from the network
 * connectors (url, s3 endpoint, webdav, mcp/http). The other half is the
 * connection's own `config.allowPrivate: true`. Either alone changes
 * nothing: a self-hosted wiki on the LAN is a legitimate source, but the
 * SSRF fence must be lowered by the operator who owns the network AND
 * named on the connection that needs it — never by a pack, never by a
 * caller.
 */
export function sourceEgressAllowPrivate(): boolean {
  return envFlagEnabled(process.env.SOURCE_EGRESS_ALLOW_PRIVATE);
}

/**
 * SOURCE_OAUTH_CLIENT — the brain as an outbound OAuth client (W4): the
 * connected-accounts surface (`/v1/admin/source-connections/oauth/*`)
 * and the public callback answer, grants can be made and refreshed,
 * and the cloud connectors (gdrive, onedrive, dropbox) can run. Off
 * (default) ⇒ the routes answer 404, no grant is ever created or
 * refreshed, no provider is ever contacted — byte-identical. Needs
 * SOURCE_CREDENTIAL_ENCRYPTION_KEY as well: a refresh token is never stored in
 * the clear, so without the key the client refuses to start. Read at
 * call time.
 */
export function sourceOAuthClientEnabled(): boolean {
  return envFlagEnabled(process.env.SOURCE_OAUTH_CLIENT);
}

/**
 * SOURCE_MAPPING_ASSISTANT — the model half of the mapping assistant
 * (W4.2b′): with it, `POST /v1/admin/source-connections/assist` sends
 * the API digest and the heuristic proposal to the model
 * (MAPPING_ASSISTANT_MODEL) for a refined `rest_records` config.
 * Off (default) ⇒ the deterministic proposal only — no model is ever
 * called by the assistant; the endpoint and the preview work the same.
 */
export function sourceMappingAssistantEnabled(): boolean {
  return envFlagEnabled(process.env.SOURCE_MAPPING_ASSISTANT);
}

/**
 * SOURCE_OAUTH_REDIRECT_URL — the callback URL registered at the
 * providers, when it is not `<public base>/v1/source-connections/oauth/
 * callback` as the admin's request reached the brain (a path prefix at
 * the edge, a canonical host). Unset ⇒ derived per request.
 */
export function sourceOAuthRedirectUrl(): string | null {
  const raw = process.env.SOURCE_OAUTH_REDIRECT_URL?.trim();
  return raw ? raw : null;
}
