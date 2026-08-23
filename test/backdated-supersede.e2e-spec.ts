/**
 * e2e regression for the BACKDATED single_active guard (migration 0043).
 *
 * Pre-0043, `$supersede = $semantics = 'single_active' OR …` was
 * unconditional: whatever fact arrived LAST won, regardless of validFrom.
 * A late-arriving fact with an OLD validFrom (batch capture replaying
 * history newest-first, any out-of-order event source) displaced the
 * standing newer decision and left it with an inverted interval
 * (validUntil = incoming.validFrom < validFrom) — invisible to every
 * asOf query.
 *
 * Post-0043 the incoming older fact is recorded as HISTORY: outcome
 * INSERTED_HISTORICAL, already-superseded, slotted before the next-newer
 * decision (validUntil = its validFrom); the active fact is untouched.
 *
 * The opposite direction (incoming NEWER, including future-dated) is
 * covered by future-supersede-gap.e2e-spec.ts.
 *
 * Dates are computed relative to now so the test never becomes a time bomb.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('backdated single_active ingest', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const DAY = 86_400_000;
  const now = Date.now();
  const oldValidFrom = new Date(now - 180 * DAY).toISOString();
  const newValidFrom = new Date(now - 30 * DAY).toISOString();
  const asOfBetween = new Date(now - 90 * DAY).toISOString();

  beforeAll(async () => {
    f = await createApp();
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('keeps the newer active fact and records the backdated one as history', async () => {
    const entity = { vertical: 'rent', id: 'backdated_customer' };

    // Anchor name for search-by-name.
    await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: entity,
        predicate: 'name',
        object: 'Backdated Customer',
        validFrom: oldValidFrom,
        source: { vertical: 'rent', eventId: 'auth.profile_created' },
        confidence: 0.95,
      });

    // B — the CURRENT value, recorded first (validFrom 30 days ago).
    const bIngest = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: entity,
        predicate: 'status',
        object: 'premium',
        validFrom: newValidFrom,
        source: { vertical: 'rent', eventId: 'auth.tier_upgraded' },
        confidence: 0.9,
      });
    expect(bIngest.body.outcome).toBe('INSERTED');
    const bFactId = bIngest.body.factId as string;

    // A — arrives LATE with an OLDER validFrom (out-of-order replay).
    // Pre-0043 this displaced B; now it slots in as history.
    const aIngest = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: entity,
        predicate: 'status',
        object: 'trial',
        validFrom: oldValidFrom,
        source: { vertical: 'rent', eventId: 'auth.signup' },
        confidence: 0.9,
      });
    expect(aIngest.body.outcome).toBe('INSERTED_HISTORICAL');
    expect(aIngest.body.reason).toBe('backdated');
    expect(String(aIngest.body.supersededByFactId)).toBe(bFactId);

    // Default search NOW: B still holds — the backdated arrival must not
    // have displaced it (the pre-fix bug returned 'trial' here and hid
    // 'premium' behind an inverted interval).
    const nowSearch = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'Backdated Customer status', limit: 5 });
    expect(nowSearch.status).toBe(201);
    const nowObjects = nowSearch.body.results
      .flatMap((r: any) => r.facts)
      .map((x: any) => x.object as string);
    expect(nowObjects).toContain('premium');
    expect(nowObjects).not.toContain('trial');

    // asOf BETWEEN the two validFroms: the historical value was in force.
    const betweenSearch = await f.http.post('/v1/search').set(auth()).send({
      query: 'Backdated Customer status',
      limit: 5,
      asOf: asOfBetween,
    });
    expect(betweenSearch.status).toBe(201);
    const betweenObjects = betweenSearch.body.results
      .flatMap((r: any) => r.facts)
      .map((x: any) => x.object as string);
    expect(betweenObjects).toContain('trial');
    expect(betweenObjects).not.toContain('premium');
  });

  it('same-instant re-decide still supersedes (guard is strictly >)', async () => {
    const entity = { vertical: 'rent', id: 'backdated_same_instant' };
    const ts = new Date(now - 10 * DAY).toISOString();

    const first = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: entity,
        predicate: 'status',
        object: 'v1',
        validFrom: ts,
        source: { vertical: 'rent', eventId: 'auth.decide' },
        confidence: 0.9,
      });
    expect(first.body.outcome).toBe('INSERTED');

    const second = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: entity,
        predicate: 'status',
        object: 'v2',
        validFrom: ts,
        source: { vertical: 'rent', eventId: 'auth.redecide' },
        confidence: 0.9,
      });
    expect(second.body.outcome).toBe('SUPERSEDED');
    expect(second.body.supersededFactIds).toContain(first.body.factId);
  });
});
