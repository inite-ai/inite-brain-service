/**
 * MULTILINGUAL_LANG_STAMP_CONFIDENCE_GATE — confidence gate on the
 * WRITE-side language stamp (fact-resolver buildResolveCall +
 * derive-row-builder), the mirror of the read-side k07 fix (#456).
 *
 * Measured root being closed: at write time the detector labeled the
 * object "120 requests per minute" `it` off the lone Italian stopword
 * "per" (confidence 0.33) and the row was stamped `lang: 'it'` — the
 * hard `lang = 'en' OR lang IS NONE` search filter then hid it from
 * English queries, and ANY future lang-aware consumer inherits the same
 * mislabel. #456 gated the read side; this gates the stamp itself.
 *
 * Gate ON ⇒ a DETECTION below the shared high-confidence floor (the same
 * LANG_HIGH_CONFIDENCE = 0.5 the query-side gate and the Tier-1 soft
 * boost trust) stamps `lang` NONE while the attribution metadata keeps
 * what the detector said (detectedLang + langConfidence +
 * detectorVersion — withholding is never silent). Only the authoritative
 * `lang` column is withheld: the detected script stays, and the
 * inherited-language path (sourceLang onto a detector-`und` object) is
 * untouched — a WEAK detection does not divert to inheritance.
 * Gate OFF (default) ⇒ any non-`und` detection stamps, byte-identical.
 */
import {
  detectLanguage,
  DETECTOR_VERSION,
  LANG_HIGH_CONFIDENCE,
  langStampConfidenceGateEnabled,
} from '../src/ai/locale/language-detector';
import { buildDerivedRows } from '../src/admin/derive-row-builder';
import { FactResolverService } from '../src/ingest/fact-resolver.service';
import { MetricsService } from '../src/metrics/metrics.service';
import type { EpisodeRow } from '../src/episodes/session-window';
import type { DerivedProposition } from '../src/admin/deriver-client';

const GATE = 'MULTILINGUAL_LANG_STAMP_CONFIDENCE_GATE';
const ATTR = 'MULTILINGUAL_LANG_ATTRIBUTION';

// The measured k07 write-side shape: one Italian stopword, weak evidence.
const LOW_CONF_OBJECT = '120 requests per minute';
// en@0.5 — sits exactly ON the floor (inclusive: still stamped).
const FLOOR_OBJECT = 'The cat sat on the mat';

