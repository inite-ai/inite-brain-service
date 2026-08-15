/**
 * V11 §2 arm (b) — the local NLI abstention judge. The client contract:
 * Yes/No head parsing, explicit ctx sizing (Ollama's default silently
 * truncates 5k-token evidence bundles), throw on HTTP error or an
 * unparseable verdict (the orchestrator owns the degrade path), and the
 * verdict.ts gate treats 'minicheck' like 'verifier' for the lenient
 * decline.
 */
import { miniCheckConsistent } from '../src/synthesize/minicheck-client';
import { finalizeVerdict } from '../src/synthesize/verdict';
import { NOT_IN_MEMORY_ANSWER } from '../src/synthesize/abstention';
import {
  resolveRetrievalProfile,
  resolveRetrievalProfileFor,
} from '../src/search/retrieval-profile';

function fakeFetch(
  body: unknown,
  opts: { status?: number; captured?: unknown[] } = {},
): typeof fetch {
  return (async (_url: unknown, init?: { body?: string }) => {
    opts.captured?.push(JSON.parse(init?.body ?? '{}'));
    return {
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
}

const REQ = {
  baseUrl: 'http://127.0.0.1:11434',
  model: 'bespoke-minicheck',
  document: 'Facts:\n[f1] Alex — work: parser project',
  claim: 'Alex works on the parser project.',
};

describe('miniCheckConsistent', () => {
  it('parses a Yes head as consistent, No as inconsistent', async () => {
    await expect(
      miniCheckConsistent({ ...REQ, fetchImpl: fakeFetch({ response: 'Yes' }) }),
    ).resolves.toBe(true);
    await expect(
      miniCheckConsistent({
        ...REQ,
        fetchImpl: fakeFetch({ response: 'No.' }),
      }),
    ).resolves.toBe(false);
    await expect(
      miniCheckConsistent({
        ...REQ,
        fetchImpl: fakeFetch({ response: ' yes\n' }),
      }),
    ).resolves.toBe(true);
  });

  it('sends the trained Document/Claim prompt shape with explicit ctx', async () => {
    const captured: Array<{
      model: string;
      prompt: string;
      stream: boolean;
      options: { temperature: number; num_ctx: number };
    }> = [];
    await miniCheckConsistent({
      ...REQ,
      fetchImpl: fakeFetch({ response: 'Yes' }, { captured }),
    });
    expect(captured[0].model).toBe('bespoke-minicheck');
    expect(captured[0].prompt).toBe(
      `Document: ${REQ.document}\nClaim: ${REQ.claim}`,
    );
    expect(captured[0].stream).toBe(false);
    expect(captured[0].options.temperature).toBe(0);
    expect(captured[0].options.num_ctx).toBe(8192);
  });

  it('throws on HTTP errors and unparseable verdicts', async () => {
    await expect(
      miniCheckConsistent({
        ...REQ,
        fetchImpl: fakeFetch({}, { status: 500 }),
      }),
    ).rejects.toThrow('minicheck HTTP 500');
    await expect(
      miniCheckConsistent({
        ...REQ,
        fetchImpl: fakeFetch({ response: 'Maybe?' }),
      }),
    ).rejects.toThrow('unparseable');
  });
});

describe("finalizeVerdict under abstention='minicheck'", () => {
  const base = {
    answer: 'Alex works on the parser project.',
    citations: [],
    results: [],
    guardrails: 'lenient' as const,
    abstention: 'minicheck' as const,
  };

  it('inconsistent → the explicit lenient decline (low_coverage)', () => {
    const out = finalizeVerdict({}, { ...base, verdict: 'unsupported' });
    expect(out.answer).toBe(NOT_IN_MEMORY_ANSWER);
    expect(out.reason).toBe('low_coverage');
  });

  it('consistent → the answer passes', () => {
    const out = finalizeVerdict({}, { ...base, verdict: 'supported' });
    expect(out.answer).toBe(base.answer);
    expect(out.reason).toBeUndefined();
  });
});

describe('RETRIEVAL_ABSTENTION_CALIBRATION=minicheck profile point', () => {
  it('resolves from env and overlays per tenant', () => {
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_ABSTENTION_CALIBRATION: 'minicheck',
      } as NodeJS.ProcessEnv).abstentionCalibration,
    ).toBe('minicheck');
    const env = {
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        beamco: { abstentionCalibration: 'minicheck' },
      }),
    } as NodeJS.ProcessEnv;
    expect(
      resolveRetrievalProfileFor('beamco', env).abstentionCalibration,
    ).toBe('minicheck');
    expect(
      resolveRetrievalProfileFor('other', env).abstentionCalibration,
    ).toBe('off');
  });
});
