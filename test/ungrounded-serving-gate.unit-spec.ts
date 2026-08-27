/**
 * Drift-1 strict serving (EVIDENCE_UNGROUNDED_SERVING_GATE, 0115) —
 * unit coverage for the two pure seams:
 *
 *  - finalizeVerdict FIFTH sequential downgrade: ungroundedOnlySupport →
 *    abstain under the NEW reason 'ungrounded_evidence', citations
 *    dropped, BOTH counters fired; absent/false → byte-identical serve;
 *  - resolveUngroundedSupport: flag off → {} and NO fetch; all-ungrounded
 *    → gate; mixed → absent; legacy-only (absent status) → absent; empty
 *    fetch → absent; fetch throw → absent + warn (fail-open); guards
 *    (non-supported verdict / no companyId / no port / zero citations).
 */
import { finalizeVerdict } from '../src/synthesize/verdict';
import { resolveUngroundedSupport } from '../src/synthesize/answer-integrity';
import type { FinalizeContext, GroundingFetchPort } from '../src/synthesize/answer-integrity';
import { NOT_IN_MEMORY_ANSWER } from '../src/synthesize/abstention';
import type { VerifierOutput } from '../src/synthesize/verifier';
import type { Citation } from '../src/synthesize/fact-index';
import type { SearchHit } from '../src/search/search.service';

const cite = (factId: string): Citation => ({
  factId,
  entityId: 'knowledge_entity:e',
  canonicalName: 'subject',
  predicate: 'preference',
  object: 'likes hiking',
});
const RESULTS: SearchHit[] = [];

function fakeDeps() {
  const synth: string[] = [];
  let ungrounded = 0;
  return {
    synth,
    ungroundedFired: () => ungrounded,
    deps: {
      metrics: {
        countSynthesize: ((o: string) => synth.push(o)) as never,
        countAbstainPath: () => {},
        countPlausibilityDowngrade: () => {},
        countCitationGuardAbstain: () => {},
        countEvidenceCapability: () => {},
        countUngroundedDowngrade: () => {
          ungrounded++;
        },
      },
    },
  };
}

describe('finalizeVerdict — ungrounded-support fifth branch', () => {
  it('supported + ungroundedOnlySupport → abstains under the NEW reason, both counters fired', () => {
    const { deps, synth, ungroundedFired } = fakeDeps();
    const r = finalizeVerdict(deps, {
      verdict: 'supported',
      answer: 'They like hiking.',
      citations: [cite('knowledge_fact:f1')],
      results: RESULTS,
      guardrails: 'strict',
      ungroundedOnlySupport: true,
    });
    expect(r.answer).toBe(NOT_IN_MEMORY_ANSWER);
    expect(r.reason).toBe('ungrounded_evidence');
    expect(r.citations).toEqual([]);
    // Outcome series stays on the stable abstain tag; the NEW series
    // carries the specific signal (the Part A/C idiom).
    expect(synth).toEqual(['low_coverage']);
    expect(ungroundedFired()).toBe(1);
  });

  for (const value of [undefined, false] as const) {
    it(`supported + ungroundedOnlySupport=${String(value)} → byte-identical serve`, () => {
      const { deps, synth, ungroundedFired } = fakeDeps();
      const citations = [cite('knowledge_fact:f1')];
      const r = finalizeVerdict(deps, {
        verdict: 'supported',
        answer: 'They like hiking.',
        citations,
        results: RESULTS,
        guardrails: 'strict',
        ...(value === false ? { ungroundedOnlySupport: false } : {}),
      });
      expect(r.answer).toBe('They like hiking.');
      expect(r.reason).toBeUndefined();
      expect(r.citations).toEqual(citations);
      expect(synth).toEqual(['ok']);
      expect(ungroundedFired()).toBe(0);
    });
  }

  it('the capability gate (fourth branch) outranks the ungrounded gate — its reason wins', () => {
    const { deps } = fakeDeps();
    const r = finalizeVerdict(deps, {
      verdict: 'supported',
      answer: 'x',
      citations: [cite('knowledge_fact:f1')],
      results: RESULTS,
      guardrails: 'strict',
      evidenceCapabilityUnmet: true,
      ungroundedOnlySupport: true,
    });
    expect(r.reason).toBe('evidence_capability_unmet');
  });
});

// ── resolveUngroundedSupport ────────────────────────────────────────────

const SUPPORTED = { verdict: 'supported' } as VerifierOutput;
const ctx = (companyId?: string): FinalizeContext => ({
  cache: undefined,
  ...(companyId ? { companyId } : {}),
});

function port(rows: Array<{ groundingStatus?: unknown }>) {
  const calls: Array<{ companyId: string; factIds: string[] }> = [];
  const fetch: GroundingFetchPort = async (companyId, factIds) => {
    calls.push({ companyId, factIds });
    return rows;
  };
  return { fetch, calls };
}
const warns: string[] = [];
const logger = { warn: (m: string) => warns.push(m) };

