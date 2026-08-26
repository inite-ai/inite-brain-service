/**
 * Evidence-capability verdict gate (FOVEA_EVIDENCE_CAPABILITY, 0113) —
 * unit coverage for every pure seam of the track:
 *
 *  - finalizeVerdict fourth-branch matrix: unmet → abstain under the NEW
 *    reason 'evidence_capability_unmet'; no-rule → pass; gate absent
 *    (flag off) → byte-identical verdict object;
 *  - resolveEvidenceCapability: flag gating, the max-over-citations fold,
 *    the honest v1 bound (cited capabilities are always {'text'}), and
 *    the fail-safe on registry errors;
 *  - policy threading: knowledge_predicate row → PredicateDefinition →
 *    PredicatePolicy (db-mapping round-trip, unknown values dropped);
 *  - verifier prompt composer: capabilityEvidenceLines render as their
 *    own section only when non-empty (absent → byte-identical prompt).
 */
import { finalizeVerdict } from '../src/synthesize/verdict';
import { resolveEvidenceCapability } from '../src/synthesize/answer-integrity';
import type { FinalizeContext } from '../src/synthesize/answer-integrity';
import { NOT_IN_MEMORY_ANSWER } from '../src/synthesize/abstention';
import { runVerifier, type VerifierOutput } from '../src/synthesize/verifier';
import type { Citation } from '../src/synthesize/fact-index';
import type { SearchHit } from '../src/search/search.service';
import {
  deserializeFromRow,
  serializeForInsert,
} from '../src/ai/predicate-registry-internals/db-mapping';
import type { PredicateDefinition } from '../src/ai/predicate-registry-internals/types';
import { policyFor } from '../src/ingest/conflict-resolver';
import type OpenAI from 'openai';

const cite = (predicate: string, factId = `knowledge_fact:${predicate}`): Citation => ({
  factId,
  entityId: 'knowledge_entity:e',
  canonicalName: 'ops room',
  predicate,
  object: 'the evacuation plan is pinned on the whiteboard',
});
const RESULTS: SearchHit[] = [];

interface DepsCapture {
  deps: Parameters<typeof finalizeVerdict>[0];
  synth: string[];
  capability: string[];
}
function fakeDeps(): DepsCapture {
  const synth: string[] = [];
  const capability: string[] = [];
  return {
    synth,
    capability,
    deps: {
      metrics: {
        countSynthesize: ((o: string) => synth.push(o)) as never,
        countAbstainPath: () => {},
        countPlausibilityDowngrade: () => {},
        countCitationGuardAbstain: () => {},
        countEvidenceCapability: ((o: string) => capability.push(o)) as never,
        countUngroundedDowngrade: () => {},
      },
    },
  };
}

// ── finalizeVerdict — the fourth sequential downgrade ───────────────
describe('finalizeVerdict — evidence-capability branch', () => {
  it('supported + unmet → abstains under the NEW reason, citations dropped, downgraded counted', () => {
    const { deps, synth, capability } = fakeDeps();
    const r = finalizeVerdict(deps, {
      verdict: 'supported',
      answer: 'The plan is on the whiteboard.',
      citations: [cite('whiteboard_layout')],
      results: RESULTS,
      guardrails: 'strict',
      evidenceCapabilityUnmet: true,
    });
    expect(r.answer).toBe(NOT_IN_MEMORY_ANSWER);
    expect(r.reason).toBe('evidence_capability_unmet');
    expect(r.citations).toEqual([]);
    // Outcome series stays on the stable abstain tag; the NEW series
    // carries the specific signal (the Part A/C idiom).
    expect(synth).toEqual(['low_coverage']);
    expect(capability).toEqual(['downgraded']);
  });

  it('supported + gate false → serves unchanged', () => {
    const { deps, synth, capability } = fakeDeps();
    const r = finalizeVerdict(deps, {
      verdict: 'supported',
      answer: 'A text-verifiable answer.',
      citations: [cite('status')],
      results: RESULTS,
      guardrails: 'strict',
      evidenceCapabilityUnmet: false,
    });
    expect(r.answer).toBe('A text-verifiable answer.');
    expect(r.reason).toBeUndefined();
    expect(synth).toEqual(['ok']);
    expect(capability).toEqual([]);
  });

  it('gate absent (flag off resolves to {}) → byte-identical to the reference serve', () => {
    const ref = finalizeVerdict(fakeDeps().deps, {
      verdict: 'supported',
      answer: 'A text-verifiable answer.',
      citations: [cite('status')],
      results: RESULTS,
      guardrails: 'strict',
    });
    const { deps, capability } = fakeDeps();
    const out = finalizeVerdict(deps, {
      verdict: 'supported',
      answer: 'A text-verifiable answer.',
      citations: [cite('status')],
      results: RESULTS,
      guardrails: 'strict',
      // evidenceCapabilityUnmet omitted — the flag-off shape.
    });
    expect(out).toEqual(ref);
    expect(capability).toEqual([]);
  });

  it('is the FOURTH branch: plausibility (earlier) wins and keeps ITS reason', () => {
    const { deps, capability } = fakeDeps();
    const r = finalizeVerdict(deps, {
      verdict: 'supported',
      answer: 'A distorted answer.',
      citations: [cite('whiteboard_layout')],
      results: RESULTS,
      guardrails: 'strict',
      plausibilityDowngrade: true,
      evidenceCapabilityUnmet: true,
    });
    expect(r.answer).toBe(NOT_IN_MEMORY_ANSWER);
    expect(r.reason).toBe('low_coverage');
    // The later capability branch never ran.
    expect(capability).toEqual([]);
  });
});

