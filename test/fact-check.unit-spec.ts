import { checkExtraction } from '../src/ai/extractor-internals/fact-check';
import { mergeExtractions } from '../src/ai/extractor-internals/merge';
import type { ExtractionResult } from '../src/ai/extractor-internals/types';
import type { DecisionService } from '../src/ai/decisions/decision.service';

/**
 * From the passes behind a confident wrong answer in production: one
 * re-roll miscounted its entity list and put "ESM-only" on "PR #666". The
 * document check must drop exactly the facts the document does not state,
 * ask about each distinct fact once, and never cost a fact when the plane
 * is unsure, off, or down.
 */
const DOC = 'Обновления @nestjs/config 12 не смерджены: библиотека ESM-only.';

function extraction(rows: Array<[string, string, string]>): ExtractionResult {
  const names = [...new Set(rows.map((r) => r[0]))];
  return {
    entities: names.map((name) => ({ name, type: 'other' as const })),
    facts: rows.map(([s, predicate, object]) => ({
      entityIndex: names.indexOf(s),
      predicate,
      object,
      confidence: 0.9,
    })),
    edges: [],
  };
}

function plane(p: Record<string, number>, opts: { enabled?: boolean; fail?: boolean } = {}) {
  const calls: Array<{ state: unknown; questions: Record<string, { instructions: string }> }> = [];
  const svc = {
    enabled: () => opts.enabled !== false,
    decide: async (_lane: string, req: (typeof calls)[number]) => {
      calls.push(req);
      if (opts.fail) return null;
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      for (const [q, body] of Object.entries(req.questions)) {
        const name = /this about «([^»]+)»/.exec(body.instructions)![1]!;
        answers[q] = { type: 'noul', noul: p[name] ?? 0.95 };
      }
      return { model: 'jev', answers, usage: { inputTokens: 1, outputTokens: 1 } };
    },
    confident: (_lane: string, a: { noul: number }) => Math.abs(a.noul - 0.5) * 2 >= 0.7,
  } as unknown as DecisionService;
  return { svc, calls };
}

const subjects = (r: ExtractionResult) =>
  r.facts.map((f) => r.entities[f.entityIndex]!.name).sort();

describe('checking an extraction against its document', () => {
  const misnumbered = () =>
    extraction([
      ['@nestjs/config', 'module_format', 'ESM-only'],
      ['PR #666', 'module_format', 'ESM-only'],
      ['@nestjs/config', 'merge_status', 'не смерджены'],
    ]);

  it('drops the facts the document confidently does not state, in one request', async () => {
    const { svc, calls } = plane({ 'PR #666': 0.03 });
    const out = await checkExtraction({ result: misnumbered(), text: DOC, decisions: svc });
    expect(subjects(out.result)).toEqual(['@nestjs/config', '@nestjs/config']);
    expect(out).toMatchObject({ asked: 3, rejected: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.state).toBe(`TEXT:\n${DOC}`);
  });

  it('reads the text with the context the extractor read — the speaker, the turns before', async () => {
    const { svc, calls } = plane({});
    await checkExtraction({
      result: misnumbered(),
      text: 'я его вернул',
      context: 'Speaker: Sasha\nEarlier: Sasha signed up for a standing desk trial.',
      decisions: svc,
    });
    expect(calls[0]!.state).toEqual([
      'CONTEXT:\nSpeaker: Sasha\nEarlier: Sasha signed up for a standing desk trial.',
      'TEXT:\nя его вернул',
    ]);
  });

  it('asks about a fact the passes repeated only once', async () => {
    const twice = extraction([
      ['@nestjs/config', 'module_format', 'ESM-only'],
      ['@nestjs/config', 'module_format', 'ESM-only'],
    ]);
    const { svc, calls } = plane({});
    const out = await checkExtraction({ result: twice, text: DOC, decisions: svc });
    expect(Object.keys(calls[0]!.questions)).toHaveLength(1);
    expect(out.result.facts).toHaveLength(2);
  });

  it('keeps a fact the plane is unsure about', async () => {
    const { svc } = plane({ 'PR #666': 0.25 });
    const out = await checkExtraction({ result: misnumbered(), text: DOC, decisions: svc });
    expect(out.rejected).toBe(0);
  });

  it('keeps everything with the lane off, and when the call fails', async () => {
    const off = plane({ 'PR #666': 0.01 }, { enabled: false });
    const a = await checkExtraction({ result: misnumbered(), text: DOC, decisions: off.svc });
    expect(a).toMatchObject({ asked: 0, rejected: 0 });
    expect(off.calls).toHaveLength(0);
    const down = plane({ 'PR #666': 0.01 }, { fail: true });
    const b = await checkExtraction({ result: misnumbered(), text: DOC, decisions: down.svc });
    expect(b.result.facts).toHaveLength(3);
  });

  it('keeps everything when no plane is wired at all', async () => {
    const out = await checkExtraction({ result: misnumbered(), text: DOC, decisions: undefined });
    expect(out.result.facts).toHaveLength(3);
  });
});

describe('self-consistency passes merge an entity by name', () => {
  const typed = (type: 'asset' | 'other'): ExtractionResult => ({
    entities: [{ name: '@nestjs/config', type }],
    facts: [{ entityIndex: 0, predicate: 'module_format', object: 'ESM-only', confidence: 0.9 }],
    edges: [],
  });

  it('one name typed two ways by two re-rolls is one entity', () => {
    const merged = mergeExtractions([typed('asset'), typed('other')], { selfConsistency: true });
    expect(merged.entities).toEqual([{ name: '@nestjs/config', type: 'asset' }]);
    expect(merged.facts).toHaveLength(1);
  });

  it('facet passes still tell the types apart', () => {
    const merged = mergeExtractions([typed('asset'), typed('other')]);
    expect(merged.entities).toHaveLength(2);
  });

  it('checks relations too: a pair the text does not relate is dropped in the same request', async () => {
    const calls: Array<{ questions: Record<string, { instructions: string }> }> = [];
    const svc = {
      enabled: () => true,
      decide: async (_lane: string, req: (typeof calls)[number]) => {
        calls.push(req);
        const answers: Record<string, { type: 'noul'; noul: number }> = {};
        for (const [q, body] of Object.entries(req.questions)) {
          answers[q] = { type: 'noul', noul: body.instructions.includes('made by') ? 0.04 : 0.96 };
        }
        return { model: 'jev', answers };
      },
      confident: (_lane: string, a: { noul: number }) => Math.abs(a.noul - 0.5) * 2 >= 0.7,
    } as unknown as DecisionService;
    const result: ExtractionResult = {
      entities: [
        { name: 'Jev', type: 'other' },
        { name: 'OpenRouter', type: 'other' },
        { name: 'TypeSafe', type: 'other' },
      ],
      facts: [],
      edges: [
        { fromEntityIndex: 0, toEntityIndex: 1, kind: 'made_by', confidence: 0.8 },
        { fromEntityIndex: 0, toEntityIndex: 2, kind: 'served_via', confidence: 0.8 },
      ],
    };
    const out = await checkExtraction({
      result,
      text: 'Jev — модель TypeSafe, подключена через OpenRouter.',
      decisions: svc,
    });
    expect(calls).toHaveLength(1);
    expect(out.asked).toBe(2);
    expect(out.rejected).toBe(1);
    expect(out.result.edges.map((e) => e.kind)).toEqual(['served_via']);
    expect(out.droppedFacts).toEqual(['Jev —made_by→ OpenRouter']);
  });
});
