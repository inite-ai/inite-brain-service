/**
 * #892: the lexical legs also match a row's words by their stems in the
 * row's own language (0184). The composer adds one stemmed matcher per
 * term, its stem computed by the database in a LET before the SELECT;
 * without a query language the leg is exactly the unstemmed one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLexMatchLeg, lexRows } from '../src/search/internals/lex-leg';
import { stemLangOf } from '../src/search/internals/stem-lang';
import { topicTerms } from '../src/search/internals/topic-terms';

describe('lexical leg — stemmed field', () => {
  it('adds one stemmed matcher per term with a unique ref, stems in a prelude', () => {
    const leg = buildLexMatchLeg({
      fields: ['searchHaystack', 'object'],
      topic: 'contratos assinados',
      mode: 'or_terms',
      stem: { field: 'haystackStem', lang: 'pt' },
    });
    expect(leg.where).toBe(
      '(searchHaystack @1@ $t0 OR object @2@ $t0 OR haystackStem @3,OR@ $s0 OR ' +
        'searchHaystack @4@ $t1 OR object @5@ $t1 OR haystackStem @6,OR@ $s1)',
    );
    expect(leg.score).toBe(
      'math::sum([math::max([search::score(1), search::score(2), search::score(3)]), ' +
        'math::max([search::score(4), search::score(5), search::score(6)])])',
    );
    expect(leg.prelude).toBe(
      'LET $stemLang = $stemHint;\nLET $s0 = fn::stem_query($stemLang, $t0);\n' +
        'LET $s1 = fn::stem_query($stemLang, $t1);',
    );
    expect(leg.params).toEqual({ t0: 'contratos', t1: 'assinados', stemHint: 'pt' });
  });

  it("no query language: the tenant's own language, computed in the database", () => {
    const leg = buildLexMatchLeg({
      fields: ['text'],
      topic: 'parser project',
      mode: 'or_terms',
      stem: { field: 'textStem' },
    });
    expect(leg.prelude.split('\n')[0]).toBe('LET $stemLang = fn::tenant_lang();');
    expect(leg.params).not.toHaveProperty('stemHint');
  });

  it('no stem field: the unstemmed leg, no prelude', () => {
    expect(
      buildLexMatchLeg({ fields: ['text'], topic: 'parser project', mode: 'or_terms' }).prelude,
    ).toBe('');
  });

  it('the SELECT is the last result of a query with a prelude', () => {
    expect(lexRows([null, null, [{ id: 1 }]])).toEqual([{ id: 1 }]);
    expect(lexRows([])).toEqual([]);
  });
});

describe('topic terms — any script', () => {
  it('an accented word stays whole', () => {
    expect(topicTerms('contratação de serviços')).toEqual(['contratação', 'serviços']);
    expect(topicTerms('Müller étudiant')).toEqual(['müller', 'étudiant']);
  });

  it('a two-character word of an unspaced script is a term; a Latin one is not', () => {
    expect(topicTerms('合同 on it')).toEqual(['合同']);
  });
});

describe('query stemming language', () => {
  it('explicit first, then a confident detection, else none', () => {
    expect(stemLangOf('anything', 'pt')).toBe('pt');
    expect(stemLangOf('Где работает Мария Петрова?')).toBe('ru');
    expect(stemLangOf('xq7')).toBeUndefined();
  });
});

describe('0184 — one analyzer per mapped language', () => {
  const sql = readFileSync(
    join(__dirname, '../src/db/migrations/0184_language_stems.surql'),
    'utf8',
  );
  it('every analyzer the mapping names is defined', () => {
    const body = sql.slice(sql.indexOf('fn::stem_analyzer'));
    const named = new Set([...body.matchAll(/'(stem_[a-z]+)'/g)].map((m) => m[1]));
    const defined = new Set(
      [...sql.matchAll(/DEFINE ANALYZER IF NOT EXISTS (stem_[a-z]+)/g)].map((m) => m[1]),
    );
    expect([...named].filter((n) => !defined.has(n))).toEqual([]);
  });
});