// ── resolveEvidenceCapability — the gate resolution ─────────────────
describe('resolveEvidenceCapability', () => {
  const SUPPORTED: VerifierOutput = { verdict: 'supported' };
  const ctx: FinalizeContext = { cache: undefined, companyId: 'co_cap' };

  function registryOf(
    byPredicate: Record<string, PredicateDefinition['requiredEvidenceCapability']>,
    calls?: string[],
  ) {
    return {
      rowPolicyLookup: async (companyId: string) => {
        calls?.push(companyId);
        return (predicate: string): PredicateDefinition => ({
          predicateId: predicate,
          displayLabel: predicate,
          description: '',
          datatype: 'string',
          semantics: 'append_only',
          decayHalfLifeDays: null,
          piiClass: 'none',
          status: 'active',
          createdBy: 'system',
          ...(byPredicate[predicate] ? { requiredEvidenceCapability: byPredicate[predicate] } : {}),
        });
      },
    };
  }

  function capDeps(
    registry: ReturnType<typeof registryOf> | undefined,
    counted: string[] = [],
    warned: string[] = [],
  ) {
    return {
      registry,
      metrics: { countEvidenceCapability: ((o: string) => counted.push(o)) as never },
      logger: { warn: (m: string) => warned.push(m) },
    };
  }

  beforeEach(() => {
    process.env.FOVEA_EVIDENCE_CAPABILITY = '1';
  });
  afterEach(() => {
    delete process.env.FOVEA_EVIDENCE_CAPABILITY;
  });

  it('flag off → {} with NO registry lookup (byte-identical)', async () => {
    delete process.env.FOVEA_EVIDENCE_CAPABILITY;
    const calls: string[] = [];
    const out = await resolveEvidenceCapability(
      capDeps(registryOf({ whiteboard_layout: 'visual' }, calls)),
      { ctx, verdict: SUPPORTED, citations: [cite('whiteboard_layout')] },
    );
    expect(out).toEqual({});
    expect(calls).toEqual([]);
  });

  it('required visual + text-only citations → unmet (the honest v1 bound: abstain-or-pass)', async () => {
    const counted: string[] = [];
    const out = await resolveEvidenceCapability(
      capDeps(registryOf({ whiteboard_layout: 'visual' }), counted),
      { ctx, verdict: SUPPORTED, citations: [cite('whiteboard_layout')] },
    );
    expect(out).toEqual({ evidenceCapabilityUnmet: true });
    expect(counted).toEqual(['checked']);
  });

  it('no rule on any cited predicate (absent = text = unconstrained) → passes', async () => {
    const counted: string[] = [];
    const out = await resolveEvidenceCapability(capDeps(registryOf({}), counted), {
      ctx,
      verdict: SUPPORTED,
      citations: [cite('status'), cite('preference')],
    });
    expect(out).toEqual({});
    expect(counted).toEqual(['checked']);
  });

  it('required = max over cited facts: one text + one visual → any non-text wins', async () => {
    const out = await resolveEvidenceCapability(
      capDeps(registryOf({ whiteboard_layout: 'visual', status: 'text' })),
      { ctx, verdict: SUPPORTED, citations: [cite('status'), cite('whiteboard_layout')] },
    );
    expect(out).toEqual({ evidenceCapabilityUnmet: true });
  });

  it('non-supported verdict / no companyId / no registry / no citations → {} without a lookup', async () => {
    const calls: string[] = [];
    const registry = registryOf({ whiteboard_layout: 'visual' }, calls);
    const partial: VerifierOutput = { verdict: 'partial' };
    expect(
      await resolveEvidenceCapability(capDeps(registry), {
        ctx,
        verdict: partial,
        citations: [cite('whiteboard_layout')],
      }),
    ).toEqual({});
    expect(
      await resolveEvidenceCapability(capDeps(registry), {
        ctx: { cache: undefined },
        verdict: SUPPORTED,
        citations: [cite('whiteboard_layout')],
      }),
    ).toEqual({});
    expect(
      await resolveEvidenceCapability(capDeps(undefined), {
        ctx,
        verdict: SUPPORTED,
        citations: [cite('whiteboard_layout')],
      }),
    ).toEqual({});
    expect(
      await resolveEvidenceCapability(capDeps(registry), {
        ctx,
        verdict: SUPPORTED,
        citations: [],
      }),
    ).toEqual({});
    expect(calls).toEqual([]);
  });

  it('registry failure FAILS SAFE to today (no gate) and warns', async () => {
    const warned: string[] = [];
    const broken = {
      rowPolicyLookup: async () => {
        throw new Error('snapshot load exploded');
      },
    };
    const out = await resolveEvidenceCapability(capDeps(broken, [], warned), {
      ctx,
      verdict: SUPPORTED,
      citations: [cite('whiteboard_layout')],
    });
    expect(out).toEqual({});
    expect(warned.join(' ')).toContain('snapshot load exploded');
  });
});

