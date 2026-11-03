-- 0184_language_stems — the lexical legs match words by their stems in the
-- row's own language (#892).
--
-- WHY. The BM25 surfaces stem in English or not at all: `content` (0002,
-- facts) runs snowball(english) after `ascii`, which does nothing for a
-- Russian or Portuguese word; `episode_text` (0073) only lowercases. So
-- "Мария Петрова" did not match "Марией Петровой", "contrato" did not
-- match "contratos", and "contract" did not match "contracts". 0020 named
-- the fix: per-language stems keyed on the language the write path already
-- stamps (`knowledge_fact.lang`, `episode.lang`).
--
-- HOW. One analyzer per language SurrealDB ships a Snowball stemmer for,
-- plus character bigrams for the scripts written without spaces (zh, ja,
-- ko — the CJKAnalyzer approach). `fn::stem_analyzer(lang)` is the one
-- mapping from an ISO 639-1 code to its analyzer; a language with none
-- (hi, und, NONE) gets no stems. Each covered table gets a shadow field
-- the database computes itself (VALUE) — the row's text run through its
-- language's analyzer, tokens joined by spaces — with a FULLTEXT index on
-- it that only splits on blanks, because the field is already stemmed.
-- The query side stems its terms with `fn::stem_query` under the query's
-- language (search/internals/stem-terms.ts) and matches the shadow field
-- next to the unstemmed ones, which keep their indexes untouched: exact
-- tokens (codes, ids) match as before.
--
-- A ROW WITH NO ANALYZER stores '' (not NONE), so the backfill cursor
-- `… IS NONE` (POST /v1/admin/maintenance/backfill-stems) never returns
-- to it; a later write that stamps a language recomputes the field.
--
-- WHY NOT EDIT 0002. A shipped migration is never edited (the migrator
-- skips it silently); `content` stays and the shadow field supersedes it
-- for stemming.
--
-- TRAPS (3.2.4, stand-probed): the right side of `@N@` must be a literal
-- or a parameter — an expression there loses the MATCHES binding
-- ("no MATCHES clause found"), so query stems are computed in a prior
-- statement; `search::analyze` takes the analyzer name as a value.
--
-- ADDITIVE: analyzers, two functions, two option fields, two indexes; no
-- data mutation here (the backfill is an operator call, chunked).

DEFINE ANALYZER IF NOT EXISTS stem_ar TOKENIZERS class FILTERS lowercase, snowball(arabic);
DEFINE ANALYZER IF NOT EXISTS stem_da TOKENIZERS class FILTERS lowercase, snowball(danish);
DEFINE ANALYZER IF NOT EXISTS stem_de TOKENIZERS class FILTERS lowercase, snowball(german);
DEFINE ANALYZER IF NOT EXISTS stem_el TOKENIZERS class FILTERS lowercase, snowball(greek);
DEFINE ANALYZER IF NOT EXISTS stem_en TOKENIZERS class FILTERS lowercase, snowball(english);
DEFINE ANALYZER IF NOT EXISTS stem_es TOKENIZERS class FILTERS lowercase, snowball(spanish);
DEFINE ANALYZER IF NOT EXISTS stem_fr TOKENIZERS class FILTERS lowercase, snowball(french);
DEFINE ANALYZER IF NOT EXISTS stem_hu TOKENIZERS class FILTERS lowercase, snowball(hungarian);
DEFINE ANALYZER IF NOT EXISTS stem_it TOKENIZERS class FILTERS lowercase, snowball(italian);
DEFINE ANALYZER IF NOT EXISTS stem_nl TOKENIZERS class FILTERS lowercase, snowball(dutch);
DEFINE ANALYZER IF NOT EXISTS stem_no TOKENIZERS class FILTERS lowercase, snowball(norwegian);
DEFINE ANALYZER IF NOT EXISTS stem_pt TOKENIZERS class FILTERS lowercase, snowball(portuguese);
DEFINE ANALYZER IF NOT EXISTS stem_ro TOKENIZERS class FILTERS lowercase, snowball(romanian);
DEFINE ANALYZER IF NOT EXISTS stem_ru TOKENIZERS class FILTERS lowercase, snowball(russian);
DEFINE ANALYZER IF NOT EXISTS stem_sv TOKENIZERS class FILTERS lowercase, snowball(swedish);
DEFINE ANALYZER IF NOT EXISTS stem_ta TOKENIZERS class FILTERS lowercase, snowball(tamil);
DEFINE ANALYZER IF NOT EXISTS stem_tr TOKENIZERS class FILTERS lowercase, snowball(turkish);
DEFINE ANALYZER IF NOT EXISTS stem_cjk TOKENIZERS class FILTERS lowercase, ngram(2, 2);
-- The shadow fields are stemmed already: split on blanks, nothing else.
DEFINE ANALYZER IF NOT EXISTS stems TOKENIZERS blank;

DEFINE FUNCTION OVERWRITE fn::stem_analyzer($lang: option<string>) {
  RETURN {
    ar: 'stem_ar', da: 'stem_da', de: 'stem_de', el: 'stem_el', en: 'stem_en',
    es: 'stem_es', fr: 'stem_fr', hu: 'stem_hu', it: 'stem_it', nl: 'stem_nl',
    no: 'stem_no', pt: 'stem_pt', ro: 'stem_ro', ru: 'stem_ru', sv: 'stem_sv',
    ta: 'stem_ta', tr: 'stem_tr', zh: 'stem_cjk', ja: 'stem_cjk', ko: 'stem_cjk'
  }[$lang ?? ''];
};

-- `text` under `lang`'s analyzer, tokens joined by blanks; '' when the
-- language has no analyzer.
DEFINE FUNCTION OVERWRITE fn::stem_text($lang: option<string>, $text: option<string>) {
  LET $an = fn::stem_analyzer($lang);
  RETURN IF $an = NONE OR $text = NONE THEN '' ELSE array::join(search::analyze($an, $text), ' ') END;
};

-- Query side: a term under the query language's analyzer; the term itself
-- when that language has none.
DEFINE FUNCTION OVERWRITE fn::stem_query($lang: option<string>, $text: string) {
  LET $an = fn::stem_analyzer($lang);
  RETURN IF $an = NONE THEN string::lowercase($text) ELSE array::join(search::analyze($an, $text), ' ') END;
};

-- Facts: the same surface searchHaystack indexes (0007), computed from its
-- inputs rather than from searchHaystack so field order does not matter.
DEFINE FIELD IF NOT EXISTS haystackStem ON knowledge_fact TYPE option<string>
  VALUE fn::stem_text(lang, string::concat(string::replace(predicate, '_', ' '), ' ', object));
DEFINE INDEX IF NOT EXISTS fact_haystack_stem_idx ON knowledge_fact
  FIELDS haystackStem FULLTEXT ANALYZER stems BM25;

DEFINE FIELD IF NOT EXISTS textStem ON episode TYPE option<string>
  VALUE fn::stem_text(lang, text);
DEFINE INDEX IF NOT EXISTS episode_text_stem_idx ON episode
  FIELDS textStem FULLTEXT ANALYZER stems BM25;
