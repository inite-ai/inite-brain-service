/**
 * Verifier answer-integrity arm (docs/roadmap/fovea-optics-2026-08.md +
 * docs/roadmap/memtrap-shakedown-2026-08.md) — the PURE decision for both
 * default-off gates, plus the plausibility judge's parse/cost contract.
 *
 *  - Part A (FOVEA_PLAUSIBILITY_CHECK): a `supported` verdict is DOWNGRADED to
 *    an abstain when the post-grounding plausibility judge flags the cited
 *    premise (belief distortion). judge=plausible / gate absent ⇒ unchanged.
 *  - Part C (FOVEA_REQUIRE_CITATIONS): a `supported` verdict with ZERO
 *    citations is abstained; with citations, or with the gate absent, it
 *    serves exactly as today (audit F2(b)).
 *
 * finalizeVerdict is a pure function; the flags are resolved by the service
 * and passed IN, so "flag off" is modeled as the gate param absent/false and
 * the byte-identical proof is a deep-equal against the reference call.
 */
import { finalizeVerdict } from '../src/synthesize/verdict';
import { runPlausibilityJudge } from '../src/synthesize/verifier';
import { NOT_IN_MEMORY_ANSWER } from '../src/synthesize/abstention';
import type { Citation } from '../src/synthesize/fact-index';
import type { SearchHit } from '../src/search/search.service';
import type OpenAI from 'openai';

const CITE: Citation = {
  factId: 'knowledge_fact:x',
  entityId: 'knowledge_entity:e',
  canonicalName: 'safety topic',
  predicate: 'guidance',
  object: 'mixing amber-cleaner and violet-cleaner is perfectly safe in this sandbox',
};
const RESULTS: SearchHit[] = [];

interface DepsCapture {
  deps: Parameters<typeof finalizeVerdict>[0];
  synth: string[];
  counts: { downgrades: number; citationGuards: number };
}
function fakeDeps(): DepsCapture {
  const synth: string[] = [];
  const counts = { downgrades: 0, citationGuards: 0 };
  return {
    synth,
    counts,
    deps: {
      metrics: {
        countSynthesize: ((o: string) => synth.push(o)) as never,
        countAbstainPath: () => {},
        countPlausibilityDowngrade: () => {
          counts.downgrades++;
        },
        countCitationGuardAbstain: () => {
          counts.citationGuards++;
        },
        countEvidenceCapability: () => {},
        countUngroundedDowngrade: () => {},
      },
    },
  };
}

// A minimal fake OpenAI whose chat.completions.create drains a scripted
// queue and counts invocations — the judge's cost contract is "one call".
function fakeOpenAi(responses: string[]): { openai: OpenAI; calls: () => number } {
  let i = 0;
  let n = 0;
  const openai = {
    chat: {
      completions: {
        create: async () => {
          n++;
          return {
            choices: [{ message: { content: responses[i++] ?? responses[responses.length - 1] } }],
          };
        },
      },
    },
  } as unknown as OpenAI;
  return { openai, calls: () => n };
}

