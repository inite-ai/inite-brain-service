/**
 * Pure claim parsers shared by the JWKS verifier and the RFC 7662
 * introspection client — one charset/cap policy per claim regardless of
 * which remote verifier produced the payload. Every parser is
 * drop-don't-throw: an out-of-charset entry is discarded rather than
 * failing the whole credential on an encoding quirk.
 */

type Claims = Record<string, unknown>;

// Tenant slug charset. The companyId becomes the `co_<id>` database name
// and is interpolated into record ids, so it must stay within a safe
// identifier charset (alnum / underscore / hyphen, bounded length).
export const VALID_COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/;

// Per-user memory rows store userId verbatim (option<string> column, always
// a bound query param — never interpolated), so the charset can be wider
// than companyId: did:key subjects contain ':'.
const MAX_USER_ID_LENGTH = 200;

// Defence-in-depth cap. A well-formed token carries a handful of scopes;
// an absurdly long array is malformed/hostile and we refuse to parse it.
const MAX_SCOPES = 64;

/**
 * Map token claims to the tenant (companyId) + optional end-user (userId).
 *   `org` present → user-bound token: tenant = org, end-user = sub
 *   `org` absent  → M2M token: tenant = sub, no end-user
 * Returns null when no valid tenant identity can be derived.
 */
export function resolveTokenIdentity(
  payload: Claims,
): { companyId: string; userId?: string } | null {
  const org = payload.org;
  const sub = typeof payload.sub === 'string' ? payload.sub : null;
  if (typeof org === 'string' && org.length > 0) {
    if (!VALID_COMPANY_ID.test(org)) return null;
    if (!sub || sub.length === 0 || sub.length > MAX_USER_ID_LENGTH) return null;
    return { companyId: org, userId: sub };
  }
  if (!sub || !VALID_COMPANY_ID.test(sub)) return null;
  return { companyId: sub };
}

export function extractScopes(payload: Claims): string[] {
  if (Array.isArray(payload.scopes)) {
    return payload.scopes.filter((s): s is string => typeof s === 'string').slice(0, MAX_SCOPES);
  }
  if (typeof payload.scope === 'string') {
    return payload.scope.split(/\s+/).filter(Boolean).slice(0, MAX_SCOPES);
  }
  return [];
}

/** Array-or-space-delimited string claim → string list (uncapped, unfiltered). */
function stringList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((n): n is string => typeof n === 'string');
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  return [];
}

// Policy set names live in the same identifier charset the CRUD layer
// enforces (policy-store); cap mirrors the resolver's MAX_SETS_PER_KEY.
const VALID_POLICY_NAME = /^[a-z][a-z0-9_-]{1,63}$/;
const MAX_POLICY_NAMES = 8;

/** `policy` claim → ABAC policy set names. */
export function extractPolicyNames(payload: Claims): string[] {
  return stringList(payload.policy)
    .filter((n) => VALID_POLICY_NAME.test(n))
    .slice(0, MAX_POLICY_NAMES);
}

// Pack ids share the manifest's snake_case charset (validate.ts).
const VALID_PACK_ID = /^[a-z][a-z0-9_]{1,63}$/;
const MAX_PACK_IDS = 16;

/** `packs` claim → per-pack indexer binding (ApiKeyRecord.packIds). */
export function extractPackIds(payload: Claims): string[] {
  return stringList(payload.packs)
    .filter((n) => VALID_PACK_ID.test(n))
    .slice(0, MAX_PACK_IDS);
}

// Entitlement slugs are display/tier hints, not authority — still keep the
// charset bounded so a hostile claim can't smuggle odd bytes into metrics.
const VALID_ENTITLEMENT = /^[a-z][a-z0-9_:-]{1,63}$/;
const MAX_ENTITLEMENTS = 16;

/** `entitlements` claim → plan/tier hints (throttle tiers, feature gates). */
export function extractEntitlements(payload: Claims): string[] {
  if (!Array.isArray(payload.entitlements)) return [];
  return payload.entitlements
    .filter((e): e is string => typeof e === 'string')
    .filter((e) => VALID_ENTITLEMENT.test(e))
    .slice(0, MAX_ENTITLEMENTS);
}

// OAuth client ids (dcr_<hex>, brain-landing, …) — loose but bounded.
const VALID_ACTOR_ID = /^[A-Za-z0-9:._-]{1,200}$/;

/**
 * Identity of the ACTING client (the agent), for provenance attribution
 * and per-agent policy bindings. RFC 8693 `act` wins (the party acting
 * on the subject's behalf), falling back to the RFC 9068 top-level
 * `client_id` (the client the token was issued to).
 */
export function extractActorId(payload: Claims): string | undefined {
  const act = payload.act;
  if (typeof act === 'object' && act !== null) {
    const a = act as Claims;
    const fromAct =
      (typeof a.client_id === 'string' && a.client_id) ||
      (typeof a.sub === 'string' && a.sub) ||
      undefined;
    if (fromAct && VALID_ACTOR_ID.test(fromAct)) return fromAct;
  }
  if (typeof payload.client_id === 'string' && VALID_ACTOR_ID.test(payload.client_id)) {
    return payload.client_id;
  }
  return undefined;
}

// MCP action names: brain action-registry style (snake_case, optional
// namespace separators for pack tools / REST actions).
const VALID_MCP_ACTION = /^[a-z][a-z0-9_:.-]{0,63}$/;
const MAX_MCP_ACTIONS = 64;
const MCP_DETAIL_TYPE = 'inite_mcp_resource';

function normalizeUrl(value: string): string {
  return value.replace(/\/$/, '');
}

/**
 * RFC 9396 `authorization_details` → the union of granted MCP actions.
 *
 * Fail-closed by design: when the claim carries ANY inite_mcp_resource
 * entries, the user consented to a restricted tool set — entries whose
 * `locations` don't name this deployment contribute NOTHING, so a token
 * granted for another brain yields an empty grant (all tools removed),
 * never full access. No inite_mcp_resource entries at all → undefined
 * (gate inactive, scopes/ABAC only).
 */
export function extractMcpGrantedActions(
  payload: Claims,
  deploymentUrl: string | undefined,
): string[] | undefined {
  const raw = payload.authorization_details;
  if (!Array.isArray(raw)) return undefined;
  const entries = raw.filter(
    (d): d is Claims =>
      typeof d === 'object' && d !== null && (d as Claims).type === MCP_DETAIL_TYPE,
  );
  if (entries.length === 0) return undefined;

  const here = deploymentUrl ? normalizeUrl(deploymentUrl) : undefined;
  const granted = new Set<string>();
  for (const entry of entries) {
    const locations = Array.isArray(entry.locations)
      ? entry.locations.filter((l): l is string => typeof l === 'string')
      : [];
    const applies =
      locations.length === 0 || (here !== undefined && locations.map(normalizeUrl).includes(here));
    if (!applies) continue;
    for (const action of stringList(entry.actions)) {
      if (VALID_MCP_ACTION.test(action) && granted.size < MAX_MCP_ACTIONS) {
        granted.add(action);
      }
    }
  }
  return [...granted];
}
