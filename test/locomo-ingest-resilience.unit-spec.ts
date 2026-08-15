import { executeIngest, type IngestPlan, type IngestSink } from '../test/eval/locomo/ingest';

/**
 * executeIngest resilience — a transient upstream hiccup (an OpenAI
 * "Connection error" mid-extraction surfaces as a 500 to the sink) must not
 * throw away a long ingest. Each mention retries with backoff; a persistent
 * failure is dropped and reported, and the run continues.
 */
describe('executeIngest resilience', () => {
  const plan: IngestPlan = {
    speakers: [{ entityId: 's__a', name: 'A', validFrom: '2023-01-01T00:00:00Z' }],
    mentions: [
      { speakerEntityId: 's__a', speakerName: 'A', text: 'm1', validFrom: '2023-01-01T00:00:00Z', sourceMessageId: 'locomo:s:1' },
      { speakerEntityId: 's__a', speakerName: 'A', text: 'm2', validFrom: '2023-01-01T00:00:00Z', sourceMessageId: 'locomo:s:2' },
      { speakerEntityId: 's__a', speakerName: 'A', text: 'm3', validFrom: '2023-01-01T00:00:00Z', sourceMessageId: 'locomo:s:3' },
    ],
  };

  function sink(behavior: (id: string, calls: number) => void): {
    sink: IngestSink;
    counts: Record<string, number>;
  } {
    const counts: Record<string, number> = {};
    const s: IngestSink = {
      registerSpeaker: async () => {},
      ingestMention: async ({ sourceMessageId }) => {
        counts[sourceMessageId] = (counts[sourceMessageId] ?? 0) + 1;
        behavior(sourceMessageId, counts[sourceMessageId]);
      },
    };
    return { sink: s, counts };
  }

  it('retries a transient failure and ultimately succeeds (no drop)', async () => {
    // m2 fails on its first attempt, succeeds on the second.
    const { sink: s, counts } = sink((id, n) => {
      if (id === 'locomo:s:2' && n === 1) throw new Error('HTTP 500: Connection error.');
    });
    const out = await executeIngest(plan, s, { backoffMs: 1 });
    expect(out.ingested).toBe(3);
    expect(out.dropped).toEqual([]);
    expect(counts['locomo:s:2']).toBe(2); // one retry
  });

  it('drops a mention that fails every attempt, continues the rest', async () => {
    // m2 always throws; m1 and m3 must still ingest.
    const { sink: s, counts } = sink((id) => {
      if (id === 'locomo:s:2') throw new Error('HTTP 500: Internal server error');
    });
    const drops: string[] = [];
    const out = await executeIngest(plan, s, {
      retries: 3,
      backoffMs: 1,
      onDrop: ({ sourceMessageId }) => drops.push(sourceMessageId),
    });
    expect(out.ingested).toBe(2);
    expect(out.dropped.map((d) => d.sourceMessageId)).toEqual(['locomo:s:2']);
    expect(drops).toEqual(['locomo:s:2']);
    expect(counts['locomo:s:2']).toBe(3); // exhausted all attempts
    expect(counts['locomo:s:1']).toBe(1);
    expect(counts['locomo:s:3']).toBe(1);
  });

  it('concurrency>1: ingests every mention, bounds in-flight, keeps retry semantics', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const counts: Record<string, number> = {};
    const many: IngestPlan = {
      speakers: plan.speakers,
      mentions: Array.from({ length: 12 }, (_v, i) => ({
        speakerEntityId: 's__a',
        speakerName: 'A',
        text: `m${i}`,
        validFrom: '2023-01-01T00:00:00Z',
        sourceMessageId: `locomo:s:${i}`,
      })),
    };
    const s: IngestSink = {
      registerSpeaker: async () => {},
      ingestMention: async ({ sourceMessageId }) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        counts[sourceMessageId] = (counts[sourceMessageId] ?? 0) + 1;
        await new Promise((r) => setTimeout(r, 5));
        // one mention fails once then succeeds — retry must still work concurrently
        if (sourceMessageId === 'locomo:s:7' && counts[sourceMessageId] === 1) {
          inFlight--;
          throw new Error('HTTP 500: transient');
        }
        inFlight--;
      },
    };
    const out = await executeIngest(many, s, { concurrency: 4, backoffMs: 1 });
    expect(out.ingested).toBe(12);
    expect(out.dropped).toEqual([]);
    expect(counts['locomo:s:7']).toBe(2); // retried
    expect(maxInFlight).toBeGreaterThan(1); // actually ran concurrently
    expect(maxInFlight).toBeLessThanOrEqual(4); // bounded
  });

  it('back-compat: a bare companyId string still works', async () => {
    const seen: (string | undefined)[] = [];
    const s: IngestSink = {
      registerSpeaker: async ({ companyId }) => {
        seen.push(companyId);
      },
      ingestMention: async ({ companyId }) => {
        seen.push(companyId);
      },
    };
    const out = await executeIngest(plan, s, 'co_x');
    expect(out.ingested).toBe(3);
    expect(seen.every((c) => c === 'co_x')).toBe(true);
  });
});