// ── policy threading: registry row → PredicatePolicy field ──────────
describe('requiredEvidenceCapability threading (0113 row → policy)', () => {
  const baseRow = {
    predicateId: 'whiteboard_layout',
    displayLabel: 'whiteboard layout',
    description: 'd',
    datatype: 'string',
    semantics: 'append_only',
    piiClass: 'none',
    status: 'active',
    createdBy: 'admin',
  };

  it('deserializeFromRow threads a valid value', () => {
    const def = deserializeFromRow({ ...baseRow, requiredEvidenceCapability: 'visual' });
    expect(def.requiredEvidenceCapability).toBe('visual');
  });

  it('deserializeFromRow drops unknown/legacy values to ABSENT (= text = unconstrained)', () => {
    expect(
      deserializeFromRow({ ...baseRow, requiredEvidenceCapability: 'hologram' })
        .requiredEvidenceCapability,
    ).toBeUndefined();
    expect(deserializeFromRow(baseRow).requiredEvidenceCapability).toBeUndefined();
  });

  it('serializeForInsert round-trips the field and OMITS it when absent (option<> NONE contract)', () => {
    const def = deserializeFromRow({ ...baseRow, requiredEvidenceCapability: 'audio' });
    expect(serializeForInsert(def)).toMatchObject({ requiredEvidenceCapability: 'audio' });
    const bare = deserializeFromRow(baseRow);
    expect('requiredEvidenceCapability' in serializeForInsert(bare)).toBe(false);
  });

  it('CORE seeds carry no value — the legacy policyFor maps them unconstrained', () => {
    expect(policyFor('status').requiredEvidenceCapability).toBeUndefined();
    expect(policyFor('preference').requiredEvidenceCapability).toBeUndefined();
  });
});

// ── verifier prompt composer: capabilityEvidenceLines section ───────
describe('buildVerifierUserMessage — capabilityEvidenceLines (seam)', () => {
  function capturingOpenAi(users: string[]): OpenAI {
    return {
      chat: {
        completions: {
          create: async (req: { messages: Array<{ role: string; content: string }> }) => {
            users.push(req.messages.find((m) => m.role === 'user')?.content ?? '');
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
                  },
                },
              ],
            };
          },
        },
      },
    } as unknown as OpenAI;
  }

  const BASE = {
    query: 'where is the evacuation plan?',
    answer: 'On the whiteboard.',
    factLines: ['[knowledge_fact:f1] ops room — whiteboard_layout: evacuation plan pinned'],
    model: 'gpt-test',
  };

  it('absent / empty → the prompt is byte-identical (no section)', async () => {
    const users: string[] = [];
    await runVerifier({ ...BASE, openai: capturingOpenAi(users) });
    await runVerifier({ ...BASE, capabilityEvidenceLines: [], openai: capturingOpenAi(users) });
    expect(users[1]).toBe(users[0]);
    expect(users[0]).not.toContain('[capability:');
  });

  it('non-empty → its own section with the [capability:<kind>] lines', async () => {
    const users: string[] = [];
    const lines = [
      '[capability:visual] whiteboard photo: evacuation plan, north stairwell circled',
    ];
    await runVerifier({ ...BASE, capabilityEvidenceLines: lines, openai: capturingOpenAi(users) });
    expect(users[0]).toContain('Non-text evidence');
    expect(users[0]).toContain(lines[0]);
    // The base sections are untouched by the addition.
    expect(users[0]).toContain('Source facts:');
  });
});
