/**
 * What the nightly pass hands the truth-discovery estimator (#847): which
 * facts can compete, in which slot, under which source and origin, and
 * which feedback counts.
 */
import {
  normaliseClaim,
  slotOf,
  toTruthAnchors,
  toTruthFacts,
  type TruthFactRow,
} from '../src/ai/calibration/truth-discovery-input';

function row(over: Partial<TruthFactRow> = {}): TruthFactRow {
  return {
    id: 'knowledge_fact:a',
    entityId: 'knowledge_entity:maria',
    predicate: 'lives_in',
    object: 'Lisbon',
    validFrom: '2026-01-01T00:00:00Z',
    validUntil: null,
    status: 'active',
    vertical: 'crm',
    recorder: null,
    originKey: null,
    ...over,
  };
}
const single = new Set(['lives_in']);

describe('truth-discovery input', () => {
  it('a personal fact, a team fact, a tenant fact and a pinned world are four slots', () => {
    const slots = new Set([
      slotOf(row()),
      slotOf(row({ userId: 'u1' })),
      slotOf(row({ scope: ['team:gl1:sre'] })),
      slotOf(row({ derivedVersion: 'wd-v3' })),
    ]);
    expect(slots.size).toBe(4);
    // Scope tag order does not split a slot.
    expect(slotOf(row({ scope: ['b', 'a'] }))).toBe(slotOf(row({ scope: ['a', 'b'] })));
  });

  it('the canonical predicate is the slot: an aliased coinage competes with its canon', () => {
    expect(slotOf(row({ predicate: 'resides_in', predicateAlias: 'lives_in' }))).toBe(
      slotOf(row()),
    );
  });

  it('append_only predicates never compete; rows without a source or valid time are left out', () => {
    expect(toTruthFacts([row({ predicate: 'likes' })], single)).toEqual([]);
    expect(toTruthFacts([row({ vertical: null })], single)).toEqual([]);
    expect(toTruthFacts([row({ validFrom: null })], single)).toEqual([]);
  });

  it('origin falls back to the source key; a retraction is carried', () => {
    const [f] = toTruthFacts([row({ recorder: 'ana', status: 'retracted' })], single);
    expect(f).toMatchObject({ sourceKey: 'crm:ana', origin: 'crm:ana', retracted: true });
    const [g] = toTruthFacts([row({ originKey: 'doc:1' })], single);
    expect(g!.origin).toBe('doc:1');
  });

  it('a corroborating row holds as long as its incumbent: a later value is history, not its rival', () => {
    const [f] = toTruthFacts(
      [
        row({
          status: 'corroborating',
          validUntil: null,
          corroboratedUntil: '2026-03-01T00:00:00Z',
        }),
      ],
      single,
    );
    expect(f!.validUntil).toBe(Date.parse('2026-03-01T00:00:00Z'));
    const [active] = toTruthFacts([row({ corroboratedUntil: '2026-03-01T00:00:00Z' })], single);
    expect(active!.validUntil).toBeNull();
  });

  it('a restatement in another case or spacing is the same claim', () => {
    expect(normaliseClaim('  Lisbon   Portugal ')).toBe(normaliseClaim('lisbon portugal'));
  });

  it('feedback: helpful confirms, incorrect rejects, not_helpful says nothing; one actor counts once per source and verdict', () => {
    const facts = toTruthFacts(
      [row({ id: 'f1' }), row({ id: 'f2', entityId: 'e2' }), row({ id: 'f3', entityId: 'e3' })],
      single,
    );
    const anchors = toTruthAnchors(
      [
        { factId: 'f1', actor: 'k1', verdict: 'helpful' },
        { factId: 'f2', actor: 'k1', verdict: 'not_helpful' },
        { factId: 'f2', actor: 'k2', verdict: 'incorrect' },
        // k2 rejecting another fact of the same source: farmed, dropped.
        { factId: 'f3', actor: 'k2', verdict: 'incorrect' },
        // a different actor's rejection counts.
        { factId: 'f3', actor: 'k3', verdict: 'incorrect' },
        { factId: 'unknown', actor: 'k4', verdict: 'helpful' },
      ],
      facts,
    );
    expect(anchors).toEqual([
      { factId: 'f1', correct: true },
      { factId: 'f2', correct: false },
      { factId: 'f3', correct: false },
    ]);
  });
});
