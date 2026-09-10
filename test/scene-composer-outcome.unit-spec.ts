/**
 * SceneComposerService terminal status (src/admin/scene-composer.service.ts):
 *   - a post-swap pass that throws, or reports failed scenes, DEGRADES the
 *     run — the swap stands, but the outcome says so under post-pass:<name>;
 *   - every conversation failing ⇒ `failed`, with the conversation ids as
 *     retry keys;
 *   - `conversationIds` (the retry selector) composes exactly those ids and
 *     never runs the O(all turns) enumeration.
 *
 * Collaborators are positional fakes; a conversation with no turns is a
 * clean unit (the composer counts it and touches no table), so no
 * transaction is ever issued here.
 */
import { SceneComposerService } from '../src/admin/scene-composer.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { FactEmbeddingService } from '../src/ingest/fact-embedding.service';
import type { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';
import type { ProjectionRegistryService } from '../src/episodes/projection-registry.service';
import type { SceneEnricherService } from '../src/admin/scene-enricher.service';
import type { SceneBacklinkService } from '../src/admin/scene-backlink.service';
import type { SceneEvidenceLinkerService } from '../src/admin/scene-evidence-linker.service';
import type { SceneVersionService } from '../src/admin/scene-version';
import type { SceneGistEmbeddingService } from '../src/admin/scene-gist-embedding.service';

const FLAGS = ['SCENES_SEGMENTATION_ENABLED', 'SCENES_LLM_ENRICHMENT', 'SCENES_FACT_BACKLINK'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of FLAGS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.SCENES_SEGMENTATION_ENABLED = '1';
});
afterEach(() => {
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

interface Fakes {
  /** Conversations the enumeration would return. */
  enumerated: string[];
  /** Conversations whose turn read throws (the unit failure). */
  throwing?: Record<string, string>;
  enrich?: () => Promise<{ scenes: number; enriched: number; failed: number; skipped: number }>;
  backlink?: () => Promise<{ scenes: number; factsLinked: number }>;
}

function makeComposer(f: Fakes) {
  const enumerations: number[] = [];
  const turnReads: string[] = [];
  const surreal = {
    withCompany: async <T>(_c: string, fn: (db: unknown) => Promise<T>) => fn({}),
  } as unknown as SurrealService;
  const embedding = {
    embedMany: async () => {
      throw new Error('never embeds here');
    },
  } as unknown as FactEmbeddingService;
  const episodes = {
    conversationCounts: async () => {
      enumerations.push(1);
      return f.enumerated.map((conversationId) => ({ conversationId }));
    },
    conversationTurnsRaw: async (_db: unknown, conversationId: string) => {
      turnReads.push(conversationId);
      const reason = f.throwing?.[conversationId];
      if (reason) throw new Error(reason);
      return [];
    },
  } as unknown as EpisodeReadStoreService;
  const registry = {
    begin: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
  } as unknown as ProjectionRegistryService;
  const enricher = {
    enrich: f.enrich ?? (async () => ({ scenes: 0, enriched: 0, failed: 0, skipped: 0 })),
  } as unknown as SceneEnricherService;
  const backlinker = {
    run: f.backlink ?? (async () => ({ scenes: 0, factsLinked: 0 })),
  } as unknown as SceneBacklinkService;
  const evidenceLinker = { run: async () => undefined } as unknown as SceneEvidenceLinkerService;
  const versions = {
    resolve: () => ({
      version: 'scene-segmenter-v1',
      cfg: { topicBoundary: false, minCosine: 0.5, maxTurns: 40 },
    }),
  } as unknown as SceneVersionService;
  const gistEncoder = { run: async () => undefined } as unknown as SceneGistEmbeddingService;
  const svc = new SceneComposerService(
    surreal,
    embedding,
    episodes,
    registry,
    enricher,
    backlinker,
    evidenceLinker,
    versions,
    gistEncoder,
  );
  return { svc, enumerations, turnReads };
}

describe('SceneComposerService — terminal status', () => {
  it('a clean run is complete, with one unit per conversation', async () => {
    const { svc } = makeComposer({ enumerated: ['c1', 'c2'] });
    const res = await svc.run('co_x');
    expect(res.outcome).toEqual({
      status: 'complete',
      total: 2,
      succeeded: 2,
      failed: [],
      degradedBy: [],
    });
  });

  it('a post-swap pass that THROWS degrades the run (the swap stands)', async () => {
    process.env.SCENES_LLM_ENRICHMENT = '1';
    const { svc } = makeComposer({
      enumerated: ['c1'],
      enrich: async () => {
        throw new Error('openai 429');
      },
    });
    const res = await svc.run('co_x');
    expect(res.conversations).toBe(1);
    expect(res.outcome.status).toBe('degraded');
    expect(res.outcome.failed).toEqual([]);
    expect(res.outcome.degradedBy).toEqual([{ key: 'post-pass:enrich', error: 'openai 429' }]);
  });

  it('a post-swap pass that REPORTS failed scenes degrades the run too', async () => {
    process.env.SCENES_LLM_ENRICHMENT = '1';
    process.env.SCENES_FACT_BACKLINK = '1';
    const { svc } = makeComposer({
      enumerated: ['c1'],
      enrich: async () => ({ scenes: 4, enriched: 1, failed: 3, skipped: 0 }),
    });
    const res = await svc.run('co_x');
    expect(res.enriched).toBe(1);
    expect(res.outcome.status).toBe('degraded');
    expect(res.outcome.degradedBy).toEqual([
      { key: 'post-pass:enrich', error: '3 of 4 scene(s) failed' },
    ]);
  });

  it('every conversation failing ⇒ failed, keyed by conversation id', async () => {
    const { svc } = makeComposer({
      enumerated: ['c1', 'c2'],
      throwing: { c1: 'surreal timeout', c2: 'surreal timeout' },
    });
    const res = await svc.run('co_x');
    expect(res.skipped).toHaveLength(2);
    expect(res.outcome.status).toBe('failed');
    expect(res.outcome.total).toBe(2);
    expect(res.outcome.succeeded).toBe(0);
    expect(res.outcome.failed).toEqual([
      { key: 'c1', error: 'surreal timeout' },
      { key: 'c2', error: 'surreal timeout' },
    ]);
  });

  it('some conversations failing ⇒ degraded, only the failed ones are retry keys', async () => {
    const { svc } = makeComposer({
      enumerated: ['c1', 'c2', 'c3'],
      throwing: { c2: 'boom' },
    });
    const res = await svc.run('co_x');
    expect(res.outcome.status).toBe('degraded');
    expect(res.outcome.failed.map((f) => f.key)).toEqual(['c2']);
  });

  it('retry with conversationIds composes exactly those ids and skips the enumeration', async () => {
    const { svc, enumerations, turnReads } = makeComposer({
      enumerated: ['c1', 'c2', 'c3'],
      throwing: { c2: 'boom' },
    });
    const first = await svc.run('co_x');
    const retry = await svc.run('co_x', {
      conversationIds: first.outcome.failed.map((f) => f.key),
    });
    expect(enumerations).toHaveLength(1);
    expect(turnReads.slice(3)).toEqual(['c2']);
    expect(retry.outcome).toMatchObject({ status: 'failed', total: 1, succeeded: 0 });
    expect(retry.outcome.failed).toEqual([{ key: 'c2', error: 'boom' }]);
  });

  it('with the master flag off the run is an empty complete batch', async () => {
    delete process.env.SCENES_SEGMENTATION_ENABLED;
    const { svc, enumerations } = makeComposer({ enumerated: ['c1'] });
    const res = await svc.run('co_x');
    expect(enumerations).toHaveLength(0);
    expect(res.outcome).toMatchObject({ status: 'complete', total: 0 });
  });
});
