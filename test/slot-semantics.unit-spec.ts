import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FactResolverService,
  VALUE_BEARING_ASPECTS,
  derivedSemanticsFor,
} from '../src/ingest/fact-resolver.service';
import type { FactEmbeddingService } from '../src/ingest/fact-embedding.service';
import type { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import { resolveExtractionProfile } from '../src/ai/extraction-profile';

/**
 * V9 §1 (derived-world lifecycle) + V9 phase 0 (the resolver fence).
 *
 * Batch derive hardcoded append_only, so derived worlds had no
 * supersede and no competing — knowledge_update answered stale values
 * and the contradiction lane starved. Under DERIVER_SLOT_SEMANTICS,
 * value-bearing aspects take 'bitemporal_event' (migration 0083):
 * similarity+interval-gated pool, event-time recency,
 * later-validFrom-wins supersede. And the V8 conv-42 failure ("Cannot
 * execute UPDATE statement using value: NONE") is fenced twice — a
 * NONE-guard after CREATE ONLY in the fn, and a per-row retry/skip in
 * resolveDerivedBatch.
 */

const ALL_ASPECTS = [
  'identity',
  'residence',
  'family',
  'relationships',
  'pets',
  'activities',
  'work',
  'education',
  'health',
  'possessions',
  'events',
  'plans',
  'preferences',
  'media',
  'travel',
  'other',
  'assistance',
];

describe('derivedSemanticsFor (aspect classes)', () => {
  it('value-bearing aspects take bitemporal_event when the flag asks', () => {
    for (const a of VALUE_BEARING_ASPECTS) {
      expect(derivedSemanticsFor(a, true)).toBe('bitemporal_event');
    }
  });

  it('event-like aspects stay append_only even with the flag on', () => {
    for (const a of ALL_ASPECTS.filter((x) => !VALUE_BEARING_ASPECTS.has(x))) {
      expect(derivedSemanticsFor(a, true)).toBe('append_only');
    }
  });

  it('flag off → append_only for everything (byte-identical writes)', () => {
    for (const a of ALL_ASPECTS) {
      expect(derivedSemanticsFor(a, false)).toBe('append_only');
    }
  });
});

function makeResolver(): FactResolverService {
  const embedding = {
    embed: async () => [1, 0],
  } as unknown as FactEmbeddingService;
  const registry = {
    getSnapshot: async () => ({}),
    policyFor: () => ({ semantics: 'append_only', decayHalfLifeDays: null, piiClass: 'none' }),
  } as unknown as PredicateRegistryService;
  return new FactResolverService(embedding, registry);
}

const derivedRow = (predicate: string, object = 'x') => ({
  entityId: 'knowledge_entity:e1',
  predicate,
  object,
  embedding: [1, 0],
  confidence: 0.85,
  validFrom: new Date('2026-01-01'),
  source: { vertical: 'derived', recorder: 'wd-v9' },
  sourceTrust: 0.5,
  derivedVersion: 'wd-v9',
});

describe('resolveDerivedBatch (V9 §1 semantics + phase 0 fence)', () => {
  it('stamps per-row semantics by aspect class under slotSemantics', async () => {
    const svc = makeResolver();
    const calls: Array<Record<string, unknown>> = [];
    const db = {
      query: async <T,>(_sql: string, params?: Record<string, unknown>) => {
        calls.push(params ?? {});
        const facts = params?.facts as unknown[];
        return [facts.map(() => ({ outcome: 'INSERTED' }))] as unknown as T;
      },
    };
    await svc.resolveDerivedBatch(
      db,
      [derivedRow('work'), derivedRow('events')],
      { slotSemantics: true },
    );
    const facts = calls[0].facts as Array<{ semantics: string }>;
    expect(facts.map((f) => f.semantics)).toEqual([
      'bitemporal_event',
      'append_only',
    ]);
  });

  it('default (no opts) stays append_only for every aspect', async () => {
    const svc = makeResolver();
    const calls: Array<Record<string, unknown>> = [];
    const db = {
      query: async <T,>(_sql: string, params?: Record<string, unknown>) => {
        calls.push(params ?? {});
        const facts = params?.facts as unknown[];
        return [facts.map(() => ({ outcome: 'INSERTED' }))] as unknown as T;
      },
    };
    await svc.resolveDerivedBatch(db, [derivedRow('work')]);
    const facts = calls[0].facts as Array<{ semantics: string }>;
    expect(facts[0].semantics).toBe('append_only');
  });

  it('fence: a failed batch degrades to per-row, skipping only the poisoned row', async () => {
    const svc = makeResolver();
    let call = 0;
    const db = {
      query: async <T,>(_sql: string, params?: Record<string, unknown>) => {
        call += 1;
        const facts = params?.facts as Array<{ object: string }>;
        if (facts.length > 1) {
          throw new Error('Cannot execute UPDATE statement using value: NONE');
        }
        if (facts[0].object === 'poison') {
          throw new Error('Cannot execute UPDATE statement using value: NONE');
        }
        return [facts.map(() => ({ outcome: 'INSERTED' }))] as unknown as T;
      },
    };
    const out = await svc.resolveDerivedBatch(db, [
      derivedRow('work', 'good-1'),
      derivedRow('events', 'poison'),
      derivedRow('plans', 'good-2'),
    ]);
    expect(call).toBe(4); // 1 failed batch + 3 per-row retries
    expect(out.map((o) => o.outcome)).toEqual([
      'INSERTED',
      'SKIPPED',
      'INSERTED',
    ]);
    expect(out[1].reason).toContain('UPDATE statement using value: NONE');
  });
});

describe('migration 0083 (the stored-fn side)', () => {
  const sql = readFileSync(
    join(__dirname, '../src/db/migrations/0083_derived_slot_semantics.surql'),
    'utf-8',
  );

  it('fences the CREATE-returned-NONE crash before any UPDATE', () => {
    expect(sql).toContain('IF $new = NONE OR $new.id = NONE');
    expect(sql).toContain("'create_returned_none'");
    // The fence must sit BEFORE the first $new.id dereference.
    expect(sql.indexOf('IF $new = NONE')).toBeLessThan(
      sql.indexOf('UPDATE $new.id'),
    );
  });

  it('bitemporal_event: event-time recency + later-validFrom-wins supersede', () => {
    expect(sql).toContain("IF $semantics = 'bitemporal_event' THEN validFrom ELSE recordedAt END");
    expect(sql).toContain(
      "($semantics = 'bitemporal_event' AND $valid_from > $best_opp.validFrom)",
    );
    // The backdated guard covers bitemporal_event too.
    expect(sql).toContain(
      "IF $semantics = 'single_active' OR $semantics = 'bitemporal_event' THEN",
    );
    // The reject gate covers both bitemporal forms.
    expect(sql).toContain(
      "($semantics = 'bitemporal' OR $semantics = 'bitemporal_event') AND $new_score < $reject_threshold",
    );
  });

  it('keeps the 24-arg signature (no arity change, no caller churn)', () => {
    expect(sql).toContain('$predicate_alias: option<string>');
    expect(sql).not.toContain('DEFINE FUNCTION OVERWRITE fn::resolve_facts');
  });
});

describe('DERIVER_SLOT_SEMANTICS flag plumbing', () => {
  it('resolves through the extraction profile, default off', () => {
    expect(
      resolveExtractionProfile({} as NodeJS.ProcessEnv).deriveSlotSemantics,
    ).toBe(false);
    expect(
      resolveExtractionProfile({
        DERIVER_SLOT_SEMANTICS: '1',
      } as NodeJS.ProcessEnv).deriveSlotSemantics,
    ).toBe(true);
  });
});
