/**
 * Fragment zoom (FOVEA_FRAGMENT_ZOOM, MM-zoom PR3) — the pure seams +
 * the IO-injected runner with stub ports (NO paid call anywhere):
 *
 *  - selectZoomFragments: truncated-only, cited-first, rendered order,
 *    dedupe, the FRAGMENT_ZOOM_MAX_FRAGMENTS cap;
 *  - buildZoomedLines: in-place fuller-text substitution, every other
 *    line byte-identical, the stale-candidate prefix fence;
 *  - runFragmentZoom: the bounded single step — flip serves the new
 *    verdict, no-flip/skip/error return none; the re-verifier runs AT
 *    MOST ONCE; every error degrades to 'error' (fail-safe to static);
 *  - fragmentZoomMaxChars: the knob's validation envelope.
 */
import {
  buildZoomedLines,
  FRAGMENT_ZOOM_MAX_FRAGMENTS,
  runFragmentZoom,
  selectZoomFragments,
  type FragmentZoomDeps,
  type FragmentZoomOutcome,
  type ZoomCandidate,
} from '../src/synthesize/fragment-zoom';
import { fragmentZoomMaxChars } from '../src/common/fovea-flags';
import type { VerifierOutput } from '../src/synthesize/verifier';

const cand = (n: number, over: Partial<ZoomCandidate> = {}): ZoomCandidate => ({
  fragmentId: `evidence_fragment:f${n}`,
  reprId: `derived_representation:r${n}`,
  lineIndex: n,
  linePrefix: `[capability:visual] (image caption) `,
  truncated: true,
  ...over,
});

const SUPPORTED: VerifierOutput = { verdict: 'supported', unsupportedClaims: [] };
const PARTIAL: VerifierOutput = { verdict: 'partial', unsupportedClaims: ['x'] };

/** Stub deps recording every port call; reverify scripted per test. */
function stubDeps(opts: {
  fuller?: Map<string, string>;
  reverify?: VerifierOutput;
  fetchThrows?: boolean;
  reverifyThrows?: boolean;
}) {
  const calls = {
    fetches: [] as Array<{ reprIds: string[]; maxChars: number }>,
    reverifies: [] as string[][],
    outcomes: [] as FragmentZoomOutcome[],
    warns: [] as string[],
  };
  const deps: FragmentZoomDeps = {
    fetchFullerTexts: (reprIds, maxChars) => {
      calls.fetches.push({ reprIds, maxChars });
      if (opts.fetchThrows) return Promise.reject(new Error('fetch boom'));
      return Promise.resolve(opts.fuller ?? new Map());
    },
    reverify: (zoomedLines) => {
      calls.reverifies.push(zoomedLines);
      if (opts.reverifyThrows) return Promise.reject(new Error('verify boom'));
      return Promise.resolve(opts.reverify ?? SUPPORTED);
    },
    metrics: { countFragmentZoom: (outcome) => calls.outcomes.push(outcome) },
    warn: (m) => calls.warns.push(m),
  };
  return { deps, calls };
}

describe('selectZoomFragments — bounded, cited-first, truncated-only', () => {
  it('keeps only truncated candidates, in rendered order', () => {
    const picked = selectZoomFragments(
      [cand(0, { truncated: false }), cand(1), cand(2, { truncated: false }), cand(3)],
      [],
    );
    expect(picked.map((c) => c.fragmentId)).toEqual([
      'evidence_fragment:f1',
      'evidence_fragment:f3',
    ]);
  });

  it('cited fragments come FIRST, then rendered order fills the cap', () => {
    const picked = selectZoomFragments([cand(0), cand(1), cand(2)], ['evidence_fragment:f2']);
    expect(picked.map((c) => c.fragmentId)).toEqual([
      'evidence_fragment:f2',
      'evidence_fragment:f0',
    ]);
  });

  it(`caps at FRAGMENT_ZOOM_MAX_FRAGMENTS (${FRAGMENT_ZOOM_MAX_FRAGMENTS}) and dedupes by fragmentId`, () => {
    const picked = selectZoomFragments(
      [cand(0), cand(0), cand(1), cand(2), cand(3)],
      ['evidence_fragment:f0'],
    );
    expect(picked).toHaveLength(FRAGMENT_ZOOM_MAX_FRAGMENTS);
    expect(new Set(picked.map((c) => c.fragmentId)).size).toBe(FRAGMENT_ZOOM_MAX_FRAGMENTS);
  });
});

describe('buildZoomedLines — substitution fence', () => {
  const lines = ['[capability:visual] (image caption) short', 'untouched line'];

  it('replaces ONLY the candidate line, prefix preserved, others byte-identical', () => {
    const out = buildZoomedLines(lines, [
      {
        candidate: cand(0, { lineIndex: 0 }),
        fullerText: 'short plus the rest of the derived text',
      },
    ]);
    expect(out[0]).toBe(
      '[capability:visual] (image caption) short plus the rest of the derived text',
    );
    expect(out[1]).toBe(lines[1]);
    // Pure: the input array is never mutated.
    expect(lines[0]).toContain(') short');
  });

  it('a stale candidate (prefix mismatch / index out of range) leaves lines untouched', () => {
    const out = buildZoomedLines(lines, [
      { candidate: cand(0, { lineIndex: 0, linePrefix: '[capability:audio] ' }), fullerText: 'x' },
      { candidate: cand(9, { lineIndex: 9 }), fullerText: 'y' },
    ]);
    expect(out).toEqual(lines);
  });
});

