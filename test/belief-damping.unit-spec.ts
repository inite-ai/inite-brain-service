/**
 * Belief-aware fact damping (BELIEFS_FACT_DAMPING) — the pure pass
 * (belief-damping.ts, the belief-citations.unit-spec sibling):
 *
 *  - contradicted line: deterministic suffix + STABLE demotion after
 *    the non-contradicted lines (a stable partition, never a re-sort);
 *  - conservative semantics: same normalized (subject=canonicalName,
 *    field=predicate) key AND a different normalized value — equal
 *    values, unmatched keys, unparsable/unindexed lines all pass
 *    through untouched;
 *  - trim/case normalization on subject, field and value matching;
 *  - disabled / no matched beliefs ⇒ byte-identical output (exact
 *    string equality pinned) and NOTHING on the metrics path;
 *  - metric emission: `damped` per demoted line, `clean` per
 *    no-contradiction evaluation.
 */
import {
  applyBeliefFactDamping,
  type BeliefDampingMetrics,
} from '../src/synthesize/belief-damping';
import type { CitableBelief } from '../src/synthesize/belief-citations';
import { buildFactIndex, type Citation } from '../src/synthesize/fact-index';
import type { SearchHit } from '../src/search/search.types';

// `predicate` is what the fact LINE shows; `slot` is what the join uses
// (`predicateAlias ?? predicate`, 0083). They differ here whenever a
// coinage was aliased, which is the case the string compare used to miss.
const citation = (factId: string, over: Partial<Citation> = {}): Citation => ({
  factId,
  entityId: 'entity:alice',
  canonicalName: 'Alice',
  predicate: 'city',
  slot: typeof over.predicate === 'string' ? over.predicate : 'city',
  object: 'Paris',
  ...over,
});

// `field` is the written display name; `predicateId` is the slot (0147).
// A belief with no slot predates 0147 and joins nothing, by design.
const belief = (over: Partial<CitableBelief> = {}): CitableBelief => ({
  beliefId: 'semantic_belief:b1',
  subject: 'Alice',
  field: 'city',
  predicateId: typeof over.field === 'string' ? over.field : 'city',
  value: 'Berlin',
  excerpt: 'Alice — city: Berlin (was: Paris)',
  ...over,
});

const asMap = (...cs: Citation[]): Map<string, Citation> => new Map(cs.map((c) => [c.factId, c]));

const beliefSet = (...bs: CitableBelief[]): Map<string, CitableBelief> =>
  new Map(bs.map((b) => [b.beliefId, b]));

const recordingMetrics = (): BeliefDampingMetrics & {
  calls: Array<[string, number | undefined]>;
} => {
  const calls: Array<[string, number | undefined]> = [];
  return { calls, countBeliefDamping: (outcome, n) => calls.push([outcome, n]) };
};

