/**
 * e2e regression for the future-dated single_active supersede "gap".
 *
 * When a single_active fact B is ingested with validFrom in the FUTURE,
 * fn::resolve_fact closes the prior A at A.validUntil = B.validFrom (future)
 * and marks A 'superseded'. Between now and B.validFrom, A is still the value
 * that holds — its interval [validFrom, validUntil) contains now. The old
 * default-now filter (`status NOT IN ['superseded']`) hid A while B wasn't
 * visible yet (validFrom > now), so the entity had NO current value during
 * the gap. The where-builder fix admits a superseded fact whose validUntil is
 * still > now.
 *
 * Dates are computed relative to now so the test never becomes a time bomb.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('future-dated single_active supersede gap', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const DAY = 86_400_000;
  const now = Date.now();
  const pastValidFrom = new Date(now - 180 * DAY).toISOString();
  const futureValidFrom = new Date(now + 180 * DAY).toISOString();
  const asOfAfterTransition = new Date(now + 365 * DAY).toISOString();

  beforeAll(async () => {
    f = await createApp();
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('keeps the prior value current until a future-dated supersede takes over', async () => {
    const entity = { vertical: 'rent', id: 'future_gap_customer' };

    // Anchor name for search-by-name.
    await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: entity,
      predicate: 'name',
      object: 'Future Gap Customer',
      validFrom: pastValidFrom,
      source: { vertical: 'rent', eventId: 'auth.profile_created' },
      confidence: 0.95,
    });

    // A — the current value (validFrom in the past, open interval).
    const aIngest = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: entity,
      predicate: 'status',
      object: 'active',
      validFrom: pastValidFrom,
      source: { vertical: 'rent', eventId: 'auth.profile_active' },
      confidence: 0.9,
    });
    expect(aIngest.body.outcome).toBe('INSERTED');
    const aFactId = aIngest.body.factId as string;

    // B — a FUTURE-dated change. Supersedes A, closing A.validUntil at
    // B.validFrom (which is still in the future).
    const bIngest = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: entity,
      predicate: 'status',
      object: 'relocating',
      validFrom: futureValidFrom,
      source: { vertical: 'rent', eventId: 'auth.profile_future' },
      confidence: 0.9,
    });
    expect(bIngest.body.outcome).toBe('SUPERSEDED');
    expect(bIngest.body.supersededFactIds).toContain(aFactId);

    // Default search NOW: A still holds (the gap before B kicks in). The
    // pre-fix bug returned NEITHER value here.
    const nowSearch = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'Future Gap Customer status', limit: 5 });
    expect(nowSearch.status).toBe(201);
    const nowObjects = nowSearch.body.results
      .flatMap((r: any) => r.facts)
      .map((x: any) => x.object as string);
    expect(nowObjects).toContain('active');
    expect(nowObjects).not.toContain('relocating');

    // asOf AFTER the transition: B is the value, A has closed out.
    const futureSearch = await f.http
      .post('/v1/search')
      .set(auth())
      .send({
        query: 'Future Gap Customer status',
        limit: 5,
        asOf: asOfAfterTransition,
      });
    expect(futureSearch.status).toBe(201);
    const futureObjects = futureSearch.body.results
      .flatMap((r: any) => r.facts)
      .map((x: any) => x.object as string);
    expect(futureObjects).toContain('relocating');
    expect(futureObjects).not.toContain('active');
  });
});