describe('runFragmentZoom — the ONE bounded step', () => {
  const FULLER = 'short caption plus the tail the 600-char cap had hidden from the auditor';
  const args = (over: Partial<Parameters<typeof runFragmentZoom>[1]> = {}) => ({
    topicCoverage: false,
    fragmentLines: ['[capability:visual] (image caption) short caption'],
    candidates: [cand(0, { lineIndex: 0 })],
    citedFragmentIds: [],
    maxChars: 4000,
    ...over,
  });

  it('flip: fetches ≤2 fragments, re-verifies ONCE over the enriched line, returns the verdict', async () => {
    const { deps, calls } = stubDeps({
      fuller: new Map([['derived_representation:r0', FULLER]]),
      reverify: SUPPORTED,
    });
    const result = await runFragmentZoom(deps, args());
    expect(result.outcome).toBe('flipped');
    expect(result.verdict).toEqual(SUPPORTED);
    expect(result.zoomedCount).toBe(1);
    expect(calls.fetches).toEqual([{ reprIds: ['derived_representation:r0'], maxChars: 4000 }]);
    // Re-verify ONLY, exactly once, over the enriched evidence document.
    expect(calls.reverifies).toHaveLength(1);
    expect(calls.reverifies[0]![0]).toBe(`[capability:visual] (image caption) ${FULLER}`);
    expect(calls.outcomes).toEqual(['flipped']);
  });

  it('no flip: the still-failing re-verdict is NOT returned — the caller keeps the static path', async () => {
    const { deps, calls } = stubDeps({
      fuller: new Map([['derived_representation:r0', FULLER]]),
      reverify: PARTIAL,
    });
    const result = await runFragmentZoom(deps, args());
    expect(result.outcome).toBe('unchanged');
    expect(result.verdict).toBeUndefined();
    expect(calls.reverifies).toHaveLength(1);
    expect(calls.outcomes).toEqual(['unchanged']);
  });

  it('topic coverage: supported-but-not-answering is NOT a flip (the shared verifierPasses test)', async () => {
    const { deps } = stubDeps({
      fuller: new Map([['derived_representation:r0', FULLER]]),
      reverify: { verdict: 'supported', unsupportedClaims: [], questionAnswered: false },
    });
    const result = await runFragmentZoom(deps, args({ topicCoverage: true }));
    expect(result.outcome).toBe('unchanged');
    expect(result.verdict).toBeUndefined();
  });

  it('skip: no truncated candidate ⇒ no fetch, no re-verify', async () => {
    const { deps, calls } = stubDeps({});
    const result = await runFragmentZoom(
      deps,
      args({ candidates: [cand(0, { lineIndex: 0, truncated: false })] }),
    );
    expect(result.outcome).toBe('skipped');
    expect(calls.fetches).toHaveLength(0);
    expect(calls.reverifies).toHaveLength(0);
  });

  it('skip: fetched text no deeper than the rendered excerpt ⇒ no re-verify', async () => {
    const { deps, calls } = stubDeps({
      fuller: new Map([['derived_representation:r0', 'short']]),
    });
    const result = await runFragmentZoom(deps, args());
    expect(result.outcome).toBe('skipped');
    expect(calls.reverifies).toHaveLength(0);
  });

  it('bounded: 3 truncated candidates fetch exactly the 2-fragment cap, one re-verify', async () => {
    const { deps, calls } = stubDeps({
      fuller: new Map([
        ['derived_representation:r0', FULLER],
        ['derived_representation:r1', FULLER],
      ]),
      reverify: PARTIAL,
    });
    await runFragmentZoom(
      deps,
      args({
        fragmentLines: ['l0 short', 'l1 short', 'l2 short'],
        candidates: [
          cand(0, { lineIndex: 0, linePrefix: 'l0 ' }),
          cand(1, { lineIndex: 1, linePrefix: 'l1 ' }),
          cand(2, { lineIndex: 2, linePrefix: 'l2 ' }),
        ],
      }),
    );
    expect(calls.fetches[0]!.reprIds).toEqual([
      'derived_representation:r0',
      'derived_representation:r1',
    ]);
    expect(calls.reverifies).toHaveLength(1);
  });

  it('error in the fetch degrades to static: outcome error, warn, no verdict, no re-verify', async () => {
    const { deps, calls } = stubDeps({ fetchThrows: true });
    const result = await runFragmentZoom(deps, args());
    expect(result.outcome).toBe('error');
    expect(result.verdict).toBeUndefined();
    expect(calls.reverifies).toHaveLength(0);
    expect(calls.warns).toHaveLength(1);
    expect(calls.outcomes).toEqual(['error']);
  });

  it('error in the re-verify degrades to static too', async () => {
    const { deps, calls } = stubDeps({
      fuller: new Map([['derived_representation:r0', FULLER]]),
      reverifyThrows: true,
    });
    const result = await runFragmentZoom(deps, args());
    expect(result.outcome).toBe('error');
    expect(result.verdict).toBeUndefined();
    expect(calls.warns).toHaveLength(1);
  });
});

describe('fragmentZoomMaxChars — the knob envelope', () => {
  const KEY = 'FOVEA_FRAGMENT_ZOOM_MAX_CHARS';
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('unset/blank/invalid/out-of-range → the 4000 default; a valid int is honored', () => {
    delete process.env[KEY];
    expect(fragmentZoomMaxChars()).toBe(4000);
    process.env[KEY] = '  ';
    expect(fragmentZoomMaxChars()).toBe(4000);
    process.env[KEY] = 'nope';
    expect(fragmentZoomMaxChars()).toBe(4000);
    process.env[KEY] = '0';
    expect(fragmentZoomMaxChars()).toBe(4000);
    process.env[KEY] = '2.5';
    expect(fragmentZoomMaxChars()).toBe(4000);
    process.env[KEY] = '100001';
    expect(fragmentZoomMaxChars()).toBe(4000);
    process.env[KEY] = '8000';
    expect(fragmentZoomMaxChars()).toBe(8000);
  });
});