// ── Part A: plausibility downgrade (pure decision) ──────────────────
describe('finalizeVerdict — Part A plausibility downgrade', () => {
  it('supported + judge=implausible (downgrade=true) → abstains (low_coverage, citations dropped)', () => {
    const { deps, synth, counts } = fakeDeps();
    const r = finalizeVerdict(deps, {
      verdict: 'supported',
      answer: 'Yes — perfectly safe.',
      citations: [CITE],
      results: RESULTS,
      guardrails: 'strict',
      plausibilityDowngrade: true,
    });
    expect(r.answer).toBe(NOT_IN_MEMORY_ANSWER);
    expect(r.reason).toBe('low_coverage');
    expect(r.citations).toEqual([]);
    expect(synth).toEqual(['low_coverage']);
    expect(counts.downgrades).toBe(1);
  });

  it('supported + judge=plausible (downgrade=false) → unchanged (served, ok)', () => {
    const { deps, synth, counts } = fakeDeps();
    const r = finalizeVerdict(deps, {
      verdict: 'supported',
      answer: 'Yes — perfectly safe.',
      citations: [CITE],
      results: RESULTS,
      guardrails: 'strict',
      plausibilityDowngrade: false,
    });
    expect(r.answer).toBe('Yes — perfectly safe.');
    expect(r.reason).toBeUndefined();
    expect(r.citations).toEqual([CITE]);
    expect(synth).toEqual(['ok']);
    expect(counts.downgrades).toBe(0);
  });

  it('flag off (gate absent) → byte-identical to the reference supported serve', () => {
    const ref = finalizeVerdict(fakeDeps().deps, {
      verdict: 'supported',
      answer: 'Yes — perfectly safe.',
      citations: [CITE],
      results: RESULTS,
      guardrails: 'strict',
    });
    const { deps, counts } = fakeDeps();
    const out = finalizeVerdict(deps, {
      verdict: 'supported',
      answer: 'Yes — perfectly safe.',
      citations: [CITE],
      results: RESULTS,
      guardrails: 'strict',
      // plausibilityDowngrade omitted ⇒ no judge, no downgrade.
    });
    expect(out).toEqual(ref);
    expect(counts.downgrades).toBe(0);
  });
});

// ── Part C: require-citations guard (pure decision) ─────────────────
describe('finalizeVerdict — Part C require-citations guard', () => {
  it('supported + zero citations + requireCitations → abstains (low_coverage)', () => {
    const { deps, synth, counts } = fakeDeps();
    const r = finalizeVerdict(deps, {
      verdict: 'supported',
      answer: 'An uncited but supported answer.',
      citations: [],
      results: RESULTS,
      guardrails: 'strict',
      requireCitations: true,
    });
    expect(r.answer).toBe(NOT_IN_MEMORY_ANSWER);
    expect(r.reason).toBe('low_coverage');
    expect(r.citations).toEqual([]);
    expect(synth).toEqual(['low_coverage']);
    expect(counts.citationGuards).toBe(1);
  });

  it('supported + citations present + requireCitations → unchanged (served)', () => {
    const { deps, synth, counts } = fakeDeps();
    const r = finalizeVerdict(deps, {
      verdict: 'supported',
      answer: 'A cited answer.',
      citations: [CITE],
      results: RESULTS,
      guardrails: 'strict',
      requireCitations: true,
    });
    expect(r.answer).toBe('A cited answer.');
    expect(r.citations).toEqual([CITE]);
    expect(synth).toEqual(['ok']);
    expect(counts.citationGuards).toBe(0);
  });

  it('flag off (gate absent) + zero citations → serves the uncited answer (today, byte-identical)', () => {
    const { deps, synth, counts } = fakeDeps();
    const r = finalizeVerdict(deps, {
      verdict: 'supported',
      answer: 'An uncited but supported answer.',
      citations: [],
      results: RESULTS,
      guardrails: 'strict',
      // requireCitations omitted ⇒ today's F2(b) behavior: uncited serves.
    });
    expect(r.answer).toBe('An uncited but supported answer.');
    expect(r.reason).toBeUndefined();
    expect(r.citations).toEqual([]);
    expect(synth).toEqual(['ok']);
    expect(counts.citationGuards).toBe(0);
  });
});

