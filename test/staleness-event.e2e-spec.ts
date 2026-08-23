/**
 * e2e for the 0089 `fact_staleness` DEFINE EVENT — write-time derived-fact
 * staleness marking (the low-latency path in front of the nightly drain).
 *
 * Four claims, each against a real SurrealDB:
 *
 *   1. THE STORM TEST. A full derive-shaped flip — bulk-inserted staged rows
 *      (including rows BORN 'superseded'), then the real promoteStaging()
 *      (targeted shape with its superseded->active revive UPDATE, and the
 *      full-run shape with its wholesale DELETE) — triggers ZERO
 *      fn::mark_derived_stale marking. Evidence is canary-based: every storm
 *      row gets a live-world canary child whose derivedFrom points at it; if
 *      the event had fired on ANY storm row, fn::mark_derived_stale would
 *      have stamped that row's canary. All canaries staying unstamped ==
 *      zero fires.
 *
 *   2. Supersede a parent via fn::resolve_fact (real ingest route) — the
 *      dependent summary is stale IMMEDIATELY, with the drain provably
 *      never having run (no changefeed cursor row for this tenant).
 *
 *   3. Retract — both the cascade shape (POST :id/retract ->
 *      fn::cascade_retract) and the no-cascade shape (recompose
 *      retractOrphan's direct status flip) mark dependents at write time.
 *
 *   4. RECURSION. One transition on the root of a 3-level derivedFrom chain
 *      marks every level and terminates; the staleness stamping itself
 *      (staleAt/staleReason writes, status untouched) never re-fires the
 *      event; repeated transitions are idempotent.
 */
import type { Surreal } from 'surrealdb';
import { StringRecordId } from 'surrealdb';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import {
  newRunToken,
  promoteStaging,
  stagingNamespace,
} from '../src/admin/derive-staging';

const ENTITY_ID = 'knowledge_entity:staleness_evt';