async function withEnv(
  pairs: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const saved = new Map(Object.keys(pairs).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(pairs)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── The shared floor and the flag read ─────────────────────────────────

describe('the shared confidence floor', () => {
  it('is the one 0.5 floor the read-side gate already trusts', () => {
    expect(LANG_HIGH_CONFIDENCE).toBe(0.5);
  });

  it('langStampConfidenceGateEnabled defaults off; env flag flips it (per-call)', async () => {
    await withEnv({ [GATE]: undefined }, () => {
      expect(langStampConfidenceGateEnabled()).toBe(false);
    });
    await withEnv({ [GATE]: '1' }, () => {
      expect(langStampConfidenceGateEnabled()).toBe(true);
    });
    await withEnv({ [GATE]: '0' }, () => {
      expect(langStampConfidenceGateEnabled()).toBe(false);
    });
  });

  it('the k07 fixture really is a below-floor detection', () => {
    const det = detectLanguage(LOW_CONF_OBJECT, false);
    expect(det.language).toBe('it');
    expect(det.confidence).toBeLessThan(LANG_HIGH_CONFIDENCE);
  });
});

// ── Fact resolver (live ingest path) ───────────────────────────────────

describe('FactResolverService — write-side stamp gate', () => {
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
    predicate: 'rate_limit',
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

  it('gate OFF (pin) → the below-floor detection stamps lang as today, no detectedLang', async () => {
    await withEnv({ [GATE]: undefined, [ATTR]: '1' }, async () => {
      const { svc, db, queries } = make();
      await svc.resolve(db as never, input(LOW_CONF_OBJECT));
      expect(factCall(queries)!.params.lang).toBe('it');
      expect(factCall(queries)!.params.script).toBe('Latn');
      const stamp = stampCall(queries)!;
      expect(stamp.params.langSource).toBe('detected');
      expect(stamp.sql).not.toContain('detectedLang');
      expect('detectedLang' in stamp.params).toBe(false);
    });
  });

  it('gate OFF + attribution OFF (pin) → Phase-4 stamp, no attribution UPDATE at all', async () => {
    await withEnv({ [GATE]: undefined, [ATTR]: undefined }, async () => {
      const { svc, db, queries } = make();
      await svc.resolve(db as never, input(LOW_CONF_OBJECT));
      expect(factCall(queries)!.params.lang).toBe('it');
      expect(stampCall(queries)).toBeUndefined();
    });
  });

  it('gate ON → below-floor detection stamps lang NONE, keeps script + full langMeta', async () => {
    await withEnv({ [GATE]: '1', [ATTR]: '1' }, async () => {
      const { svc, db, queries } = make();
      await svc.resolve(db as never, input(LOW_CONF_OBJECT));
      const call = factCall(queries)!;
      // Only the authoritative lang column is withheld …
      expect(call.params.lang).toBeUndefined();
      // … the detected script stays (character classes are certain even
      // when the language guess is weak) …
      expect(call.params.script).toBe('Latn');
      // … and the metadata stays honest about what the detector said.
      const stamp = stampCall(queries)!;
      expect(stamp.params.langSource).toBe('detected');
      expect(stamp.params.detectedLang).toBe('it');
      expect(stamp.params.langConfidence).toBeCloseTo(1 / 3, 6);
      expect(stamp.params.detectorVersion).toBe(DETECTOR_VERSION);
    });
  });

  it('gate ON → an at/above-floor detection is stamped exactly as today (floor inclusive)', async () => {
    await withEnv({ [GATE]: '1', [ATTR]: '1' }, async () => {
      const { svc, db, queries } = make();
      await svc.resolve(db as never, input(FLOOR_OBJECT));
      expect(factCall(queries)!.params.lang).toBe('en');
      const stamp = stampCall(queries)!;
      expect(stamp.params.langSource).toBe('detected');
      expect('detectedLang' in stamp.params).toBe(false);
    });
  });

  it('gate ON → the inheritance branch (detector-`und` + sourceLang) is untouched', async () => {
    await withEnv({ [GATE]: '1', [ATTR]: '1' }, async () => {
      const { svc, db, queries } = make();
      await svc.resolve(db as never, input('OK', 'ru'));
      expect(factCall(queries)!.params.lang).toBe('ru');
      const stamp = stampCall(queries)!;
      expect(stamp.params.langSource).toBe('inherited');
      expect(stamp.params.sourceLang).toBe('ru');
      expect('detectedLang' in stamp.params).toBe(false);
    });
  });

  it('gate ON → a WEAK detection with a sourceLang does NOT divert to inheritance', async () => {
    await withEnv({ [GATE]: '1', [ATTR]: '1' }, async () => {
      const { svc, db, queries } = make();
      await svc.resolve(db as never, input(LOW_CONF_OBJECT, 'ru'));
      // Withheld, not replaced by the source-turn language — the object
      // DID carry (weak) signal of its own; re-stamping sourceLang over
      // it would trade one guess for another.
      expect(factCall(queries)!.params.lang).toBeUndefined();
      const stamp = stampCall(queries)!;
      expect(stamp.params.langSource).toBe('detected');
      expect(stamp.params.detectedLang).toBe('it');
      expect(stamp.params.sourceLang).toBe('ru');
    });
  });

  it('gate ON + attribution OFF → withholding is never silent (meta still stamped)', async () => {
    await withEnv({ [GATE]: '1', [ATTR]: undefined }, async () => {
      const { svc, db, queries } = make();
      await svc.resolve(db as never, input(LOW_CONF_OBJECT));
      expect(factCall(queries)!.params.lang).toBeUndefined();
      const stamp = stampCall(queries)!;
      expect(stamp.params.langSource).toBe('detected');
      expect(stamp.params.detectedLang).toBe('it');
    });
  });

  it('gate ON + attribution ON → telemetry reports the DETECTED language, not the withheld column', async () => {
    await withEnv({ [GATE]: '1', [ATTR]: '1' }, async () => {
      const metrics = new MetricsService();
      const { svc, db } = make(metrics);
      await svc.resolve(db as never, input(LOW_CONF_OBJECT));
      const { body } = await metrics.serialize();
      expect(body).toMatch(
        new RegExp(
          `brain_lang_attribution_total\\{lang="it",source="fact",detectorVersion="${DETECTOR_VERSION}"\\} 1`,
        ),
      );
    });
  });

  it('gate ON + attribution OFF → an above-floor detection stays byte-identical (no meta)', async () => {
    await withEnv({ [GATE]: '1', [ATTR]: undefined }, async () => {
      const { svc, db, queries } = make();
      await svc.resolve(db as never, input(FLOOR_OBJECT));
      expect(factCall(queries)!.params.lang).toBe('en');
      expect(stampCall(queries)).toBeUndefined();
    });
  });
});

// ── Derive row builder (derived-world facts) ───────────────────────────

describe('buildDerivedRows — write-side stamp gate', () => {
  const SESSION: EpisodeRow[] = [
    {
      id: 'episode:t0',
      speaker: 'Alice',
      text: 'a turn',
      occurredAt: '2026-08-01T10:00:00Z',
    },
  ] as EpisodeRow[];

  function build(proposition: string) {
    return buildDerivedRows({
      resolved: [
        {
          p: {
            subject: 'Alice',
            aspect: 'work',
            proposition,
            occurred_on: null,
            turns: [0],
          } as DerivedProposition,
          entityId: 'knowledge_entity:alice',
        },
      ],
      vectors: [[1, 0]],
      sessionDate: new Date('2026-08-01T00:00:00Z'),
      session: SESSION,
      ns: { final: 'wd-t', staging: 'wd-t.staging' } as never,
      conversationId: 'conv-1',
    });
  }

  it('gate OFF (pin) → the below-floor detection stamps lang as today', async () => {
    await withEnv({ [GATE]: undefined }, () => {
      const row = build(LOW_CONF_OBJECT)[0]!;
      expect(row.lang).toBe('it');
      expect(row.script).toBe('Latn');
    });
  });

  it('gate ON → below-floor detection withholds lang, keeps script', async () => {
    await withEnv({ [GATE]: '1' }, () => {
      const row = build(LOW_CONF_OBJECT)[0]!;
      expect(row.lang).toBeUndefined();
      expect(row.script).toBe('Latn');
    });
  });

  it('gate ON → an at/above-floor detection is stamped as today', async () => {
    await withEnv({ [GATE]: '1' }, () => {
      expect(build(FLOOR_OBJECT)[0]!.lang).toBe('en');
      // Non-Latin scripts detect at block-fraction confidence — far above
      // the floor — so real cross-lingual rows keep their stamp.
      const ru = build('Мария работает директором в Акме.')[0]!;
      expect(ru.lang).toBe('ru');
      expect(ru.script).toBe('Cyrl');
    });
  });
});
