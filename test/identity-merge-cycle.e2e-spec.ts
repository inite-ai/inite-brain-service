/**
 * identity_of merge cycle-guard. Survivor resolution is single-hop, so a
 * mutual A↔B identity_of would leave BOTH entities with mergedInto set — and
 * both then vanish from retrieval (`WHERE mergedInto IS NONE`). The ingest
 * link path must reject a self-merge and any link that would close a cycle.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('identity_of merge cycle-guard', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const src = { vertical: 'rent' };

  beforeAll(async () => {
    f = await createApp();
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('allows a first identity_of merge, then rejects the reverse (cycle)', async () => {
    const a = { vertical: 'rent', id: 'merge_a' };
    const b = { vertical: 'rent', id: 'merge_b' };

    const first = await f.http
      .post('/v1/ingest/link')
      .set(auth())
      .send({ from: a, to: b, kind: 'identity_of', source: src });
    expect(first.status).toBe(201);

    const aId = String(first.body.fromEntityId);
    const bId = String(first.body.toEntityId);

    // Reversing the declaration BY REFERENCE cannot close a cycle any more:
    // b's key now follows the merge chain to the survivor, so both ends name
    // one entity and the declaration is simply already true.
    const reverseByRef = await f.http
      .post('/v1/ingest/link')
      .set(auth())
      .send({ from: b, to: a, kind: 'identity_of', source: src });
    expect(reverseByRef.status).toBe(201);
    expect(reverseByRef.body).toMatchObject({ alreadyIdentical: true, edgeId: null });

    // Raw entity ids skip reference resolution — that is the one way left to
    // ask for a cycle, and the server-side guard still refuses it.
    const reverseByIds = await f.http
      .post('/v1/ingest/link')
      .set(auth())
      .send({
        from: { entityId: bId },
        to: { entityId: aId },
        kind: 'identity_of',
        source: src,
      });
    expect(reverseByIds.status).toBe(400);
  });

  it("after a merge, a write through the loser's key lands on the SURVIVOR", async () => {
    // The reference row keeps pointing at the entity it was created for, and
    // the merge only stamps `mergedInto`. Without following the chain every
    // later write through that key was stored on a husk that every read
    // filters out — a 201 whose fact nothing could ever serve.
    const keep = { vertical: 'rent', id: 'chain_keep' };
    const gone = { vertical: 'rent', id: 'chain_gone' };
    const merged = await f.http
      .post('/v1/ingest/link')
      .set(auth())
      .send({ from: keep, to: gone, kind: 'identity_of', source: src });
    expect(merged.status).toBe(201);
    const survivor = String(merged.body.fromEntityId);

    const later = await f.http
      .post('/v1/ingest/link')
      .set(auth())
      .send({
        from: gone,
        to: { vertical: 'rent', id: 'chain_third' },
        kind: 'related_to',
        source: src,
      });
    expect(later.status).toBe(201);
    expect(later.body.fromEntityId).toBe(survivor);
  });

  it('rejects a self-merge', async () => {
    const x = { vertical: 'rent', id: 'merge_self' };
    const res = await f.http
      .post('/v1/ingest/link')
      .set(auth())
      .send({ from: x, to: x, kind: 'identity_of', source: src });
    expect(res.status).toBe(400);
  });

  it('the same id in two verticals is two referents — the declared merge is accepted', async () => {
    // `rent/jonas` and `events/jonas` collide on a key, not on a person. When
    // the second reference adopts the first one's node, the operator's own
    // identity_of declaration comes back 400 "cannot merge an entity into
    // itself" — which is how the nightly quality eval died for a week.
    const rent = { vertical: 'rent', id: 'split_jonas' };
    const events = { vertical: 'events', id: 'split_jonas' };
    const merge = await f.http
      .post('/v1/ingest/link')
      .set(auth())
      .send({ from: rent, to: events, kind: 'identity_of', source: src });
    expect(merge.status).toBe(201);
    expect(merge.body.edgeId).toBeTruthy();
    expect(merge.body.alreadyIdentical).toBeUndefined();
    expect(merge.body.toEntityId).not.toBe(merge.body.fromEntityId);
  });

  it('an identity that ALREADY holds is a no-op, not a 400', async () => {
    // Two DIFFERENT references (a raw id and a key) naming one entity are not
    // a self-merge: the caller is declaring something already true. Refusing
    // it forces every client to pre-resolve both ends to find that out.
    const ref = { vertical: 'rent', id: 'already_one' };
    const seed = await f.http
      .post('/v1/ingest/link')
      .set(auth())
      .send({
        from: ref,
        to: { vertical: 'rent', id: 'already_two' },
        kind: 'related_to',
        source: src,
      });
    expect(seed.status).toBe(201);
    const entityId = String(seed.body.fromEntityId);

    const res = await f.http
      .post('/v1/ingest/link')
      .set(auth())
      .send({ from: { entityId }, to: ref, kind: 'identity_of', source: src });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ alreadyIdentical: true, edgeId: null });

    // No self-loop was written: the entity is not its own neighbour.
    const conns = await f.http
      .get(`/v1/entities/${encodeURIComponent(entityId)}/connections`)
      .set(auth());
    const selfEdges = ((conns.body.edges ?? []) as Array<{ from: string; to: string }>).filter(
      (e) => e.from === e.to,
    );
    expect(selfEdges).toEqual([]);
  });

  it('leaves a non-identity edge (related_to) untouched by the guard', async () => {
    const p = { vertical: 'rent', id: 'rel_p' };
    const q = { vertical: 'rent', id: 'rel_q' };
    const r1 = await f.http
      .post('/v1/ingest/link')
      .set(auth())
      .send({ from: p, to: q, kind: 'related_to', source: src });
    expect(r1.status).toBe(201);
    const r2 = await f.http
      .post('/v1/ingest/link')
      .set(auth())
      .send({ from: q, to: p, kind: 'related_to', source: src });
    expect(r2.status).toBe(201);
  });
});
