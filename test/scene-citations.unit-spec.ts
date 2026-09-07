/**
 * Scene citations (RETRIEVAL_SCENE_LANE) — the rendered-set resolver,
 * the generator affordance, and the ONE deliberate asymmetry this arm
 * carries: a scene-cited answer does NOT satisfy FOVEA_REQUIRE_CITATIONS
 * (verdict.ts whollyUncited — a gist is a summary, not the record).
 *
 * Pins:
 *   1. resolver: only RENDERED scene ids cite; unknown/hallucinated ids
 *      are dropped and counted; excerpt is the RENDERED excerpt; dedupe;
 *      cap 16; the ONE-OF invariant (sceneId and nothing else);
 *   2. affordance: schema + system prompt gain citedSceneIds ONLY when
 *      the switch is on AND scenes rendered — flag-on-with-an-empty-lane
 *      is byte-identical;
 *   3. verdict honesty: scene-only citations abstain under
 *      require-citations, and STILL ship on an answer that has other
 *      grounding; every non-scene arm keeps satisfying the guard.
 */
import type OpenAI from 'openai';
import {
  resolveSceneCitations,
  resolveAndCountSceneCitations,
  type CitableScene,
} from '../src/synthesize/scene-citations';
import { runGenerator } from '../src/synthesize/generator-client';
import { finalizeVerdict } from '../src/synthesize/verdict';
import { NOT_IN_MEMORY_ANSWER } from '../src/synthesize/abstention';
import type { Citation } from '../src/synthesize/fact-index';
import type { EvidenceCitation } from '../src/synthesize/synthesize.types';

const scene = (over: Partial<CitableScene> = {}): CitableScene => ({
  sceneId: 'memory_episode:s1',
  sceneLabel: 'lease scan intake',
  excerpt: '2026-07-01 10:00–10:01 · user, assistant · 2 turns — opens: "the lease scan"',
  occurredAt: '2026-07-01T10:00:00.000Z',
  ...over,
});

const mapOf = (...scenes: CitableScene[]) => new Map(scenes.map((s) => [s.sceneId, s]));

describe('resolveSceneCitations — the rendered-set fence', () => {
  it('cites a RENDERED scene with its rendered excerpt and start instant', () => {
    const { citations, counts } = resolveSceneCitations(['memory_episode:s1'], mapOf(scene()));
    expect(citations).toEqual([
      {
        sceneId: 'memory_episode:s1',
        excerpt: scene().excerpt,
        occurredAt: '2026-07-01T10:00:00.000Z',
      },
    ]);
    expect(counts).toEqual({ cited: 1, dropped_unknown: 0 });
  });

  it('drops an id that was never rendered (hallucination / probe) and counts it', () => {
    const { citations, counts } = resolveSceneCitations(
      ['memory_episode:not_rendered'],
      mapOf(scene()),
    );
    expect(citations).toEqual([]);
    expect(counts).toEqual({ cited: 0, dropped_unknown: 1 });
  });

  it('drops malformed entries; tolerates the {sceneId} object shape', () => {
    const { citations, counts } = resolveSceneCitations(
      [null, '', 42, { nope: 'x' }, { sceneId: 'memory_episode:s1' }],
      mapOf(scene()),
    );
    expect(citations.map((c) => c.sceneId)).toEqual(['memory_episode:s1']);
    expect(counts).toEqual({ cited: 1, dropped_unknown: 4 });
  });

  it('dedupes by sceneId and caps at 16', () => {
    const many = Array.from({ length: 20 }, (_, i) => scene({ sceneId: `memory_episode:s${i}` }));
    const { citations } = resolveSceneCitations(
      [...many.map((s) => s.sceneId), 'memory_episode:s0'],
      mapOf(...many),
    );
    expect(citations).toHaveLength(16);
    expect(new Set(citations.map((c) => c.sceneId)).size).toBe(16);
  });

  it('honours the ONE-OF invariant: no factId, episodeId, fragmentId, beliefId or capability', () => {
    const { citations } = resolveSceneCitations(['memory_episode:s1'], mapOf(scene()));
    expect(Object.keys(citations[0]!).sort()).toEqual(['excerpt', 'occurredAt', 'sceneId']);
  });

  it('omits occurredAt when the scene had no start instant', () => {
    const { citations } = resolveSceneCitations(
      ['memory_episode:s1'],
      mapOf(scene({ occurredAt: undefined })),
    );
    expect(citations[0]).toEqual({ sceneId: 'memory_episode:s1', excerpt: scene().excerpt });
  });
});

