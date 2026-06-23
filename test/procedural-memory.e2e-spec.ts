/**
 * ProceduralMemoryService — integration smoke for the third memory tier.
 *
 * Covers the full lifecycle:
 *   - record() → row appears, embedding populated
 *   - match() → returns the right top hit (StubEmbedder gives cosine 1.0
 *     for identical text, ~0 for different), sorted by similarity DESC
 *     then priority ASC
 *   - list() → unretired entries by default, includeRetired flag works
 *   - retire() → row excluded from match/list, audit row stays
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { ProceduralMemoryService } from '../src/procedural/procedural-memory.service';

describe('ProceduralMemoryService — record / match / list / retire', () => {
  let f: AppFixture;
  let recordedId = '';

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_procmem_e2e' });
    const svc = f.app.get(ProceduralMemoryService);

    const a = await svc.record(f.companyId, {
      trigger: 'user asks about pricing',
      action: 'mention platinum tier 20% discount',
      priority: 50,
    });
    recordedId = a.procedureId;

    await svc.record(f.companyId, {
      trigger: 'user mentions cancellation',
      action: 'route to retention specialist',
      priority: 100,
    });

    await svc.record(f.companyId, {
      trigger: 'user asks about pricing',
      action: 'remind them annual is cheaper',
      priority: 200,
    });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('match returns the higher-priority procedure first when similarity ties', async () => {
    const svc = f.app.get(ProceduralMemoryService);
    const matches = await svc.match(f.companyId, {
      query: 'user asks about pricing',
      limit: 5,
    });
    // Two procedures share the trigger text; under StubEmbedder both
    // score cosine=1.0, so the priority-ASC tiebreaker picks the
    // priority=50 one before the priority=200 one.
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches[0].priority).toBe(50);
    expect(matches[0].action).toBe('mention platinum tier 20% discount');
    expect(matches[1].priority).toBe(200);
  });

  it('match excludes procedures below minSimilarity', async () => {
    const svc = f.app.get(ProceduralMemoryService);
    const matches = await svc.match(f.companyId, {
      query: 'something completely unrelated to anything recorded',
      minSimilarity: 0.5,
    });
    expect(matches).toHaveLength(0);
  });

  it('list returns unretired procedures sorted by priority ASC', async () => {
    const svc = f.app.get(ProceduralMemoryService);
    const all = await svc.list(f.companyId);
    expect(all.length).toBeGreaterThanOrEqual(3);
    const priorities = all.map((p) => p.priority);
    const sorted = [...priorities].sort((a, b) => a - b);
    expect(priorities).toEqual(sorted);
  });

  it('retire excludes the row from match + default list, but keeps the audit', async () => {
    const svc = f.app.get(ProceduralMemoryService);
    await svc.retire(f.companyId, recordedId);

    const matches = await svc.match(f.companyId, {
      query: 'user asks about pricing',
    });
    expect(matches.find((m) => m.procedureId === recordedId)).toBeUndefined();

    const live = await svc.list(f.companyId);
    expect(live.find((p) => p.procedureId === recordedId)).toBeUndefined();

    const withRetired = await svc.list(f.companyId, { includeRetired: true });
    const retired = withRetired.find((p) => p.procedureId === recordedId);
    expect(retired).toBeDefined();
    expect(retired?.retiredAt).toBeTruthy();
  });

  it('retire on already-retired or unknown row throws NotFound', async () => {
    const svc = f.app.get(ProceduralMemoryService);
    await expect(
      svc.retire(f.companyId, recordedId),
    ).rejects.toThrow(/not found/i);
    await expect(
      svc.retire(f.companyId, 'procedural_memory:does_not_exist'),
    ).rejects.toThrow(/not found/i);
  });
});
