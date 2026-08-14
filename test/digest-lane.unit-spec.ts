/**
 * V12 §2 read side — the digest lane surfaces conversation_digest rows
 * into the insight slot: world-pin gate in SQL, newest-first by
 * lastEventAt, dated render, degrade to [] on failure; the collector
 * merges digest lines AHEAD of retrieved insight lines only when the
 * profile opts in.
 */
import { DigestLaneService } from '../src/synthesize/digest-lane.service';
import { EvidenceCollectorService } from '../src/synthesize/evidence-collector.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { SearchService } from '../src/search/search.service';
import {
  resolveRetrievalProfile,
  resolveRetrievalProfileFor,
} from '../src/search/retrieval-profile';

function makeLane(
  rows: Array<Record<string, unknown>>,
  capture?: Array<{ sql: string; params?: Record<string, unknown> }>,
): DigestLaneService {
  const surreal = {
    withCompany: async (_c: string, fn: (db: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string, params?: Record<string, unknown>) => {
          capture?.push({ sql, params });
          return [rows];
        },
      }),
  } as unknown as SurrealService;
  return new DigestLaneService(surreal);
}

describe('DigestLaneService', () => {
  it('renders dated digest blocks newest-first with the world gate', async () => {
    const capture: Array<{ sql: string; params?: Record<string, unknown> }> =
      [];
    const lane = makeLane(
      [
        {
          summary: '[2026-03-12] UI wireframe done. [2026-03-15] API wired.',
          lastEventAt: new Date('2026-03-15T18:00:00Z'),
        },
      ],
      capture,
    );
    const lines = await lane.digestLines({ companyId: 'c1' });
    expect(lines).toEqual([
      'Conversation record (through 2026-03-15):\n[2026-03-12] UI wireframe done. [2026-03-15] API wired.',
    ]);
    // No registry pin in this fixture → the legacy-namespace gate.
    expect(capture[0].sql).toContain('derivedVersion IS NONE');
    expect(capture[0].sql).toContain('ORDER BY lastEventAt DESC');
  });

  it('drops empty summaries and degrades to [] on failure', async () => {
    const lane = makeLane([
      { summary: '   ', lastEventAt: '2026-03-15T18:00:00Z' },
    ]);
    await expect(lane.digestLines({ companyId: 'c1' })).resolves.toEqual([]);
    const broken = new DigestLaneService({
      withCompany: async () => {
        throw new Error('db down');
      },
    } as unknown as SurrealService);
    await expect(broken.digestLines({ companyId: 'c1' })).resolves.toEqual([]);
  });
});

describe('collector digest merge (V12 §2)', () => {
  function makeCollector(digest: string[]): EvidenceCollectorService {
    const search = {} as unknown as SearchService;
    const digestLane = {
      digestLines: async () => digest,
    } as unknown as DigestLaneService;
    return new EvidenceCollectorService(
      search,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      digestLane,
    );
  }
  const base = {
    lane: null,
    companyId: 'c1',
    query: 'Summarize the weather app project',
    callerScopes: [],
    factIds: [],
    evidence: [],
  };

  it('off → insightLines untouched; on → digest lines merge first', async () => {
    const off = await makeCollector(['DIGEST']).collect({
      ...base,
      profile: resolveRetrievalProfile({} as NodeJS.ProcessEnv),
    });
    expect(off.insightLines).toEqual([]);
    const on = await makeCollector(['DIGEST']).collect({
      ...base,
      profile: resolveRetrievalProfile({
        RETRIEVAL_DIGEST_EVIDENCE: '1',
      } as NodeJS.ProcessEnv),
    });
    expect(on.insightLines[0]).toBe('DIGEST');
  });
});

describe('RETRIEVAL_DIGEST_EVIDENCE profile point', () => {
  it('defaults off; env enables; overlays per tenant', () => {
    expect(
      resolveRetrievalProfile({} as NodeJS.ProcessEnv).digestEvidence,
    ).toBe(false);
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_DIGEST_EVIDENCE: '1',
      } as NodeJS.ProcessEnv).digestEvidence,
    ).toBe(true);
    const env = {
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        beamco: { digestEvidence: true },
      }),
    } as NodeJS.ProcessEnv;
    expect(resolveRetrievalProfileFor('beamco', env).digestEvidence).toBe(
      true,
    );
    expect(resolveRetrievalProfileFor('other', env).digestEvidence).toBe(
      false,
    );
  });
});
