/**
 * A system of record decides its own slot (#830): no judgement changes
 * the status of a fact read from a record door.
 */
import { keepRecordSlots, type ResolutionAction } from '../src/dreams/fact-resolution';

const REC = new Set(['rec1', 'rec2']);
const ofRecord = (id: string) => REC.has(id);
const run = (a: ResolutionAction) => keepRecordSlots([a], ofRecord);

describe('keepRecordSlots', () => {
  it('a claim that would replace a record value disputes it instead', () => {
    expect(run({ kind: 'supersede', loser: 'rec1', winner: 'claim' })).toEqual([
      { kind: 'dispute', claim: 'claim', record: 'rec1' },
    ]);
  });

  it('a record value replacing a claim stands', () => {
    const a: ResolutionAction = { kind: 'supersede', loser: 'claim', winner: 'rec1' };
    expect(run(a)).toEqual([a]);
  });

  it('a contradiction with a record makes only the claim compete', () => {
    expect(run({ kind: 'compete', a: 'rec1', b: 'claim' })).toEqual([
      { kind: 'dispute', claim: 'claim', record: 'rec1' },
    ]);
    expect(run({ kind: 'compete', a: 'claim', b: 'rec2' })).toEqual([
      { kind: 'dispute', claim: 'claim', record: 'rec2' },
    ]);
  });

  it('a claim restating a record corroborates the record, never the reverse', () => {
    expect(run({ kind: 'corroborate', incumbent: 'claim', younger: 'rec1' })).toEqual([
      { kind: 'corroborate', incumbent: 'rec1', younger: 'claim' },
    ]);
  });

  it('between two record values the judge has no say', () => {
    expect(run({ kind: 'supersede', loser: 'rec1', winner: 'rec2' })).toEqual([]);
    expect(run({ kind: 'compete', a: 'rec1', b: 'rec2' })).toEqual([]);
    expect(run({ kind: 'corroborate', incumbent: 'rec1', younger: 'rec2' })).toEqual([]);
  });

  it('claims among themselves are untouched', () => {
    const a: ResolutionAction = { kind: 'compete', a: 'c1', b: 'c2' };
    expect(run(a)).toEqual([a]);
  });
});