describe('applyBeliefFactDamping — suffix + stable demotion', () => {
  it('a contradicted line gets the deterministic suffix and demotes after the clean lines', () => {
    const lines = [
      '[fact:1] Alice (person) — city: Paris (as of 2026-01-01)',
      '[fact:2] Bob (person) — role: engineer',
    ];
    const out = applyBeliefFactDamping({
      enabled: true,
      factLines: lines,
      factIndex: asMap(
        citation('fact:1'),
        citation('fact:2', { canonicalName: 'Bob', predicate: 'role', object: 'engineer' }),
      ),
      beliefsById: beliefSet(belief()),
    });
    expect(out).toEqual([
      '[fact:2] Bob (person) — role: engineer',
      '[fact:1] Alice (person) — city: Paris (as of 2026-01-01) (superseded by current belief: city = Berlin)',
    ]);
  });

  it('demotion is a stable partition — both groups keep their relative input order', () => {
    const lines = [
      '[fact:1] Alice (person) — city: Paris',
      '[fact:2] Bob (person) — role: engineer',
      '[fact:3] Alice (person) — team: Search',
      '[fact:4] Carol (person) — city: Rome',
    ];
    const out = applyBeliefFactDamping({
      enabled: true,
      factLines: lines,
      factIndex: asMap(
        citation('fact:1'),
        citation('fact:2', { canonicalName: 'Bob', predicate: 'role', object: 'engineer' }),
        citation('fact:3', { predicate: 'team', object: 'Search' }),
        citation('fact:4', { canonicalName: 'Carol', predicate: 'city', object: 'Rome' }),
      ),
      beliefsById: beliefSet(
        belief(),
        belief({ beliefId: 'semantic_belief:b2', subject: 'Carol', value: 'Madrid' }),
      ),
    });
    // Clean lines first (2 before 3), damped lines after (1 before 4) —
    // never re-sorted by any score.
    expect(out.map((l) => l.slice(0, 8))).toEqual(['[fact:2]', '[fact:3]', '[fact:1]', '[fact:4]']);
    expect(out[2]).toContain('(superseded by current belief: city = Berlin)');
    expect(out[3]).toContain('(superseded by current belief: city = Madrid)');
  });

  it('a fact asserting the SAME value as the belief is untouched (agreement, not contradiction)', () => {
    const lines = ['[fact:1] Alice (person) — city: Berlin'];
    const out = applyBeliefFactDamping({
      enabled: true,
      factLines: lines,
      factIndex: asMap(citation('fact:1', { object: 'Berlin' })),
      beliefsById: beliefSet(belief()),
    });
    expect(out).toEqual(lines);
  });

  it('value equality is judged after trim/case normalization — "  BERLIN " agrees with "berlin"', () => {
    const lines = ['[fact:1] Alice (person) — city: berlin'];
    const out = applyBeliefFactDamping({
      enabled: true,
      factLines: lines,
      factIndex: asMap(citation('fact:1', { object: 'berlin' })),
      beliefsById: beliefSet(belief({ value: '  BERLIN ' })),
    });
    expect(out).toEqual(lines);
  });

  it('subject/field matching normalizes trim + case — never fuzzier than that', () => {
    const lines = ['[fact:1] Alice (person) — city: Paris'];
    const out = applyBeliefFactDamping({
      enabled: true,
      factLines: lines,
      factIndex: asMap(citation('fact:1')),
      beliefsById: beliefSet(belief({ subject: '  ALICE ', field: 'City ' })),
    });
    expect(out).toEqual([
      '[fact:1] Alice (person) — city: Paris (superseded by current belief: City = Berlin)',
    ]);
    // A near-miss subject ("Alice B.") is NOT a match — conservative by design.
    const nearMiss = applyBeliefFactDamping({
      enabled: true,
      factLines: lines,
      factIndex: asMap(citation('fact:1')),
      beliefsById: beliefSet(belief({ subject: 'Alice B.' })),
    });
    expect(nearMiss).toEqual(lines);
  });

  it('no belief covers the (subject, field) key ⇒ every line passes untouched', () => {
    const lines = ['[fact:1] Alice (person) — city: Paris'];
    const out = applyBeliefFactDamping({
      enabled: true,
      factLines: lines,
      factIndex: asMap(citation('fact:1')),
      beliefsById: beliefSet(belief({ field: 'employer', value: 'ACME' })),
    });
    expect(out).toEqual(lines);
  });

  it('unparsable prefixes and unindexed factIds never dampen', () => {
    const lines = [
      'no prefix at all — city: Paris',
      '[] empty header',
      '[fact:unknown] Alice (person) — city: Paris',
    ];
    const out = applyBeliefFactDamping({
      enabled: true,
      factLines: lines,
      factIndex: asMap(citation('fact:1')),
      beliefsById: beliefSet(belief()),
    });
    expect(out).toEqual(lines);
  });
});

