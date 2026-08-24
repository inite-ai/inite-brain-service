/**
 * Multilingual Tier 1 — confidence-aware language attribution +
 * soft same-language boost. BOTH behaviours sit behind default-off flags
 * (MULTILINGUAL_LANG_ATTRIBUTION, MULTILINGUAL_SOFT_LANG_FILTER); with both
 * off the detector, the scorer, the where-builder, the user-profile SQL and
 * the resolver are byte-identical to today — the guardrail these gates pin.
 */
import { detectLanguage, DETECTOR_VERSION } from '../src/ai/locale/language-detector';
import { scoreRows } from '../src/search/internals/scoring';
import type { FusedRow } from '../src/search/internals/types';
import { buildBaseWhere } from '../src/search/internals/where-builder';
import type { SearchDto } from '../src/search/dto/search.dto';
import { resolveSearchTuning } from '../src/search/retrieval-profile';
import { MetricsService } from '../src/metrics/metrics.service';
import { FactResolverService } from '../src/ingest/fact-resolver.service';

const ATTR = 'MULTILINGUAL_LANG_ATTRIBUTION';
const SOFT = 'MULTILINGUAL_SOFT_LANG_FILTER';

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

// ── Detector ───────────────────────────────────────────────────────────

describe('detectLanguage — confidence-aware attribution', () => {
  it('every result carries the detector version constant', () => {
    expect(detectLanguage('The cat sat on the mat.').detectorVersion).toBe(DETECTOR_VERSION);
    expect(detectLanguage('').detectorVersion).toBe(DETECTOR_VERSION);
    expect(detectLanguage('Мария — директор.').detectorVersion).toBe(DETECTOR_VERSION);
  });

  it('OFF (explicit) → the Phase-4 `en` fallback for stopword-less input', () => {
    // Short / stopword-less Latin token: no language signal, historic
    // behaviour defaults to English.
    expect(detectLanguage('OK', false).language).toBe('en');
    expect(detectLanguage('Acme Corp', false).language).toBe('en');
  });

  it('ON (explicit) → `und` (not `en`) for short / stopword-less / numeric', () => {
    expect(detectLanguage('OK', true).language).toBe('und');
    expect(detectLanguage('Acme Corp', true).language).toBe('und');
    // Numeric-only is already `und` under both modes (no letters tokenised).
    expect(detectLanguage('12345', true).language).toBe('und');
    expect(detectLanguage('12345', false).language).toBe('und');
  });

  it('ON keeps a real stopword-bearing sentence classified with confidence', () => {
    const r = detectLanguage('The quick brown fox jumps over the lazy dog.', true);
    expect(r.language).toBe('en');
    expect(r.confidence).toBeGreaterThan(0);
    // Non-Latin scripts are unaffected by the Latin-path attribution gate.
    expect(detectLanguage('Мария работает CTO в Acme.', true).language).toBe('ru');
  });

  it('reads the env flag when no explicit mode is given (off-path byte-identical)', () => {
    withEnv(ATTR, undefined, () => expect(detectLanguage('OK').language).toBe('en'));
    withEnv(ATTR, '1', () => expect(detectLanguage('OK').language).toBe('und'));
    withEnv(ATTR, '0', () => expect(detectLanguage('OK').language).toBe('en'));
  });
});

// ── Scoring boost ──────────────────────────────────────────────────────

function fused(lang: string | null): FusedRow {
  return {
    id: 'knowledge_fact:x',
    entityId: 'knowledge_entity:e',
    predicate: 'work',
    object: 'test',
    confidence: 1,
    lang,
    validFrom: '2026-01-01T00:00:00Z',
    recordedAt: '2026-01-15T00:00:00Z',
    status: 'active',
    source: {},
    fusedScore: 1,
  } as FusedRow;
}

