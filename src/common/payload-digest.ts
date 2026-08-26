import { createHash } from 'node:crypto';
import { stripUnsafeUnicode } from './text-sanitizer';

/**
 * Shared payload-digest idiom — extracted VERBATIM from
 * src/strategy/trajectory-digest.ts so the tool-observation recorder
 * (0111) can reuse it without importing anything from the strategy
 * surface (the advice/evidence wall). trajectory-digest re-exports these
 * — zero behavior change there, pinned by the strategy digest specs plus
 * the payload-digest snapshot spec.
 *
 * SECURITY POSTURE — DIGESTS, NOT RAW PAYLOADS. Tool args/results are the
 * most likely place for secrets or PII (API keys, tokens, user data). We
 * therefore NEVER store them verbatim: a digest is a short one-way
 * SHA-256 prefix over the NFC-sanitized canonical JSON of the payload.
 * The digest identifies a payload (dedup/provenance) without revealing it.
 */

/** Digest length (hex chars) — enough to identify a payload, reveals nothing. */
export const PAYLOAD_DIGEST_LEN = 16;

/**
 * Deterministic stable JSON of an arbitrary value — object keys sorted so
 * the digest is stable across key ordering. Pure; no IO.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const rec = v as Record<string, unknown>;
      return Object.keys(rec)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = rec[k];
          return acc;
        }, {});
    }
    return v as unknown;
  });
}

/**
 * One-way short digest of a payload: sanitize invisibles out of the
 * canonical JSON, then SHA-256 and truncate. A raw secret in `value`
 * never survives — only its hash prefix does.
 */
export function digestPayload(value: unknown): string {
  const canonical = stripUnsafeUnicode(stableStringify(value));
  return createHash('sha256').update(canonical).digest('hex').slice(0, PAYLOAD_DIGEST_LEN);
}
