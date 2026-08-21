/**
 * 0085 lifecycle state-machine suite (V11 item 12) — table-driven
 * event sequences against a REAL SurrealDB, complementing the single
 * triangle scenario in slot-pairwise-closure.e2e-spec.ts.
 *
 * Every sequence is ordered fact writes through the SAME production
 * write path the triangle e2e uses (fn::resolve_fact with
 * bitemporal_event semantics), and after each sequence the suite
 * asserts INVARIANTS queried back from the DB:
 *
 *   1. at most ONE active fact per (entity, predicate, slot-day) —
 *      sound here because every same-day pair in the tables sits
 *      inside the 0.9 cosine slot gate (one slot by construction);
 *   2. no dangling supersededBy — every pointer resolves to a row
 *      that exists (the F2/revive class of corruption);
 *   3. interval continuity — no two ACTIVE rows of one slot have
 *      overlapping validity windows.
 *
 * Vectors: 2-d unit vectors by angle; pairs within ~25° sit above the
 * 0.9 gate (cos 25° ≈ 0.906), the same geometry the triangle uses.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { retryOnUniqueViolation } from '../src/db/surreal-retry';

const deg = (d: number): number[] => [
  Math.cos((d * Math.PI) / 180),
  Math.sin((d * Math.PI) / 180),
];

type Outcome =
  | 'INSERTED'
  | 'SUPERSEDED'
  | 'COMPETING'
  | 'INSERTED_HISTORICAL'
  | 'CORROBORATED'
  | 'REJECTED';

interface Write {
  object: string;
  /** Slot-day (YYYY-MM-DD) — bitemporal_event decides at day grain. */
  day: string;
  deg: number;
  /** Expected outcome for a sequential write. */
  expect?: Outcome;
}

interface ConcurrentGroup {
  concurrent: Write[];
  /** Allowed outcome multisets (sorted) — races resolve either way. */
  expectOutcomes: Outcome[][];
}

interface Scenario {
  name: string;
  entity: string;
  sequence: Array<Write | ConcurrentGroup>;
  /** Objects of the rows expected ACTIVE after the whole sequence. */
  expectActive: string[];
  /** Expected row count per status after the whole sequence. */
  expectCounts: Record<string, number>;
  /** object → object of the row its supersededBy must point at. */
  expectSupersededBy?: Record<string, string>;
}