describe('scoreRows — same-language boost', () => {
  const now = Date.parse('2026-02-01T00:00:00Z');
  const score = (lang: string | null, boost: { lang: string } | null): number =>
    scoreRows({ rows: [fused(lang)], now, langBoost: boost })[0]!.score;

  it('off (langBoost null) → factor exactly 1.0 regardless of row lang', () => {
    expect(score('en', null)).toBeCloseTo(score('ru', null), 12);
    expect(score(null, null)).toBeCloseTo(score('en', null), 12);
  });

  it('on + matching language → gentle multiplicative boost (> baseline)', () => {
    const baseline = score('en', null);
    expect(score('en', { lang: 'en' })).toBeCloseTo(baseline * 1.15, 12);
  });

  it('on + mismatched language or langless row → factor 1.0 (demote, never drop)', () => {
    const baseline = score('en', null);
    expect(score('ru', { lang: 'en' })).toBeCloseTo(baseline, 12);
    expect(score(null, { lang: 'en' })).toBeCloseTo(baseline, 12);
  });

  it('surfaces the factor in the breakdown only when it bites', () => {
    const scored = scoreRows({
      rows: [fused('en'), fused('ru')],
      now,
      langBoost: { lang: 'en' },
    });
    expect(scored[0]!.breakdown.langBoost).toBeCloseTo(1.15, 12);
    expect('langBoost' in scored[1]!.breakdown).toBe(false);
  });
});

// ── where-builder ──────────────────────────────────────────────────────

const dto = (extra: Partial<SearchDto> = {}): SearchDto => ({ query: 'x', ...extra }) as SearchDto;

describe('buildBaseWhere — soft same-language filter', () => {
  const base = {
    dto: dto(),
    asOf: null,
    includeRetracted: false,
    includeContested: false,
  } as const;

  it('OFF-path is byte-identical: the hard lang exclusion is emitted', () => {
    const { sql, params } = buildBaseWhere({ ...base, opts: { langFilter: 'en' } });
    expect(sql).toContain('AND (lang = $langFilter OR lang IS NONE)');
    expect(params.langFilter).toBe('en');
  });

  it('langBoost drops the exclusion entirely (ranking signal, not a filter)', () => {
    const { sql, params } = buildBaseWhere({
      ...base,
      opts: { langFilter: 'en', langBoost: true },
    });
    expect(sql).not.toContain('lang = $langFilter');
    expect(params.langFilter).toBeUndefined();
  });

  it('the rest of the WHERE is unchanged whether or not the exclusion is present', () => {
    const withFilter = buildBaseWhere({ ...base, opts: { langFilter: 'en' } }).sql;
    const boosted = buildBaseWhere({ ...base, opts: { langFilter: 'en', langBoost: true } }).sql;
    // The only difference is the single lang clause line.
    const strip = (s: string): string =>
      s
        .split('\n')
        .filter((l) => !l.includes('lang = $langFilter'))
        .join('\n');
    expect(strip(withFilter)).toBe(strip(boosted));
  });
});

// ── Tuning plumbing ────────────────────────────────────────────────────

describe('resolveSearchTuning — multilingual flags', () => {
  it('both default off', () => {
    const t = resolveSearchTuning({} as NodeJS.ProcessEnv);
    expect(t.softLangFilter).toBe(false);
    expect(t.langAttribution).toBe(false);
  });

  it('resolve to true when set', () => {
    const t = resolveSearchTuning({
      [SOFT]: '1',
      [ATTR]: 'true',
    } as unknown as NodeJS.ProcessEnv);
    expect(t.softLangFilter).toBe(true);
    expect(t.langAttribution).toBe(true);
  });
});

// ── Telemetry ──────────────────────────────────────────────────────────

