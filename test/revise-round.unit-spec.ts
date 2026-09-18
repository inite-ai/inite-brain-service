/**
 * The audit stage with the revision round (src/synthesize/revise-round.ts):
 *  - supported ⇒ the primary pair, no regeneration;
 *  - partial with named claims ⇒ ONE regeneration carrying the previous
 *    answer + the claims, then ONE re-verification; the served pair is
 *    the rewrite with its own citations and verdict;
 *  - unsupported, or partial with questionAnswered=false, or the NLI
 *    arm ⇒ no regeneration;
 *  - a rewrite identical to the original, or a failing regeneration,
 *    keeps the primary pair;
 *  - the auditor is given the same "today" as the generator.
 */
import { auditAndRevise, type AuditPorts } from '../src/synthesize/revise-round';
import type { Citation } from '../src/synthesize/fact-index';
import type { VerifierOutput } from '../src/synthesize/verifier';

jest.mock('../src/synthesize/fragment-zoom-seam', () => ({
  verifyAndZoom: jest.fn(),
}));
jest.mock('../src/synthesize/synthesize.helpers', () => {
  const actual = jest.requireActual('../src/synthesize/synthesize.helpers');
  return {
    ...actual,
    buildGeneratorArgs: jest.fn((_ctx: unknown, o: Record<string, unknown>) => ({
      query: 'q',
      factLines: o.promptFactLines,
      model: 'm',
      answerLang: null,
      revise: o.revise,
    })),
  };
});
import { verifyAndZoom } from '../src/synthesize/fragment-zoom-seam';

const verifyMock = verifyAndZoom as jest.MockedFunction<typeof verifyAndZoom>;

/** The seam's contract the mock keeps: the primary verdict is reported to onPrimaryVerdict. */
function verdicts(...outs: Array<Awaited<ReturnType<typeof verifyAndZoom>>>): void {
  const queue = [...outs];
  verifyMock.mockImplementation(async (_deps, a) => {
    const out = queue.shift() ?? outs[outs.length - 1]!;
    if ('verdict' in out) await a.onPrimaryVerdict(out.verdict);
    return out;
  });
}

function citation(id: string): Citation {
  return {
    factId: id,
    entityId: 'e',
    canonicalName: 'E',
    predicate: 'p',
    slot: 'p',
    object: 'o',
  };
}

function args(overrides: Partial<Parameters<typeof auditAndRevise>[1]> = {}) {
  const factIndex = new Map<string, Citation>([
    ['knowledge_fact:a', citation('knowledge_fact:a')],
    ['knowledge_fact:b', citation('knowledge_fact:b')],
  ]);
  return {
    ctx: {
      companyId: 'co',
      dto: { query: 'q', asOf: '2026-09-18T12:00:00Z' },
      callerScopes: [],
      profile: {
        abstentionCalibration: 'verifier',
        verifierTopicCoverage: true,
        dateContext: true,
      },
      model: 'm',
      guardrails: 'strict',
    } as never,
    lane: null,
    explain: false,
    produceArgs: {} as never,
    round: {
      results: [],
      factIndex,
      promptFactLines: ['[f1] a', '[f2] b'],
      dateMathLines: undefined,
    },
    generated: {
      answer: 'A [knowledge_fact:a] and B [knowledge_fact:b]',
      citedFactIds: ['knowledge_fact:a', 'knowledge_fact:b'],
    },
    citations: [citation('knowledge_fact:a'), citation('knowledge_fact:b')],
    decisionLog: undefined,
    collected: {
      fragmentLines: [],
      fragmentZoom: [],
      transcriptLines: [],
      insightLines: [],
      beliefLines: [],
      sceneLines: [],
      timelineEvidence: false,
    },
    decisionCtx: {} as never,
    ...overrides,
  };
}

function ports(generate: AuditPorts['generate']): AuditPorts & { focus: unknown[] } {
  const focus: unknown[] = [];
  return {
    metrics: undefined,
    logger: { warn: () => undefined },
    verifyDeps: {} as never,
    generate,
    captureFocus: async (_c, sample) => {
      focus.push(sample.verdict);
    },
    focus,
  };
}

const verdict = (
  v: VerifierOutput['verdict'],
  claims: string[] = [],
  qa?: boolean,
): VerifierOutput =>
  ({
    verdict: v,
    unsupportedClaims: claims,
    ...(qa === undefined ? {} : { questionAnswered: qa }),
  }) as VerifierOutput;

beforeEach(() => verifyMock.mockReset());