const SCENARIOS: Scenario[] = [
  {
    // (a) The 0083 backdated guard: an OLDER validFrom arriving after
    // a newer one is recorded as history and must not displace the
    // standing decision.
    name: 'backdated incoming slots in as history, the newer fact stays active',
    entity: 'lc_backdated',
    sequence: [
      { object: 'moved to the Berlin office', day: '2026-02-10', deg: 20, expect: 'INSERTED' },
      { object: 'was hired in the Lisbon office', day: '2026-01-05', deg: 22, expect: 'INSERTED_HISTORICAL' },
    ],
    expectActive: ['moved to the Berlin office'],
    expectCounts: { active: 1, superseded: 1 },
    expectSupersededBy: {
      'was hired in the Lisbon office': 'moved to the Berlin office',
    },
  },
  {
    // (b) Multi-peer same-day: 3 competing facts on one slot-day are
    // genuine ambiguity (all flip COMPETING, zero active), and the
    // next strictly-later-day update closes the WHOLE contested pool
    // (the F3 re-admission).
    name: 'multi-peer same-day pool stays contested until a later day closes it',
    entity: 'lc_same_day',
    sequence: [
      { object: 'started a pottery course', day: '2026-03-01', deg: 20, expect: 'INSERTED' },
      { object: 'signed up for a ceramics class', day: '2026-03-01', deg: 22, expect: 'COMPETING' },
      { object: 'joined a clay workshop', day: '2026-03-01', deg: 24, expect: 'COMPETING' },
      { object: 'finished the pottery course', day: '2026-03-06', deg: 22, expect: 'SUPERSEDED' },
    ],
    expectActive: ['finished the pottery course'],
    expectCounts: { active: 1, superseded: 3 },
    expectSupersededBy: {
      'started a pottery course': 'finished the pottery course',
      'signed up for a ceramics class': 'finished the pottery course',
      'joined a clay workshop': 'finished the pottery course',
    },
  },
  {
    // (c) Repeated resolve: the SAME fact re-ingested from the SAME
    // origin is not corroboration (that requires a different origin)
    // — it lands as same-day ambiguity. The state machine converges:
    // every duplicate flips the pool COMPETING, never >1 active, no
    // dangling pointers, however many times the row repeats.
    name: 'repeated same-fact resolve converges to a contested pool, never duplicate-active',
    entity: 'lc_repeat',
    sequence: [
      { object: 'prefers oat milk in coffee', day: '2026-04-02', deg: 20, expect: 'INSERTED' },
      { object: 'prefers oat milk in coffee', day: '2026-04-02', deg: 20, expect: 'COMPETING' },
      { object: 'prefers oat milk in coffee', day: '2026-04-02', deg: 20, expect: 'COMPETING' },
    ],
    expectActive: [],
    expectCounts: { competing: 3 },
  },
  {
    // (d) Concurrent resolve: two competing writes race through
    // Promise.all under the production OCC-retry wrapper. Measured on
    // the rocksdb backend, all three interleavings occur: serialized
    // either way (SUPERSEDED / the backdated guard) — and BOTH
    // inserting active: two single-statement resolves can interleave
    // with NO read conflict (a phantom insert — neither transaction
    // wrote a key the other read, so OCC never fires and the retry
    // wrapper never runs). The 0085 contract is therefore CONVERGENCE,
    // not prevention: the next strictly-later-day update re-admits and
    // closes the WHOLE raced pool, and the suite pins that repair.
    name: 'concurrent competing writes: the slot converges on the next update',
    entity: 'lc_concurrent',
    sequence: [
      {
        concurrent: [
          { object: 'still lives in Porto', day: '2026-05-01', deg: 20 },
          { object: 'relocated to Madrid', day: '2026-05-04', deg: 22 },
        ],
        expectOutcomes: [
          ['INSERTED', 'SUPERSEDED'],
          ['INSERTED', 'INSERTED_HISTORICAL'],
          ['INSERTED', 'INSERTED'],
        ],
      },
      { object: 'settled in Valencia', day: '2026-05-09', deg: 21, expect: 'SUPERSEDED' },
    ],
    expectActive: ['settled in Valencia'],
    expectCounts: { active: 1, superseded: 2 },
  },
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ResolveResult {
  outcome: Outcome;
  factId: unknown;
  supersededFactIds?: unknown[];
  competingFactIds?: unknown[];
}

interface SlotFactRow {
  id: unknown;
  object: string;
  status: string;
  validFrom: Date | string;
  validUntil?: Date | string | null;
  supersededBy?: unknown;
}

type Db = {
  query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T>;
};

/** The triangle e2e's production write path, verbatim (25-arg 0085
 *  signature, bitemporal_event, slot gate 0.9, shared deriver source
 *  → one origin, so corroboration never masks a scenario). */
async function resolveFact(
  db: Db,
  entity: string,
  w: Write,
): Promise<ResolveResult> {
  const [r] = await db.query<[ResolveResult]>(
    `RETURN fn::resolve_fact(
      type::record('knowledge_entity', $entity),
      'status_update', $object, NONE, $embedding,
      0.9, type::datetime($day), NONE, { vertical: 'work', recorder: 'deriver', conversationId: 'conv1' },
      0.6, 'bitemporal_event', 0.85,
      0.30, 0.40, 0.20, 0.10,
      0.30, 0.15,
      NONE, NONE, NONE, NONE, 'wdtest',
      NONE, 0.9
    )`,
    { entity, object: w.object, embedding: deg(w.deg), day: `${w.day}T00:00:00Z` },
  );
  return r;
}

async function slotRows(db: Db, entity: string): Promise<SlotFactRow[]> {
  const [rows] = await db.query<[SlotFactRow[]]>(
    `SELECT id, object, status, validFrom, validUntil, supersededBy
       FROM knowledge_fact
      WHERE entityId = type::record('knowledge_entity', $entity)`,
    { entity },
  );
  return rows ?? [];
}

const toDate = (v: Date | string): Date =>
  v instanceof Date ? v : new Date(v);

const dayOf = (v: Date | string): string =>
  toDate(v).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Invariants — reusable checks so the sequences above stay declarative.
// ---------------------------------------------------------------------------

/** ≤1 active row per slot-day (all rows here share one slot). */
function assertAtMostOneActivePerSlotDay(rows: SlotFactRow[]): void {
  const activeByDay = new Map<string, string[]>();
  for (const r of rows) {
    if (r.status !== 'active') continue;
    const day = dayOf(r.validFrom);
    activeByDay.set(day, [...(activeByDay.get(day) ?? []), r.object]);
  }
  for (const [day, objects] of activeByDay) {
    expect({ day, objects }).toEqual({ day, objects: objects.slice(0, 1) });
  }
}

/** Every supersededBy pointer resolves to an existing row. */
function assertNoDanglingSupersededBy(rows: SlotFactRow[]): void {
  const ids = new Set(rows.map((r) => String(r.id)));
  for (const r of rows) {
    if (r.supersededBy === undefined || r.supersededBy === null) continue;
    expect(ids).toContain(String(r.supersededBy));
  }
}

/** No two ACTIVE rows of the slot have overlapping validity windows
 *  ([validFrom, validUntil ?? +inf) pairwise-disjoint). */
function assertActiveIntervalContinuity(rows: SlotFactRow[]): void {
  const active = rows.filter((r) => r.status === 'active');
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const aFrom = toDate(active[i].validFrom).getTime();
      const aUntil = active[i].validUntil
        ? toDate(active[i].validUntil as Date | string).getTime()
        : Infinity;
      const bFrom = toDate(active[j].validFrom).getTime();
      const bUntil = active[j].validUntil
        ? toDate(active[j].validUntil as Date | string).getTime()
        : Infinity;
      const overlap = aFrom < bUntil && bFrom < aUntil;
      expect({
        overlap,
        pair: [active[i].object, active[j].object],
      }).toEqual({ overlap: false, pair: [active[i].object, active[j].object] });
    }
  }
}