describe('MetricsService.recordLangAttribution', () => {
  it('emits the labelled counter and the per-surface confidence histogram', async () => {
    const metrics = new MetricsService();
    metrics.recordLangAttribution({
      lang: 'ru',
      source: 'fact',
      confidence: 0.9,
      detectorVersion: DETECTOR_VERSION,
    });
    metrics.recordLangAttribution({
      lang: 'en',
      source: 'query',
      confidence: 0.4,
      detectorVersion: DETECTOR_VERSION,
    });
    const { body } = await metrics.serialize();
    expect(body).toMatch(
      new RegExp(
        `brain_lang_attribution_total\\{lang="ru",source="fact",detectorVersion="${DETECTOR_VERSION}"\\} 1`,
      ),
    );
    expect(body).toContain('brain_lang_attribution_confidence_count{source="fact"} 1');
    expect(body).toContain('brain_lang_attribution_confidence_count{source="query"} 1');
  });
});

// ── Resolver stamping ──────────────────────────────────────────────────

describe('FactResolverService — attribution stamp', () => {
  function make(metrics?: MetricsService) {
    const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const db = {
      query: jest.fn(async (sql: string, params: Record<string, unknown>) => {
        queries.push({ sql, params });
        if (sql.includes('fn::resolve_fact(')) {
          return [{ factId: 'knowledge_fact:x1', outcome: 'INSERTED' }];
        }
        return [];
      }),
    };
    const factEmbedding = { embed: jest.fn(async () => [0.1]) };
    const predicateRegistry = {
      getSnapshot: jest.fn(async () => ({})),
      policyFor: jest.fn(() => ({ semantics: 'append_only' })),
    };
    const svc = new FactResolverService(
      factEmbedding as never,
      predicateRegistry as never,
      metrics,
    );
    return { svc, db, queries };
  }

  const input = (object: string, sourceLang?: string) => ({
    companyId: 'c',
    entityId: 'knowledge_entity:e1',
    predicate: 'preference',
    object,
    ...(sourceLang ? { sourceLang } : {}),
    confidence: 0.9,
    validFrom: new Date('2026-01-01T00:00:00Z'),
    source: {},
    precomputedEmbedding: [0.1],
  });

  const factCall = (qs: Array<{ sql: string; params: Record<string, unknown> }>) =>
    qs.find((q) => q.sql.includes('fn::resolve_fact('));
  const stampCall = (qs: Array<{ sql: string; params: Record<string, unknown> }>) =>
    qs.find((q) => q.sql.includes('langSource ='));

  it('OFF → Phase-4 `en` lang, and no attribution UPDATE (byte-identical)', async () => {
    await withEnvAsync(ATTR, undefined, async () => {
      const { svc, db, queries } = make();
      await svc.resolve(db as never, input('OK', 'ru'));
      expect(factCall(queries)!.params.lang).toBe('en');
      expect(stampCall(queries)).toBeUndefined();
    });
  });

  it('ON + detectable object → langSource="detected"', async () => {
    await withEnvAsync(ATTR, '1', async () => {
      const { svc, db, queries } = make();
      await svc.resolve(db as never, input('The quick brown fox jumps over the lazy dog'));
      expect(factCall(queries)!.params.lang).toBe('en');
      const stamp = stampCall(queries)!;
      expect(stamp.params.langSource).toBe('detected');
      expect(stamp.params.detectorVersion).toBe(DETECTOR_VERSION);
    });
  });

  it('ON + undetectable object + known sourceLang → inherit it, langSource="inherited"', async () => {
    await withEnvAsync(ATTR, '1', async () => {
      const metrics = new MetricsService();
      const { svc, db, queries } = make(metrics);
      await svc.resolve(db as never, input('OK', 'ru'));
      // The short object inherits the source-turn language as its contentLang.
      expect(factCall(queries)!.params.lang).toBe('ru');
      const stamp = stampCall(queries)!;
      expect(stamp.params.langSource).toBe('inherited');
      expect(stamp.params.sourceLang).toBe('ru');
      const { body } = await metrics.serialize();
      expect(body).toContain('source="fact"');
    });
  });
});

async function withEnvAsync(
  key: string,
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}
