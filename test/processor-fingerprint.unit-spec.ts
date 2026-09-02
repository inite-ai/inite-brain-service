/**
 * Processing lifecycle (0121) — fingerprint discipline (#386 shape):
 * the config fingerprint is 8 hex chars, stable, order-fixed, moves on a
 * version bump, and ignores everything outside configParts(); the run-id
 * tail is 32 hex chars (unquoted-safe) and deterministic over the key.
 */
import type { ProcessorAdapter } from '../src/evidence/processing/processor-adapter';
import {
  processingRunIdTail,
  processorConfigFingerprint,
} from '../src/evidence/processing/processor-fingerprint';

const adapter = (over: Partial<ProcessorAdapter> = {}): ProcessorAdapter => ({
  capability: 'caption',
  version: 'stub-v1',
  configParts: () => [],
  accepts: () => true,
  process: () => Promise.resolve([]),
  ...over,
});

describe('processorConfigFingerprint', () => {
  it('is 8 lowercase hex chars and stable across calls', () => {
    const a = adapter();
    const fp = processorConfigFingerprint(a);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(processorConfigFingerprint(a)).toBe(fp);
  });

  it('moves on a version bump (a code bump forks the idempotency key)', () => {
    expect(processorConfigFingerprint(adapter({ version: 'stub-v2' }))).not.toBe(
      processorConfigFingerprint(adapter()),
    );
  });

  it('moves on a config knob and is order-fixed over configParts', () => {
    const base = processorConfigFingerprint(adapter());
    const knobbed = processorConfigFingerprint(adapter({ configParts: () => ['lang=en'] }));
    expect(knobbed).not.toBe(base);
    const ab = processorConfigFingerprint(adapter({ configParts: () => ['a=1', 'b=2'] }));
    const ba = processorConfigFingerprint(adapter({ configParts: () => ['b=2', 'a=1'] }));
    expect(ab).not.toBe(ba); // canonical order is the ADAPTER's job — the fp is order-faithful
  });

  it('ignores non-config surface (accepts/process do not ride the string)', () => {
    const noisy = adapter({ accepts: () => false, process: () => Promise.reject(new Error('x')) });
    expect(processorConfigFingerprint(noisy)).toBe(processorConfigFingerprint(adapter()));
  });
});

describe('processingRunIdTail', () => {
  const key = {
    assetTail: 'abc123',
    capability: 'caption',
    processorVersion: 'stub-v1',
    configFingerprint: 'deadbeef',
  };

  it('is 32 lowercase hex chars (plain hex = unquoted-safe record tail)', () => {
    expect(processingRunIdTail(key)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic over the key and forks on every component', () => {
    expect(processingRunIdTail(key)).toBe(processingRunIdTail({ ...key }));
    expect(processingRunIdTail({ ...key, assetTail: 'other' })).not.toBe(processingRunIdTail(key));
    expect(processingRunIdTail({ ...key, capability: 'ocr' })).not.toBe(processingRunIdTail(key));
    expect(processingRunIdTail({ ...key, processorVersion: 'stub-v2' })).not.toBe(
      processingRunIdTail(key),
    );
    expect(processingRunIdTail({ ...key, configFingerprint: 'feedface' })).not.toBe(
      processingRunIdTail(key),
    );
  });

  it('distinguishes an absent fragment from a fragment-level run', () => {
    expect(processingRunIdTail({ ...key, fragmentTail: 'f1' })).not.toBe(processingRunIdTail(key));
  });
});