describe('auditAndRevise', () => {
  it('a supported verdict serves the primary pair without a regeneration', async () => {
    verdicts({ verdict: verdict('supported') });
    const generate = jest.fn();
    const p = ports(generate);
    const out = await auditAndRevise(p, args());
    expect('failed' in out).toBe(false);
    expect((out as { verdict: VerifierOutput }).verdict.verdict).toBe('supported');
    expect(generate).not.toHaveBeenCalled();
    expect(verifyMock).toHaveBeenCalledTimes(1);
    // The auditor sees the same today as the generator.
    expect(verifyMock.mock.calls[0]![1]).toMatchObject({ dateContext: '2026-09-18' });
    expect(p.focus).toEqual(['supported']);
  });

  it('a partial verdict is rewritten once with the claims and re-verified; the rewrite is served', async () => {
    verdicts(
      { verdict: verdict('partial', ['«next week» is inferred'], true) },
      { verdict: verdict('supported') },
    );
    const generate: AuditPorts['generate'] = jest.fn(async (req) => {
      expect(req.revise?.unsupportedClaims).toEqual(['«next week» is inferred']);
      expect(req.revise?.answer).toContain('A [knowledge_fact:a]');
      return { answer: 'A only [knowledge_fact:a]', citedFactIds: ['knowledge_fact:a'] };
    });
    const p = ports(generate);
    const out = await auditAndRevise(p, args());
    expect(generate).toHaveBeenCalledTimes(1);
    expect(verifyMock).toHaveBeenCalledTimes(2);
    const served = out as {
      verdict: VerifierOutput;
      generated: { answer: string };
      citations: Citation[];
    };
    expect(served.verdict.verdict).toBe('supported');
    expect(served.generated.answer).toBe('A only [knowledge_fact:a]');
    expect(served.citations.map((c) => c.factId)).toEqual(['knowledge_fact:a']);
    // The re-verification audits the rewrite, not the original.
    expect(verifyMock.mock.calls[1]![1]).toMatchObject({
      generated: { answer: 'A only [knowledge_fact:a]' },
    });
    // Focus capture saw the primary verdict only.
    expect(p.focus).toEqual(['partial']);
  });

  it('a rewrite that is still partial is served as partial (the verdict layer decides)', async () => {
    verdicts(
      { verdict: verdict('partial', ['x'], true) },
      { verdict: verdict('partial', ['y'], true) },
    );
    const p = ports(async () => ({ answer: 'rewritten', citedFactIds: [] }));
    const out = (await auditAndRevise(p, args())) as {
      verdict: VerifierOutput;
      generated: { answer: string };
    };
    expect(out.verdict.unsupportedClaims).toEqual(['y']);
    expect(out.generated.answer).toBe('rewritten');
  });

  it.each([
    ['unsupported', verdict('unsupported', ['all of it'], true)],
    ['partial, question not answered', verdict('partial', ['x'], false)],
    ['partial without claims', verdict('partial', [], true)],
  ])('%s ⇒ no regeneration', async (_label, v) => {
    verdicts({ verdict: v });
    const generate = jest.fn();
    const out = await auditAndRevise(ports(generate), args());
    expect(generate).not.toHaveBeenCalled();
    expect((out as { verdict: VerifierOutput }).verdict).toBe(v);
  });

  it('the NLI arm never revises', async () => {
    verdicts({ verdict: verdict('partial', ['x'], true) });
    const generate = jest.fn();
    await auditAndRevise(
      ports(generate),
      args({
        ctx: {
          companyId: 'co',
          dto: { query: 'q' },
          callerScopes: [],
          profile: { abstentionCalibration: 'minicheck', verifierTopicCoverage: false },
          model: 'm',
          guardrails: 'lenient',
        } as never,
      }),
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it('an unchanged rewrite or a failing regeneration keeps the primary pair', async () => {
    verdicts({ verdict: verdict('partial', ['x'], true) });
    const same = await auditAndRevise(
      ports(async () => ({
        answer: 'A [knowledge_fact:a] and B [knowledge_fact:b]',
        citedFactIds: [],
      })),
      args(),
    );
    expect((same as { generated: { answer: string } }).generated.answer).toContain('and B');
    expect(verifyMock).toHaveBeenCalledTimes(1);
    const failing = await auditAndRevise(
      ports(async () => {
        throw new Error('llm down');
      }),
      args(),
    );
    expect((failing as { verdict: VerifierOutput }).verdict.verdict).toBe('partial');
  });

  it('a failed primary audit is returned as the failure', async () => {
    verifyMock.mockResolvedValueOnce({
      failed: { answer: null, reason: 'verifier_error', citations: [], results: [] },
    });
    const out = await auditAndRevise(ports(jest.fn()), args());
    expect('failed' in out).toBe(true);
  });
});