describe('applyBeliefFactDamping — the byte-identical off-paths', () => {
  const lines = [
    '[fact:1] Alice (person) — city: Paris (as of 2026-01-01)',
    '[fact:2] Bob (person) — role: engineer',
  ];
  const index = asMap(
    citation('fact:1'),
    citation('fact:2', { canonicalName: 'Bob', predicate: 'role', object: 'engineer' }),
  );

  it('enabled: false ⇒ exact same strings in the exact same order, no metric', () => {
    const metrics = recordingMetrics();
    const out = applyBeliefFactDamping({
      enabled: false,
      factLines: lines,
      factIndex: index,
      beliefsById: beliefSet(belief()),
      metrics,
    });
    expect(out).toEqual(lines);
    // Byte-identical: the very same string instances, untouched.
    out.forEach((l, i) => expect(l).toBe(lines[i]));
    expect(metrics.calls).toEqual([]);
  });

  it('serving lane off (beliefsById undefined) ⇒ structural no-op, no metric', () => {
    const metrics = recordingMetrics();
    const out = applyBeliefFactDamping({
      enabled: true,
      factLines: lines,
      factIndex: index,
      beliefsById: undefined,
      metrics,
    });
    expect(out).toEqual(lines);
    out.forEach((l, i) => expect(l).toBe(lines[i]));
    expect(metrics.calls).toEqual([]);
  });

  it('lane on but nothing matched (empty fence map) ⇒ same no-op', () => {
    const metrics = recordingMetrics();
    const out = applyBeliefFactDamping({
      enabled: true,
      factLines: lines,
      factIndex: index,
      beliefsById: new Map(),
      metrics,
    });
    expect(out).toEqual(lines);
    expect(metrics.calls).toEqual([]);
  });
});

describe('applyBeliefFactDamping — metric emission', () => {
  it('damped counts once per demoted line', () => {
    const metrics = recordingMetrics();
    applyBeliefFactDamping({
      enabled: true,
      factLines: ['[fact:1] Alice (person) — city: Paris', '[fact:4] Carol (person) — city: Rome'],
      factIndex: asMap(
        citation('fact:1'),
        citation('fact:4', { canonicalName: 'Carol', predicate: 'city', object: 'Rome' }),
      ),
      beliefsById: beliefSet(
        belief(),
        belief({ beliefId: 'semantic_belief:b2', subject: 'Carol', value: 'Madrid' }),
      ),
      metrics,
    });
    expect(metrics.calls).toEqual([['damped', 2]]);
  });

  it('clean counts once when the pass ran but nothing contradicted', () => {
    const metrics = recordingMetrics();
    applyBeliefFactDamping({
      enabled: true,
      factLines: ['[fact:1] Alice (person) — city: Berlin'],
      factIndex: asMap(citation('fact:1', { object: 'Berlin' })),
      beliefsById: beliefSet(belief()),
      metrics,
    });
    expect(metrics.calls).toEqual([['clean', undefined]]);
  });
});

/**
 * The join itself — the reason this pass never fired.
 *
 * Every fixture above happens to name the attribute identically on both
 * planes, so they passed while the pass was dead in production. The two
 * planes do NOT name attributes the same way: the fact plane uses
 * registry ids (`deploy_target`), the belief plane whatever the scene
 * enricher wrote (`deployment target`). Measured on a live tenant, ZERO
 * of 12 beliefs matched any of 163 distinct fact (subject, predicate)
 * keys, and the counter said so: 69 clean, 0 damped.
 */