describe('resolveAndCountSceneCitations — the counting wrapper', () => {
  it('an absent fence map (lane off / nothing rendered) ⇒ [] with NO metric', () => {
    const seen: Array<[string, number | undefined]> = [];
    const metrics = { countSceneCitation: (o: string, n?: number) => seen.push([o, n]) };
    expect(
      resolveAndCountSceneCitations({
        citedSceneIds: ['memory_episode:s1'],
        scenesById: undefined,
        metrics,
      }),
    ).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('emits one increment per outcome with its count', () => {
    const seen: Array<[string, number | undefined]> = [];
    const metrics = { countSceneCitation: (o: string, n?: number) => seen.push([o, n]) };
    resolveAndCountSceneCitations({
      citedSceneIds: ['memory_episode:s1', 'memory_episode:ghost', 'memory_episode:ghost2'],
      scenesById: mapOf(scene()),
      metrics,
    });
    expect(seen.sort()).toEqual([
      ['cited', 1],
      ['dropped_unknown', 2],
    ]);
  });
});

describe('runGenerator — scene-citation affordance (RETRIEVAL_SCENE_LANE)', () => {
  function capturingOpenAi(reqs: unknown[], content: string): OpenAI {
    return {
      chat: {
        completions: {
          create: async (req: unknown) => {
            reqs.push(req);
            return { choices: [{ message: { content } }] };
          },
        },
      },
    } as unknown as OpenAI;
  }

  const CONTENT = JSON.stringify({ answer: 'The lease scan arrived.', citedFactIds: [] });
  const BASE = {
    query: 'what happened with the lease scan?',
    factLines: ['[knowledge_fact:f1] Lease — signed'],
    model: 'gpt-test',
    answerLang: null,
  };
  const LINES = ['[memory_episode:s1] (2026-07-01 10:00–10:01 UTC) gist'];

  it('lane on but EMPTY ⇒ prompt AND schema BYTE-IDENTICAL to the base call', async () => {
    const base: unknown[] = [];
    await runGenerator({ ...BASE, openai: capturingOpenAi(base, CONTENT) });
    const emptyLane: unknown[] = [];
    await runGenerator({
      ...BASE,
      sceneCitations: true,
      sceneLines: [],
      openai: capturingOpenAi(emptyLane, CONTENT),
    });
    expect(JSON.stringify(emptyLane[0])).toBe(JSON.stringify(base[0]));
    expect(JSON.stringify(base[0])).not.toContain('citedSceneIds');
    expect(JSON.stringify(base[0])).not.toContain('SCENE CITATIONS');
    expect(JSON.stringify(base[0])).not.toContain('SCENE LINES PRESERVE ABSTENTION');
  });

  it('rendered lane ⇒ the schema gains citedSceneIds (required) and the cite rule', async () => {
    const reqs: unknown[] = [];
    await runGenerator({
      ...BASE,
      sceneCitations: true,
      sceneLines: LINES,
      openai: capturingOpenAi(
        reqs,
        JSON.stringify({ answer: 'x', citedFactIds: [], citedSceneIds: [] }),
      ),
    });
    const body = JSON.stringify(reqs[0]);
    expect(body).toContain('citedSceneIds');
    expect(body).toContain('SCENE CITATIONS');
  });

  it('rendered lane (default mode) ⇒ the abstention guard mirrors the base rule VERBATIM', async () => {
    const reqs: unknown[] = [];
    await runGenerator({
      ...BASE,
      sceneCitations: true,
      sceneLines: LINES,
      openai: capturingOpenAi(
        reqs,
        JSON.stringify({ answer: 'x', citedFactIds: [], citedSceneIds: [] }),
      ),
    });
    const system = (
      reqs[0] as { messages: Array<{ role: string; content: string }> }
    ).messages.find((m) => m.role === 'system')!.content;
    expect(system).toContain('SCENE LINES PRESERVE ABSTENTION');
    expect(system).toContain(
      `If neither a scene line nor the facts answer the question, output the exact answer string "I don't have grounded evidence for that." with citedFactIds set to [].`,
    );
    expect(system).toContain('If the facts do not answer the question');
  });

  it('neverAbstain keeps its always-commit contract — NO abstention guard', async () => {
    const reqs: unknown[] = [];
    await runGenerator({
      ...BASE,
      neverAbstain: true,
      sceneCitations: true,
      sceneLines: LINES,
      openai: capturingOpenAi(
        reqs,
        JSON.stringify({ answer: 'x', citedFactIds: [], citedSceneIds: [] }),
      ),
    });
    const system = (
      reqs[0] as { messages: Array<{ role: string; content: string }> }
    ).messages.find((m) => m.role === 'system')!.content;
    expect(system).not.toContain('SCENE LINES PRESERVE ABSTENTION');
    expect(system).toContain('SCENE CITATIONS');
  });

  it('a non-array citedSceneIds is stripped defensively', async () => {
    const out = await runGenerator({
      ...BASE,
      sceneCitations: true,
      sceneLines: LINES,
      openai: capturingOpenAi(
        [],
        JSON.stringify({ answer: 'x', citedFactIds: [], citedSceneIds: 'memory_episode:s1' }),
      ),
    });
    expect(out.citedSceneIds).toBeUndefined();
  });
});

describe('finalizeVerdict — a scene-ONLY answer does not satisfy require-citations', () => {
  const sceneCitation: EvidenceCitation = { sceneId: 'memory_episode:s1', excerpt: 'gist' };
  const beliefCitation: EvidenceCitation = { beliefId: 'semantic_belief:b1', excerpt: 'stmt' };
  const factCitation = {
    factId: 'knowledge_fact:f1',
    predicate: 'decided',
    object: 'SurrealDB',
    canonicalName: 'inventory service',
  } as unknown as Citation;

  const serve = (args: {
    citations?: Citation[];
    evidenceCitations?: EvidenceCitation[];
    requireCitations?: boolean;
  }) =>
    finalizeVerdict(
      {},
      {
        verdict: 'supported',
        answer: 'The lease scan arrived on 1 July.',
        citations: args.citations ?? [],
        results: [],
        guardrails: 'lenient',
        requireCitations: args.requireCitations,
        evidenceCitations: args.evidenceCitations,
      },
    );

  it('scene-only citations ABSTAIN under require-citations (a gist is a summary)', () => {
    const out = serve({ evidenceCitations: [sceneCitation], requireCitations: true });
    expect(out.answer).toBe(NOT_IN_MEMORY_ANSWER);
    expect(out.reason).toBe('low_coverage');
    expect(out.evidenceCitations).toBeUndefined();
  });

  it('a belief-arm citation still satisfies the guard (the record, not a summary)', () => {
    const out = serve({ evidenceCitations: [beliefCitation], requireCitations: true });
    expect(out.reason).toBeUndefined();
    expect(out.evidenceCitations).toEqual([beliefCitation]);
  });

  it('scenes ride ALONGSIDE qualifying grounding and ship on the served answer', () => {
    const out = serve({
      citations: [factCitation],
      evidenceCitations: [sceneCitation, beliefCitation],
      requireCitations: true,
    });
    expect(out.reason).toBeUndefined();
    expect(out.evidenceCitations).toEqual([sceneCitation, beliefCitation]);
  });

  it('with require-citations OFF a scene-only answer serves, citations attached', () => {
    const out = serve({ evidenceCitations: [sceneCitation] });
    expect(out.reason).toBeUndefined();
    expect(out.evidenceCitations).toEqual([sceneCitation]);
  });

  it('the guard is byte-identical for every pre-existing arm mix (no scene arm present)', () => {
    expect(serve({ requireCitations: true }).reason).toBe('low_coverage');
    expect(serve({ citations: [factCitation], requireCitations: true }).reason).toBeUndefined();
    expect(
      serve({
        evidenceCitations: [{ episodeId: 'episode:e1', excerpt: 'q' }],
        requireCitations: true,
      }).reason,
    ).toBeUndefined();
  });
});