describe('resolveUngroundedSupport', () => {
  const saved = process.env.EVIDENCE_UNGROUNDED_SERVING_GATE;
  beforeEach(() => {
    warns.length = 0;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.EVIDENCE_UNGROUNDED_SERVING_GATE;
    else process.env.EVIDENCE_UNGROUNDED_SERVING_GATE = saved;
  });

  it('flag OFF (default) → {} and NO fetch', async () => {
    delete process.env.EVIDENCE_UNGROUNDED_SERVING_GATE;
    const { fetch, calls } = port([{ groundingStatus: 'ungrounded' }]);
    const out = await resolveUngroundedSupport(
      { fetchGrounding: fetch, logger },
      { ctx: ctx('co_a'), verdict: SUPPORTED, citations: [cite('knowledge_fact:f1')] },
    );
    expect(out).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it('flag ON, all cited facts ungrounded → gate fires (one batched fetch)', async () => {
    process.env.EVIDENCE_UNGROUNDED_SERVING_GATE = '1';
    const { fetch, calls } = port([
      { groundingStatus: 'ungrounded' },
      { groundingStatus: 'ungrounded' },
    ]);
    const out = await resolveUngroundedSupport(
      { fetchGrounding: fetch, logger },
      {
        ctx: ctx('co_a'),
        verdict: SUPPORTED,
        citations: [cite('knowledge_fact:f1'), cite('knowledge_fact:f2')],
      },
    );
    expect(out).toEqual({ ungroundedOnlySupport: true });
    expect(calls).toEqual([
      { companyId: 'co_a', factIds: ['knowledge_fact:f1', 'knowledge_fact:f2'] },
    ]);
  });

  it('mixed support (one grounded) → serves (absent)', async () => {
    process.env.EVIDENCE_UNGROUNDED_SERVING_GATE = '1';
    const { fetch } = port([{ groundingStatus: 'ungrounded' }, { groundingStatus: 'grounded' }]);
    const out = await resolveUngroundedSupport(
      { fetchGrounding: fetch, logger },
      {
        ctx: ctx('co_a'),
        verdict: SUPPORTED,
        citations: [cite('knowledge_fact:f1'), cite('knowledge_fact:f2')],
      },
    );
    expect(out).toEqual({});
  });

  it('legacy-only support (absent status — pre-flag rows) → serves (fail-open by design)', async () => {
    process.env.EVIDENCE_UNGROUNDED_SERVING_GATE = '1';
    const { fetch } = port([{}, {}]);
    const out = await resolveUngroundedSupport(
      { fetchGrounding: fetch, logger },
      {
        ctx: ctx('co_a'),
        verdict: SUPPORTED,
        citations: [cite('knowledge_fact:f1'), cite('knowledge_fact:f2')],
      },
    );
    expect(out).toEqual({});
  });

  it('empty fetch result (cited facts vanished) → serves', async () => {
    process.env.EVIDENCE_UNGROUNDED_SERVING_GATE = '1';
    const { fetch } = port([]);
    const out = await resolveUngroundedSupport(
      { fetchGrounding: fetch, logger },
      { ctx: ctx('co_a'), verdict: SUPPORTED, citations: [cite('knowledge_fact:f1')] },
    );
    expect(out).toEqual({});
  });

  it('fetch throw → serves + warn (fail-open)', async () => {
    process.env.EVIDENCE_UNGROUNDED_SERVING_GATE = '1';
    const fetch: GroundingFetchPort = async () => {
      throw new Error('db down');
    };
    const out = await resolveUngroundedSupport(
      { fetchGrounding: fetch, logger },
      { ctx: ctx('co_a'), verdict: SUPPORTED, citations: [cite('knowledge_fact:f1')] },
    );
    expect(out).toEqual({});
    expect(warns.some((w) => w.includes('ungrounded-support resolution failed'))).toBe(true);
  });

  it('guards: non-supported verdict / no companyId / no port / zero citations → {} without fetch', async () => {
    process.env.EVIDENCE_UNGROUNDED_SERVING_GATE = '1';
    const { fetch, calls } = port([{ groundingStatus: 'ungrounded' }]);
    const citations = [cite('knowledge_fact:f1')];
    expect(
      await resolveUngroundedSupport(
        { fetchGrounding: fetch, logger },
        { ctx: ctx('co_a'), verdict: { verdict: 'partial' } as VerifierOutput, citations },
      ),
    ).toEqual({});
    expect(
      await resolveUngroundedSupport(
        { fetchGrounding: fetch, logger },
        { ctx: ctx(), verdict: SUPPORTED, citations },
      ),
    ).toEqual({});
    expect(
      await resolveUngroundedSupport(
        { logger },
        { ctx: ctx('co_a'), verdict: SUPPORTED, citations },
      ),
    ).toEqual({});
    expect(
      await resolveUngroundedSupport(
        { fetchGrounding: fetch, logger },
        { ctx: ctx('co_a'), verdict: SUPPORTED, citations: [] },
      ),
    ).toEqual({});
    expect(calls).toHaveLength(0);
  });
});
