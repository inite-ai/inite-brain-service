/**
 * The one sanitiser every `leader_lease` name built from data goes
 * through (tenant ids, database names, derive versions).
 *
 * A lease name is the key of the record `leader_lease:<name>`. The key is
 * bound with the two-argument `type::record('leader_lease', $name)`, so
 * any string is a valid key there; the sanitiser exists for what the key
 * is used FOR. Lease names are compared, logged and listed by operators,
 * and older replicas still compose `'leader_lease:' + $name` during a
 * rolling deploy — a key outside `[a-z0-9_]` meant something different to
 * each generation of SurrealDB (3.x truncated `a-b` at the minus, 4.0
 * rejects it), so two pods could believe they held different leases.
 *
 * Rule: a name that is already plain lowercase `[a-z0-9_]` (and short) is
 * returned unchanged, so every constant lease name keeps its row. Anything
 * else is folded to `[a-z0-9_]` and gets a digest of the RAW input
 * appended, so two inputs the fold maps alike (`co-a` / `co_a` / `CO_A`)
 * can never share one lease. A plain name that already ends in what looks
 * like a digest suffix is hashed too, so an unchanged name can never equal
 * a hashed one.
 */

/** Longest name returned unchanged, and the slug cap of a hashed one. */
const MAX_PLAIN = 64;
const SLUG_CAP = 48;
const PLAIN = /^[a-z0-9_]+$/;
const DIGEST_TAIL = /_[0-9a-f]{8}$/;

/**
 * 32-bit FNV-1a. A collision guard for a readable slug, NOT a security
 * primitive — deliberately not a crypto digest, because nothing about a
 * lease name needs to resist an adversary.
 */
export function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Sanitise a lease name: see the module header for the rule. */
export function leaseName(raw: string): string {
  if (PLAIN.test(raw) && raw.length <= MAX_PLAIN && !DIGEST_TAIL.test(raw)) return raw;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .slice(0, SLUG_CAP);
  return `${slug}_${fnv1a32(raw)}`;
}

/**
 * A per-tenant lease name: a code-controlled prefix (`dreams_tenant_`)
 * plus the companyId, which may carry `-` and upper case.
 */
export function tenantLeaseName(prefix: string, companyId: string): string {
  return leaseName(`${prefix}${companyId}`);
}
