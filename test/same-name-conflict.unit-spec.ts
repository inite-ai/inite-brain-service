import { conflictsOnSingleValuedSlot, parseFactLine } from '../src/ingest/same-name-conflict';
import { singleValuedPredicates } from '../src/ai/predicate-semantics';

const SINGLE = singleValuedPredicates([{ predicateId: 'works_at', semantics: 'single_active' }]);

describe('conflictsOnSingleValuedSlot', () => {
  it('a different value on a single-valued slot is a conflict', () => {
    expect(
      conflictsOnSingleValuedSlot(
        ['dob: 1980-02-01'],
        [{ predicate: 'dob', object: '1975-07-11' }],
        SINGLE,
      ),
    ).toBe(true);
    expect(
      conflictsOnSingleValuedSlot(
        ['works_at: Acme'],
        [{ predicate: 'works_at', object: 'Globex' }],
        SINGLE,
      ),
    ).toBe(true);
  });

  it('the same value up to case, spacing and trailing punctuation is not', () => {
    expect(
      conflictsOnSingleValuedSlot(
        ['address: Rua  Augusta 12.'],
        [{ predicate: 'address', object: 'rua augusta 12' }],
        SINGLE,
      ),
    ).toBe(false);
  });

  it('append-only slots, unknown predicates, edges and name never conflict', () => {
    expect(
      conflictsOnSingleValuedSlot(
        ['preference: tea', 'colleague_of: Bob', 'name: J. Smith', 'invented_pred: x'],
        [
          { predicate: 'preference', object: 'coffee' },
          { predicate: 'name', object: 'John Smith' },
          { predicate: 'invented_pred', object: 'y' },
        ],
        SINGLE,
      ),
    ).toBe(false);
  });

  it('a slot only one side holds is nothing to disagree on', () => {
    expect(
      conflictsOnSingleValuedSlot(
        ['dob: 1980-02-01'],
        [{ predicate: 'email', object: 'a@b.c' }],
        SINGLE,
      ),
    ).toBe(false);
  });

  it('any held value of a slot agrees (a slot with history)', () => {
    expect(
      conflictsOnSingleValuedSlot(
        ['address: Lisbon'],
        [
          { predicate: 'address', object: 'Porto' },
          { predicate: 'address', object: 'Lisbon' },
        ],
        SINGLE,
      ),
    ).toBe(false);
  });
});

describe('parseFactLine', () => {
  it('splits on the first ": " only', () => {
    expect(parseFactLine('note: a: b')).toEqual({ predicate: 'note', object: 'a: b' });
    expect(parseFactLine('no separator')).toBeNull();
  });
});
