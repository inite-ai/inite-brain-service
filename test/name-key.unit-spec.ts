import { nameKey, nameKeysFor } from '../src/common/name-key';

/**
 * The script-independent name key.
 *
 * What it is FOR is one line of tests; what it must NOT do is the rest of
 * the file, because every false key is a wrong merge — two real entities
 * collapsed into one node, with no signal that it happened and nothing
 * downstream able to tell them apart again.
 *
 * The pairs here are the ones the measurement was taken on (see
 * src/common/name-key.ts), so the two mechanisms can be compared on the
 * same input: bge-m3 scores "Ivan Petrov" against "Иван Сидоров" at 0.712,
 * above four of the five true cross-script pairs. This module has to get
 * that pair right, or it is not an improvement on the thing it replaces.
 */
describe('nameKey', () => {
  const same = (a: string, b: string): boolean => {
    const ka = nameKey(a);
    return ka !== '' && ka === nameKey(b);
  };

  describe('unifies one name written in different scripts', () => {
    it.each([
      ['Ivan Petrov', 'Иван Петров'],
      ['Nyu-York', 'Нью-Йорк'],
      ['Petr', 'Пётр'],
      ['Mariya Alvares', 'Мария Альварес'],
    ])('%s == %s', (a, b) => expect(same(a, b)).toBe(true));

    it('folds case, diacritics, punctuation and repeated spaces', () => {
      expect(same('María Álvarez', 'Maria Alvarez')).toBe(true);
      expect(same('IVAN-PETROV', 'Ivan  Petrov')).toBe(true);
      expect(same('Acme, Inc.', 'acme inc')).toBe(true);
    });

    it('keeps a modifier apostrophe from splitting the word', () => {
      // any-ascii renders a soft sign as "'". Spacing it tore "Нью-Йорк"
      // into "n yu york" while "Nyu-York" folded to "nyu york", so the two
      // spellings failed to meet on the mechanism built to make them meet.
      expect(nameKey('Нью-Йорк')).toBe('nyu york');
    });
  });

  describe('keeps different things apart', () => {
    it('two people who share a given name', () => {
      // The pair the embedding cannot separate: cosine 0.712, higher than
      // most genuine cross-script pairs.
      expect(same('Ivan Petrov', 'Иван Сидоров')).toBe(false);
      expect(nameKey('Иван Сидоров')).toBe('ivan sidorov');
    });

    it('a company and the same company with a legal suffix', () => {
      expect(same('Orbital Dynamics', 'Orbital Dynamics GmbH')).toBe(false);
      expect(same('Orbital Dynamics GmbH', 'Orbital Dynamics S.A.')).toBe(false);
    });

    it('names whose only difference is punctuation the fold would delete', () => {
      // C / C++ / C# all fold to "c". Refused outright rather than merged:
      // a key that short carries no evidence and destroys what it drops.
      for (const n of ['C', 'C++', 'C#']) expect(nameKey(n)).toBe('');
      expect(same('C++', 'C#')).toBe(false);
    });
  });

  describe('refuses to produce a key it cannot stand behind', () => {
    it('input with no letter or digit', () => {
      for (const n of ['', '   ', '!!!', '—', '...']) expect(nameKey(n)).toBe('');
    });

    it('an emoji, which transliterates to its CLDR NAME', () => {
      // "🙂" -> "slight smile" is a perfectly good key and an entirely fake
      // identity; two entities decorated the same way would fuse on it.
      expect(nameKey('🙂')).toBe('');
      expect(nameKey('⭐')).toBe('');
    });

    it('anything shorter than three characters after folding', () => {
      expect(nameKey('BP')).toBe('');
      expect(nameKey('A.')).toBe('');
      expect(nameKey('IBM')).toBe('ibm'); // three is enough
    });
  });

  describe('the limit it does not claim to cross', () => {
    it('a native spelling does not meet an arbitrary human romanization', () => {
      // any-ascii romanizes Ё as "e"; a person may well have typed "Yo".
      // There is no single correct romanization of Ё (GOST, BGN/PCGN and
      // ISO 9 disagree), so this is a property of the problem, not a bug —
      // and it is exactly the residue the embedding + judge path handles.
      expect(same('Ёлка', 'Yolka')).toBe(false);
    });

    it('a script that writes a foreign name by sound stays distant', () => {
      expect(same('Ivan Petrov', '伊万·彼得罗夫')).toBe(false);
      expect(same('Ivan Petrov', 'إيفان بيتروف')).toBe(false);
      expect(same('Aarav Sharma', 'आरव शर्मा')).toBe(false);
    });
  });

  describe('nameKeysFor', () => {
    it('collects distinct non-empty keys and drops the rest', () => {
      expect(nameKeysFor(['Acme', 'ACME', null, undefined, '  ', 'Акме', 'C#'])).toEqual([
        'acme',
        'akme',
      ]);
    });
    it('is empty when nothing yields a key', () => {
      expect(nameKeysFor([])).toEqual([]);
      expect(nameKeysFor(['🙂', '', 'BP'])).toEqual([]);
    });
  });
});