describe('applyBeliefFactDamping — the cross-plane join (0147)', () => {
  it('damps across the naming gap: free-text field, registry-id predicate', () => {
    const out = applyBeliefFactDamping({
      enabled: true,
      factLines: ['[fact:1] ledger-sync (service) — deploy_target: Fly.io'],
      factIndex: asMap(
        citation('fact:1', {
          canonicalName: 'ledger-sync',
          predicate: 'deploy_target',
          object: 'Fly.io',
        }),
      ),
      // What the promoter actually stores: the written name for display,
      // the registry slot for identity.
      beliefsById: beliefSet(
        belief({
          subject: 'ledger-sync',
          field: 'deployment target',
          predicateId: 'deploy_target',
          value: 'AWS ECS Fargate',
        }),
      ),
    });
    expect(out[0]).toContain('(superseded by current belief: deployment target = AWS ECS Fargate)');
  });

  it('joins on the fact ALIAS, not the coinage the line shows', () => {
    // A fact coined `deploys_to` and aliased onto `deploy_target` sits in
    // the same slot as one coined `deploy_target`. The line still shows
    // what was written; the comparison uses the canon.
    const out = applyBeliefFactDamping({
      enabled: true,
      factLines: ['[fact:1] ledger-sync (service) — deploys_to: Fly.io'],
      factIndex: asMap(
        citation('fact:1', {
          canonicalName: 'ledger-sync',
          predicate: 'deploys_to',
          slot: 'deploy_target',
          object: 'Fly.io',
        }),
      ),
      beliefsById: beliefSet(
        belief({
          subject: 'ledger-sync',
          field: 'deployment target',
          predicateId: 'deploy_target',
          value: 'AWS ECS Fargate',
        }),
      ),
    });
    expect(out[0]).toContain('superseded by current belief');
  });

  it('a belief with no slot joins NOTHING — never a wrong join', () => {
    // A row written before 0147. It must not fall back to comparing the
    // display name, which is how the pass would resume guessing.
    const lines = ['[fact:1] ledger-sync (service) — deploy_target: Fly.io'];
    const out = applyBeliefFactDamping({
      enabled: true,
      factLines: lines,
      factIndex: asMap(
        citation('fact:1', {
          canonicalName: 'ledger-sync',
          predicate: 'deploy_target',
          object: 'Fly.io',
        }),
      ),
      beliefsById: beliefSet({
        beliefId: 'semantic_belief:legacy',
        subject: 'ledger-sync',
        field: 'deploy_target',
        value: 'AWS ECS Fargate',
        excerpt: 'x',
      }),
    });
    expect(out).toEqual(lines);
  });

  it('same slot, same value: the fact AGREES and is left alone', () => {
    const lines = ['[fact:1] ledger-sync (service) — deploy_target: AWS ECS Fargate'];
    const out = applyBeliefFactDamping({
      enabled: true,
      factLines: lines,
      factIndex: asMap(
        citation('fact:1', {
          canonicalName: 'ledger-sync',
          predicate: 'deploy_target',
          object: 'AWS ECS Fargate',
        }),
      ),
      beliefsById: beliefSet(
        belief({
          subject: 'ledger-sync',
          field: 'deployment target',
          predicateId: 'deploy_target',
          value: 'AWS ECS Fargate',
        }),
      ),
    });
    expect(out).toEqual(lines);
  });
});

describe('applyBeliefFactDamping — on the lines buildFactIndex renders', () => {
  it('a handle-prefixed line resolves to its fact and is damped', () => {
    const { factLines, factIndex } = buildFactIndex([
      {
        entityId: 'entity:alice',
        entityType: 'person',
        canonicalName: 'Alice',
        externalRefs: {},
        score: 1,
        facts: [
          {
            factId: 'knowledge_fact:c1',
            predicate: 'city',
            object: 'Paris',
            confidence: 0.9,
            score: 1,
            validFrom: '2026-01-01T00:00:00.000Z',
            status: 'active',
          },
        ],
      } as unknown as SearchHit,
    ]);
    expect(factLines[0]!.startsWith('[f1] ')).toBe(true);
    const out = applyBeliefFactDamping({
      enabled: true,
      factLines,
      factIndex,
      beliefsById: beliefSet(belief()),
    });
    expect(out[0]).toBe(`${factLines[0]} (superseded by current belief: city = Berlin)`);
  });
});
