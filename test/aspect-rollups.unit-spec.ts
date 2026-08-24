import { composeAspectRollups, type RollupMember } from '../src/admin/aspect-rollups';

/**
 * V13 A2 mechanical rollup composition — the write-time lever for the
 * MH-enumeration miss class. Pinned: grouping, the ≥3-member floor,
 * chronological order, dedupe, the char-cap prefix contract, and the
 * slot-safe predicate suffix.
 */
function m(
  entityId: string,
  predicate: string,
  object: string,
  day: string,
  over?: Partial<RollupMember>,
): RollupMember {
  return {
    entityId,
    predicate,
    object,
    validFrom: new Date(`${day}T00:00:00Z`),
    dated: true,
    ...over,
  };
}

describe('composeAspectRollups', () => {
  it('composes a chronological list-fact per (entity, aspect) with ≥3 members', () => {
    const out = composeAspectRollups([
      m('e1', 'activities', 'Melanie went camping.', '2023-07-01'),
      m('e1', 'activities', 'Melanie tried pottery.', '2023-05-01'),
      m('e1', 'activities', 'Melanie swam in the lake.', '2023-06-01'),
      m('e1', 'work', 'Melanie got promoted.', '2023-06-01'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.predicate).toBe('activities_rollup');
    expect(out[0]!.memberCount).toBe(3);
    // Chronological member order with day stamps.
    const i1 = out[0]!.object.indexOf('pottery');
    const i2 = out[0]!.object.indexOf('swam');
    const i3 = out[0]!.object.indexOf('camping');
    expect(i1).toBeGreaterThan(-1);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
    expect(out[0]!.object).toContain('(2023-05-01)');
    // validFrom = newest member.
    expect(out[0]!.validFrom.toISOString().slice(0, 10)).toBe('2023-07-01');
  });

  it('dedupes identical texts and holds the member floor', () => {
    const out = composeAspectRollups([
      m('e1', 'activities', 'Went hiking.', '2023-05-01'),
      m('e1', 'activities', 'went hiking.', '2023-06-01'),
      m('e1', 'activities', 'Went biking.', '2023-07-01'),
    ]);
    expect(out).toHaveLength(0);
  });

  it('skips identity/other aspects and empty texts', () => {
    const out = composeAspectRollups([
      m('e1', 'identity', 'Is a teacher.', '2023-05-01'),
      m('e1', 'identity', 'Is tall.', '2023-05-02'),
      m('e1', 'identity', 'Is left-handed.', '2023-05-03'),
      m('e1', 'other', 'Misc a.', '2023-05-01'),
      m('e1', 'other', 'Misc b.', '2023-05-02'),
      m('e1', 'other', 'Misc c.', '2023-05-03'),
      m('e1', 'travel', '  ', '2023-05-01'),
    ]);
    expect(out).toHaveLength(0);
  });

  it('caps the object at the char limit keeping the chronological prefix and states the cut', () => {
    const members = Array.from({ length: 40 }, (_, i) =>
      m(
        'e1',
        'events',
        `Attended long event number ${i} with a fairly verbose description that eats characters. `.repeat(
          2,
        ),
        `2023-05-${String((i % 28) + 1).padStart(2, '0')}`,
      ),
    );
    const out = composeAspectRollups(members, { charCap: 800 });
    expect(out).toHaveLength(1);
    // The header/suffix envelope rides INSIDE the cap now.
    expect(out[0]!.object.length).toBeLessThanOrEqual(800);
    expect(out[0]!.object).toContain('and');
    expect(out[0]!.object).toMatch(/…and \d+ more$/);
  });

  it('drops a group whose cap keeps fewer than the floor', () => {
    const members = [
      m('e1', 'events', 'x'.repeat(500), '2023-05-01'),
      m('e1', 'events', 'y'.repeat(500), '2023-05-02'),
      m('e1', 'events', 'z'.repeat(500), '2023-05-03'),
    ];
    expect(composeAspectRollups(members, { charCap: 600 })).toHaveLength(0);
  });
});

describe('composeAspectRollups V13 review fixes', () => {
  it('undated members render without an asserted date stamp', () => {
    const out = composeAspectRollups([
      m('e1', 'activities', 'Went camping.', '2023-06-12', { dated: false }),
      m('e1', 'activities', 'Tried pottery.', '2023-05-01'),
      m('e1', 'activities', 'Swam in the lake.', '2023-06-01'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.object).not.toContain('(2023-06-12)');
    expect(out[0]!.object).toContain('(2023-05-01)');
  });

  it('duplicate texts keep the EARLIEST-dated copy', () => {
    const out = composeAspectRollups([
      m('e1', 'events', 'Went camping.', '2023-05-10'),
      m('e1', 'events', 'went camping.', '2023-03-01'),
      m('e1', 'events', 'Ran a race.', '2023-06-01'),
      m('e1', 'events', 'Baked bread.', '2023-07-01'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.object).toContain('(2023-03-01)');
    expect(out[0]!.object).not.toContain('(2023-05-10)');
  });

  it('unions member episodeIds capped and deduped', () => {
    const out = composeAspectRollups([
      m('e1', 'events', 'A.', '2023-05-01', { episodeIds: ['ep1', 'ep2'] }),
      m('e1', 'events', 'B.', '2023-05-02', { episodeIds: ['ep2', 'ep3'] }),
      m('e1', 'events', 'C.', '2023-05-03'),
    ]);
    expect(out[0]!.episodeIds).toEqual(['ep1', 'ep2', 'ep3']);
  });
});