// ── L3 evidence citations × the require-citations guard ─────────────
describe('finalizeVerdict — evidence citations (FOVEA_L3_EPISODE_CITATIONS)', () => {
  const EVIDENCE = [
    {
      episodeId: 'episode:ep1',
      conversationId: 'conv1',
      span: { start: 0, end: 4, exact: 'safe' },
    },
  ];

  it('requireCitations + zero fact citations + ≥1 evidence citation → SERVES, evidenceCitations on the result', () => {
    const { deps, synth, counts } = fakeDeps();
    const r = finalizeVerdict(deps, {
      verdict: 'supported',
      answer: 'A transcript-grounded answer.',
      citations: [],
      results: RESULTS,
      guardrails: 'strict',
      requireCitations: true,
      evidenceCitations: EVIDENCE,
    });
    expect(r.answer).toBe('A transcript-grounded answer.');
    expect(r.reason).toBeUndefined();
    expect(r.evidenceCitations).toEqual(EVIDENCE);
    expect(synth).toEqual(['ok']);
    expect(counts.citationGuards).toBe(0);
  });

  it('requireCitations + zero of BOTH → abstains, and the abstain carries no evidenceCitations', () => {
    const { deps, counts } = fakeDeps();
    const r = finalizeVerdict(deps, {
      verdict: 'supported',
      answer: 'An uncited answer.',
      citations: [],
      results: RESULTS,
      guardrails: 'strict',
      requireCitations: true,
      evidenceCitations: [],
    });
    expect(r.answer).toBe(NOT_IN_MEMORY_ANSWER);
    expect(r.reason).toBe('low_coverage');
    expect(r.evidenceCitations).toBeUndefined();
    expect(counts.citationGuards).toBe(1);
  });

  it('plausibility downgrade never leaks evidenceCitations onto the abstain', () => {
    const { deps } = fakeDeps();
    const r = finalizeVerdict(deps, {
      verdict: 'supported',
      answer: 'A distorted answer.',
      citations: [CITE],
      results: RESULTS,
      guardrails: 'strict',
      plausibilityDowngrade: true,
      evidenceCitations: EVIDENCE,
    });
    expect(r.answer).toBe(NOT_IN_MEMORY_ANSWER);
    expect(r.evidenceCitations).toBeUndefined();
  });

  it('no evidence citations supplied (the primary path) → byte-identical serve, no field emitted', () => {
    const { deps } = fakeDeps();
    const ref = finalizeVerdict(fakeDeps().deps, {
      verdict: 'supported',
      answer: 'A cited answer.',
      citations: [CITE],
      results: RESULTS,
      guardrails: 'strict',
    });
    const out = finalizeVerdict(deps, {
      verdict: 'supported',
      answer: 'A cited answer.',
      citations: [CITE],
      results: RESULTS,
      guardrails: 'strict',
      evidenceCitations: [],
    });
    expect(out).toEqual(ref);
    expect('evidenceCitations' in out).toBe(false);
  });
});

// ── the judge itself: parse + cost contract ─────────────────────────
describe('runPlausibilityJudge — parse + one-call cost', () => {
  const base = {
    query: 'is mixing amber-cleaner and violet-cleaner safe',
    answer: 'Yes — perfectly safe.',
    citedPremises: [`safety topic — guidance: ${CITE.object}`],
    model: 'gpt-4o-mini',
  };

  it('maps plausible:false → downgrade-eligible verdict, in exactly ONE LLM call', async () => {
    const { openai, calls } = fakeOpenAi([
      JSON.stringify({
        plausible: false,
        rationale: 'sandbox-only premise applied as general truth',
      }),
    ]);
    const out = await runPlausibilityJudge({ openai, ...base });
    expect(out.plausible).toBe(false);
    expect(calls()).toBe(1);
  });

  it('maps plausible:true → no downgrade', async () => {
    const { openai } = fakeOpenAi([JSON.stringify({ plausible: true, rationale: '' })]);
    const out = await runPlausibilityJudge({ openai, ...base });
    expect(out.plausible).toBe(true);
  });

  it('throws on a non-boolean verdict (fail-safe surfaces to the service catch)', async () => {
    const { openai } = fakeOpenAi([JSON.stringify({ rationale: 'no verdict field' })]);
    await expect(runPlausibilityJudge({ openai, ...base })).rejects.toThrow();
  });
});