function assertLifecycleInvariants(rows: SlotFactRow[]): void {
  assertAtMostOneActivePerSlotDay(rows);
  assertNoDanglingSupersededBy(rows);
  assertActiveIntervalContinuity(rows);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('0085 lifecycle state machine (real SurrealDB, table-driven)', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_lifecycle_0085_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const surreal = f.app.get(SurrealService);
      await surreal.withCompany(f.companyId, async (db) => {
        // Literal id, the triangle's idiom (slugs are [a-z_] constants).
        await db.query(
          `CREATE knowledge_entity:${scenario.entity} SET
             type = 'staff', canonicalName = $entity,
             canonicalNameLc = $entity`,
          { entity: scenario.entity },
        );

        for (const step of scenario.sequence) {
          if ('concurrent' in step) {
            // The production race: parallel resolves converge via the
            // same OCC-retry wrapper the ingest service uses.
            const results = await Promise.all(
              step.concurrent.map((w) =>
                retryOnUniqueViolation(() =>
                  resolveFact(db as Db, scenario.entity, w),
                ),
              ),
            );
            const outcomes = results.map((r) => r.outcome).sort();
            expect(step.expectOutcomes.map((o) => [...o].sort())).toContainEqual(
              outcomes,
            );
          } else {
            const r = await resolveFact(db as Db, scenario.entity, step);
            if (step.expect) {
              expect({ object: step.object, outcome: r.outcome }).toEqual({
                object: step.object,
                outcome: step.expect,
              });
            }
          }
        }

        const rows = await slotRows(db as Db, scenario.entity);
        assertLifecycleInvariants(rows);

        const activeObjects = rows
          .filter((r) => r.status === 'active')
          .map((r) => r.object)
          .sort();
        expect(activeObjects).toEqual([...scenario.expectActive].sort());

        const counts: Record<string, number> = {};
        for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
        expect(counts).toEqual(scenario.expectCounts);

        for (const [loser, winner] of Object.entries(
          scenario.expectSupersededBy ?? {},
        )) {
          const loserRow = rows.find((r) => r.object === loser);
          const winnerRow = rows.find((r) => r.object === winner);
          expect(String(loserRow?.supersededBy)).toBe(String(winnerRow?.id));
        }
      });
    }, 60_000);
  }
});
