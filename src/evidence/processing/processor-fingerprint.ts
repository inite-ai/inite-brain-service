import { createHash } from 'node:crypto';
import type { ProcessorAdapter } from './processor-adapter';

/**
 * Pure fingerprint helpers for the processing lifecycle (0121) — the
 * #386 sceneConfigFingerprint shape: sha256 over a canonical `|`-joined
 * `key=value` string (order fixed, no JSON), truncated to a short hex
 * prefix. Only knobs that can affect output ride the string; version
 * constants ride it too, so a code bump moves the fingerprint (and the
 * idempotency key) automatically.
 */

/** 8-hex config fingerprint of one adapter (part of the run key). */
export function processorConfigFingerprint(adapter: ProcessorAdapter): string {
  const parts = [`cap=${adapter.capability}`, `ver=${adapter.version}`, ...adapter.configParts()];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 8);
}

/**
 * Deterministic processing_run record-id tail (the #92 INSERT IGNORE
 * idiom): 32 hex chars — plain hex is an unquoted-safe SurrealDB id
 * tail, so `processing_run:<tail>` needs no escaping anywhere.
 */
export function processingRunIdTail(key: {
  assetTail: string;
  fragmentTail?: string | undefined;
  capability: string;
  processorVersion: string;
  configFingerprint: string;
}): string {
  const s =
    `asset=${key.assetTail}|frag=${key.fragmentTail ?? ''}|cap=${key.capability}` +
    `|ver=${key.processorVersion}|fp=${key.configFingerprint}`;
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}
