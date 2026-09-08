/**
 * Unit pins for the evidence battery's PURE parts (test/eval/evidence).
 *
 * The battery itself only runs against a live stand, so nothing here
 * boots anything: this covers the pieces that decide verdicts without
 * I/O — the knob reader, the status assertions, the multi-assertion
 * collector — plus two structural invariants the battery cannot be
 * allowed to violate silently:
 *
 *   1. the fixture packs must satisfy the real `validatePack`, so a
 *      malformed manifest fails HERE rather than as an unexplained skip
 *      of every read-side check on someone's stand;
 *   2. the check table must be internally consistent (unique ids, a
 *      declared dimension, and — the honesty rule — no check may be
 *      gap-gated without saying what the gap is).
 */
import { validatePack, type DomainPackManifest } from '../src/ai/domain-packs';
import { ALL_CHECKS, CHECKS_AFTER_FORGET, CHECKS_BEFORE_FORGET } from './eval/evidence/checks';
import { Findings, expectOneOf, expectStatus, knobOn, type Ctx } from './eval/evidence/context';
import { denyPackManifest, eicarProbe, probePackManifest } from './eval/evidence/fixtures';
import { DIMENSION_LABELS, type Dimension } from './eval/evidence/types';

const ctxWith = (entries: Array<[string, string]>): Ctx =>
  ({ gates: { config: new Map(entries) } }) as unknown as Ctx;

describe('evidence battery — knob reading', () => {
  it.each([
    ['1', true],
    ['true', true],
    ['ON', true],
    ['yes', true],
    ['0', false],
    ['', false],
    ['off', false],
  ])('reads %s as %s', (value, expected) => {
    expect(knobOn(ctxWith([['EVIDENCE_QUARANTINE', value]]), 'EVIDENCE_QUARANTINE')).toBe(expected);
  });

  it('treats an absent knob as off rather than throwing', () => {
    expect(knobOn(ctxWith([]), 'EVIDENCE_RAW_READ_ENABLED')).toBe(false);
  });
});

describe('evidence battery — status assertions', () => {
  it('passes on the expected status and names it', () => {
    expect(expectStatus({ status: 404, text: '' }, 404, 'dark route')).toEqual({
      status: 'pass',
      detail: 'dark route: HTTP 404',
    });
  });

  it('fails with the observed status AND the body', () => {
    const verdict = expectStatus({ status: 500, text: 'boom' }, 400, 'empty part');
    expect(verdict.status).toBe('fail');
    expect(verdict.detail).toContain('got 500');
    expect(verdict.detail).toContain('boom');
  });

  it('accepts any member of an allowed set', () => {
    expect(expectOneOf({ status: 413, text: '' }, [400, 413], 'cap').status).toBe('pass');
    expect(expectOneOf({ status: 201, text: '' }, [400, 413], 'cap').status).toBe('fail');
  });
});

describe('evidence battery — multi-assertion collector', () => {
  it('reports every confirmation when all hold', () => {
    const f = new Findings();
    f.ok(true, 'hash matched', 'hash drifted');
    f.ok(true, 'nosniff set', 'nosniff missing');
    expect(f.verdict()).toEqual({ status: 'pass', detail: 'hash matched; nosniff set' });
  });

  it('reports ONLY the problems when something breaks', () => {
    const f = new Findings();
    f.ok(true, 'hash matched', 'hash drifted');
    f.ok(false, 'nosniff set', 'nosniff missing');
    f.ok(false, 'no-store set', 'no-store missing');
    expect(f.verdict()).toEqual({ status: 'fail', detail: 'nosniff missing; no-store missing' });
  });
});

describe('evidence battery — fixture packs', () => {
  it('the probe pack is a valid manifest that opens both gated surfaces', () => {
    const manifest = probePackManifest('evunit1') as unknown as DomainPackManifest;
    expect(() => validatePack(manifest)).not.toThrow();
    // The two declarations the battery exists to reach: a processor need
    // the platform's passthrough adapter serves, and the raw-evidence
    // capability no INSTALLABLE pack supplies (the one builtin that
    // declares it never writes the domain_pack row consent reads).
    expect(manifest.memoryModel?.processors).toEqual([
      { id: 'document_text', modality: 'document', produces: ['text'] },
    ]);
    expect(manifest.memoryModel?.rawEvidence).toEqual({ serve: true });
  });

  it('the deny pack is valid, declares an unservable need and NO raw evidence', () => {
    const manifest = denyPackManifest('evunit1') as unknown as DomainPackManifest;
    expect(() => validatePack(manifest)).not.toThrow();
    expect(manifest.memoryModel?.processors?.[0]?.produces).toEqual(['caption']);
    // Declaring rawEvidence here would silently satisfy the read-gateway
    // consent fold and make the access checks measure the wrong pack.
    expect(manifest.memoryModel?.rawEvidence).toBeUndefined();
  });

  it('the pack ids are run-scoped and snake_case', () => {
    expect(probePackManifest('evmtsfj1io').id).toBe('evev_probe_evmtsfj1io');
    expect(denyPackManifest('evmtsfj1io').id).toBe('evev_deny_evmtsfj1io');
  });

  it('the scanner probe carries the real EICAR body, run-salted in its padding', () => {
    // Reassembled at runtime on purpose (see fixtures.ts). The body must
    // be byte-exact or the probe proves nothing about whether a scanner
    // is installed; the padding must vary or a second run on the same
    // tenant collides with the first run's byteHash and gets a dedup 409
    // instead of a scan verdict.
    const body = [
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}',
      '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!',
      '$H+H*',
    ].join('');
    const probe = eicarProbe('evunit1').toString('utf8');
    expect(body).toHaveLength(68);
    expect(probe.slice(0, 68)).toBe(body);
    // The EICAR spec allows only whitespace after the body, to 128 chars.
    expect(probe.length).toBeLessThanOrEqual(128);
    expect(probe.slice(68)).toMatch(/^[ \t\r\n]*$/);
    expect(eicarProbe('evunit2').toString('utf8')).not.toBe(probe);
    expect(eicarProbe('evunit1').toString('utf8')).toBe(probe);
  });
});

describe('evidence battery — check table', () => {
  it('has unique ids across both groups', () => {
    const ids = ALL_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('splits around the erasure phase without losing a check', () => {
    expect(ALL_CHECKS).toHaveLength(CHECKS_BEFORE_FORGET.length + CHECKS_AFTER_FORGET.length);
    // Every post-erasure check must be one that READS the aftermath —
    // running any of them before the forget would measure nothing.
    expect(CHECKS_AFTER_FORGET.map((c) => c.dimension).every((d) => d === 'E7' || d === 'E8')).toBe(
      true,
    );
  });

  it('covers every declared dimension', () => {
    const covered = new Set(ALL_CHECKS.map((c) => c.dimension));
    for (const dimension of Object.keys(DIMENSION_LABELS) as Dimension[]) {
      expect(covered.has(dimension)).toBe(true);
    }
  });

  it('states an intent, and a reason for every gap gate', () => {
    for (const check of ALL_CHECKS) {
      expect(check.intent.length).toBeGreaterThan(20);
      if ('expectedUnknown' in check && check.expectedUnknown !== undefined) {
        expect(check.expectedUnknown.length).toBeGreaterThan(20);
      }
    }
  });
});