describe('0089 fact_staleness event', () => {
  let f: AppFixture;
  let surreal: SurrealService;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const inDb = <T>(cb: (db: Surreal) => Promise<T>): Promise<T> =>
    surreal.withCompany(f.companyId, cb);

  const rid = (id: string) => new StringRecordId(id);

  /** Minimal SCHEMAFULL-valid knowledge_fact row for direct seeding. */
  const factRow = (
    id: string,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id: rid(id),
    entityId: rid(ENTITY_ID),
    predicate: 'e2e_staleness',
    object: `object for ${id}`,
    confidence: 0.9,
    validFrom: new Date(),
    source: { vertical: 'e2e', eventId: 'staleness.seed' },
    status: 'active',
    ...over,
  });

  const staleOf = async (ids: string[]) =>
    inDb(async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown; staleAt: unknown; staleReason: unknown }>]>(
        `SELECT id, staleAt, staleReason FROM knowledge_fact WHERE id IN $ids`,
        { ids: ids.map(rid) },
      );
      return new Map(
        ((rows as any[]) ?? []).map((r) => [String(r.id), r]),
      );
    });

  const tenantStaleCount = async (): Promise<number> =>
    inDb(async (db) => {
      const [rows] = await db.query<[Array<{ count: number }>]>(
        `SELECT count() FROM knowledge_fact WHERE staleAt IS NOT NONE GROUP ALL`,
      );
      return ((rows as any[]) ?? [])[0]?.count ?? 0;
    });

  beforeAll(async () => {
    f = await createApp();
    surreal = f.app.get(SurrealService);
    await inDb((db) =>
      db.query(
        `CREATE ${ENTITY_ID} SET type = 'other', canonicalName = 'staleness e2e'`,
      ),
    );
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  // ── 1. THE STORM TEST ────────────────────────────────────────────────
  it('a full derive-shaped flip triggers zero mark_derived_stale work', async () => {
    const FINAL = 'e2estorm';
    const ns = stagingNamespace(FINAL, newRunToken());
    const staleBefore = await tenantStaleCount();

    // Storm-row ids, chosen up front so canaries can reference them
    // BEFORE they exist (record links need no referential existence) —
    // that way even a misfire on the CREATE direction would stamp a canary.
    const convA = Array.from({ length: 40 }, (_, i) => `knowledge_fact:storm_a${i}`);
    const revivable = Array.from({ length: 20 }, (_, i) => `knowledge_fact:storm_r${i}`);
    const convB = Array.from({ length: 20 }, (_, i) => `knowledge_fact:storm_b${i}`);
    const stagedB = Array.from({ length: 80 }, (_, i) => `knowledge_fact:storm_s${i}`);
    const stagedFull = Array.from({ length: 80 }, (_, i) => `knowledge_fact:storm_f${i}`);
    const stormIds = [...convA, ...revivable, ...convB, ...stagedB, ...stagedFull];
    const canaryIds = stormIds.map((id) => id.replace('knowledge_fact:storm_', 'knowledge_fact:canary_'));

    await inDb(async (db) => {
      // Canaries first: live-world (derivedVersion NONE) children, one per
      // storm row.
      await db.query(`INSERT INTO knowledge_fact $rows`, {
        rows: stormIds.map((id, i) =>
          factRow(canaryIds[i]!, { derivedFrom: [rid(id)] }),
        ),
      });
      // The final world: convA rows, 20 of them superseded-by-convB (the
      // revive population), and convB rows the targeted flip will DELETE.
      await db.query(`INSERT INTO knowledge_fact $rows`, {
        rows: [
          ...convA.map((id) =>
            factRow(id, {
              derivedVersion: FINAL,
              source: { vertical: 'e2e', conversationId: 'convA' },
            }),
          ),
          ...revivable.map((id, i) =>
            factRow(id, {
              derivedVersion: FINAL,
              status: 'superseded',
              supersededBy: rid(convB[i]!),
              source: { vertical: 'e2e', conversationId: 'convA' },
            }),
          ),
          ...convB.map((id) =>
            factRow(id, {
              derivedVersion: FINAL,
              source: { vertical: 'e2e', conversationId: 'convB' },
            }),
          ),
        ],
      });
      // The staged world: bulk insert, half of it BORN 'superseded' — the
      // deriver writes supersede chains directly into staging.
      await db.query(`INSERT INTO knowledge_fact $rows`, {
        rows: stagedB.map((id, i) =>
          factRow(id, {
            derivedVersion: ns.staging,
            status: i % 2 === 0 ? 'active' : 'superseded',
            source: { vertical: 'e2e', conversationId: 'convB' },
          }),
        ),
      });
      // Mid-run deriver writes also UPDATE staged rows into 'superseded'
      // (fn::resolve_facts slot supersede). Guard clause 4 must keep the
      // event silent on version-stamped rows.
      await db.query(
        `UPDATE knowledge_fact SET status = 'superseded'
          WHERE derivedVersion = $staging AND status = 'active' AND id IN $ids`,
        { staging: ns.staging, ids: stagedB.slice(0, 10).map(rid) },
      );

      // TARGETED flip: DELETE final convB + promote staged convB + the
      // revive UPDATE flipping convA rows superseded -> active.
      await promoteStaging(db, ns, { conversationId: 'convB' });
    });

    // The revive direction must have genuinely run (the storm is real)…
    const revived = await staleOf(revivable);
    await inDb(async (db) => {
      const [rows] = await db.query<[Array<{ count: number }>]>(
        `SELECT count() FROM knowledge_fact
          WHERE id IN $ids AND status = 'active' GROUP ALL`,
        { ids: revivable.map(rid) },
      );
      expect(((rows as any[]) ?? [])[0]?.count).toBe(revivable.length);
    });
    expect(revived.size).toBe(revivable.length);

    // FULL flip: fresh staging namespace, then the wholesale
    // DELETE-final + staging->final UPDATE.
    const ns2 = stagingNamespace(FINAL, newRunToken());
    await inDb(async (db) => {
      await db.query(`INSERT INTO knowledge_fact $rows`, {
        rows: stagedFull.map((id, i) =>
          factRow(id, {
            derivedVersion: ns2.staging,
            status: i % 3 === 0 ? 'superseded' : 'active',
            source: { vertical: 'e2e', conversationId: 'convA' },
          }),
        ),
      });
      await promoteStaging(db, ns2);
      // Flip really happened: the final world is exactly the promoted set.
      const [rows] = await db.query<[Array<{ count: number }>]>(
        `SELECT count() FROM knowledge_fact WHERE derivedVersion = $v GROUP ALL`,
        { v: FINAL },
      );
      expect(((rows as any[]) ?? [])[0]?.count).toBe(stagedFull.length);
    });

    // ZERO fires: no canary was stamped, and the tenant-wide stale count
    // did not move.
    const canaries = await staleOf(canaryIds);
    expect(canaries.size).toBe(canaryIds.length);
    for (const [id, row] of canaries) {
      expect({ id, staleAt: row.staleAt ?? null }).toEqual({ id, staleAt: null });
    }
    expect(await tenantStaleCount()).toBe(staleBefore);
  });

  // ── 2. Supersede via fn::resolve_fact ────────────────────────────────
  it('marks the dependent stale in the same write as a resolve_fact supersede', async () => {
    const entity = { vertical: 'rent', id: 'staleness_evt_supersede' };
    const ts = new Date(Date.now() - 10 * 86_400_000).toISOString();

    const first = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: entity,
      predicate: 'status',
      object: 'trial',
      validFrom: ts,
      source: { vertical: 'rent', eventId: 'auth.decide' },
      confidence: 0.9,
    });
    expect(first.body.outcome).toBe('INSERTED');
    const parentId = first.body.factId as string;

    const summaryId = 'knowledge_fact:sup_summary';
    await inDb((db) =>
      db.query(`INSERT INTO knowledge_fact $rows`, {
        rows: [
          factRow(summaryId, {
            derivedFrom: [rid(parentId)],
            source: { kind: 'compaction-summary', vertical: 'e2e' },
          }),
        ],
      }),
    );

    // Same-instant re-decide — the proven SUPERSEDED shape
    // (backdated-supersede.e2e-spec.ts): fn::resolve_fact flips the
    // incumbent active -> superseded inside its own transaction.
    const second = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: entity,
      predicate: 'status',
      object: 'premium',
      validFrom: ts,
      source: { vertical: 'rent', eventId: 'auth.redecide' },
      confidence: 0.9,
    });
    expect(second.body.outcome).toBe('SUPERSEDED');
    expect(second.body.supersededFactIds).toContain(parentId);

    // Stale IMMEDIATELY — no drain ran: this tenant has no recompose
    // changefeed cursor at all.
    const marked = (await staleOf([summaryId])).get(summaryId)!;
    expect(marked.staleAt).toBeTruthy();
    expect(marked.staleReason).toBe('parent_changed');
    await inDb(async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT * FROM changefeed_state WHERE source = 'recompose:knowledge_fact'`,
      );
      expect((rows as any[]) ?? []).toHaveLength(0);
    });
  });

  // ── 3. Retract: cascade shape and orphan shape ───────────────────────
  it('marks dependents during fn::cascade_retract and on a direct retract flip', async () => {
    const entity = { vertical: 'rent', id: 'staleness_evt_retract' };
    const ingest = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: entity,
      predicate: 'status',
      object: 'active-customer',
      validFrom: new Date().toISOString(),
      source: { vertical: 'rent', eventId: 'auth.decide' },
      confidence: 0.9,
    });
    expect(ingest.body.outcome).toBe('INSERTED');
    const rootId = ingest.body.factId as string;

    const s1 = 'knowledge_fact:ret_s1';
    const s2 = 'knowledge_fact:ret_s2';
    await inDb((db) =>
      db.query(`INSERT INTO knowledge_fact $rows`, {
        rows: [
          factRow(s1, { derivedFrom: [rid(rootId)] }),
          factRow(s2, { derivedFrom: [rid(s1)] }),
        ],
      }),
    );

    const retract = await f.http
      .post(`/v1/facts/${encodeURIComponent(rootId)}/retract`)
      .set(auth())
      .send({ reason: 'e2e retract', retractedBy: { source: 'human' } });
    expect(retract.status).toBe(201);
    expect(retract.body.cascadedFactIds).toEqual(
      expect.arrayContaining([s1, s2]),
    );

    // Level ordering: cascade level 1 retracts s1 — that transition fires
    // the event, which marks s2 stale BEFORE level 2 retracts it. s1
    // itself is never marked (by the time the root's own transition fires,
    // s1 is already retracted and fn::mark_derived_stale skips it).
    const rows = await staleOf([rootId, s1, s2]);
    expect(rows.get(rootId)!.staleAt ?? null).toBeNull();
    expect(rows.get(s1)!.staleAt ?? null).toBeNull();
    expect(rows.get(s2)!.staleAt).toBeTruthy();
    expect(rows.get(s2)!.staleReason).toBe('parent_changed');

    // The NO-cascade retract shape (recompose retractOrphan): a direct
    // status flip with no fn::cascade_retract in sight still marks the
    // dependent at write time — this is the case the event alone covers.
    const orphan = 'knowledge_fact:ret_orphan';
    const orphanChild = 'knowledge_fact:ret_orphan_child';
    await inDb(async (db) => {
      await db.query(`INSERT INTO knowledge_fact $rows`, {
        rows: [
          factRow(orphan),
          factRow(orphanChild, { derivedFrom: [rid(orphan)] }),
        ],
      });
      await db.query(
        `UPDATE $id SET status = 'retracted', retractedAt = time::now(),
           retractedBy = 'system', retractionReason = 'e2e orphan'`,
        { id: rid(orphan) },
      );
    });
    const orphanRows = await staleOf([orphanChild]);
    expect(orphanRows.get(orphanChild)!.staleAt).toBeTruthy();
  });

  // ── 4. Recursion: 3-level chain, no loop, stamping never re-fires ────
  it('marks a 3-level chain from one transition and cannot re-fire itself', async () => {
    const root = 'knowledge_fact:rec_root';
    const l1 = 'knowledge_fact:rec_l1';
    const l2 = 'knowledge_fact:rec_l2';
    const l3 = 'knowledge_fact:rec_l3';
    await inDb((db) =>
      db.query(`INSERT INTO knowledge_fact $rows`, {
        rows: [
          factRow(root),
          factRow(l1, { derivedFrom: [rid(root)] }),
          factRow(l2, { derivedFrom: [rid(l1)] }),
          factRow(l3, { derivedFrom: [rid(l2)] }),
        ],
      }),
    );

    // One transition. If the staleness stamp could re-fire the event this
    // would loop forever and the query would never return (jest timeout).
    await inDb((db) =>
      db.query(`UPDATE $id SET status = 'superseded'`, { id: rid(root) }),
    );

    const marked = await staleOf([root, l1, l2, l3]);
    expect(marked.get(root)!.staleAt ?? null).toBeNull();
    for (const id of [l1, l2, l3]) {
      expect(marked.get(id)!.staleAt).toBeTruthy();
      expect(marked.get(id)!.staleReason).toBe('parent_changed');
    }
    const stamps = [l1, l2, l3].map((id) => String(marked.get(id)!.staleAt));

    const countBefore = await tenantStaleCount();
    await inDb(async (db) => {
      // A non-status write on a stale row: transition clause is false.
      await db.query(`UPDATE $id SET confidence = 0.5`, { id: rid(l1) });
      // Repeated transitions are idempotent: revive (guard direction never
      // matches) and re-supersede (fires, but `staleAt IS NONE` makes the
      // marking a no-op).
      await db.query(`UPDATE $id SET status = 'active'`, { id: rid(root) });
      await db.query(`UPDATE $id SET status = 'superseded'`, { id: rid(root) });
    });
    expect(await tenantStaleCount()).toBe(countBefore);
    const after = await staleOf([l1, l2, l3]);
    expect([l1, l2, l3].map((id) => String(after.get(id)!.staleAt))).toEqual(
      stamps,
    );
  });
});
