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
      query: async <T>(_sql: string, params?: Record<string, unknown>) => {
        calls.push(params ?? {});
        const facts = params?.facts as unknown[];
        return [facts.map(() => ({ outcome: 'INSERTED' }))] as unknown as T;
      },
    };
    await svc.resolveDerivedBatch(db, [derivedRow('work'), derivedRow('events')], {
      slotSemantics: true,
    });
    const facts = calls[0]!.facts as Array<{ semantics: string }>;
    expect(facts.map((f) => f.semantics)).toEqual(['bitemporal_event', 'append_only']);
  });

  it('default (no opts) stays append_only for every aspect', async () => {
    const svc = makeResolver();
    const calls: Array<Record<string, unknown>> = [];
    const db = {
      query: async <T>(_sql: string, params?: Record<string, unknown>) => {
        calls.push(params ?? {});
        const facts = params?.facts as unknown[];
        return [facts.map(() => ({ outcome: 'INSERTED' }))] as unknown as T;
      },
    };
    await svc.resolveDerivedBatch(db, [derivedRow('work')]);
    const facts = calls[0]!.facts as Array<{ semantics: string }>;
    expect(facts[0]!.semantics).toBe('append_only');
  });

  it('fence: a failed batch degrades to per-row, skipping only the poisoned row', async () => {
    const svc = makeResolver();
    let call = 0;
    const db = {
      query: async <T>(_sql: string, params?: Record<string, unknown>) => {
        call += 1;
        const facts = params?.facts as Array<{ object: string }>;
        if (facts.length > 1) {
          throw new Error('Cannot execute UPDATE statement using value: NONE');
        }
        if (facts[0]!.object === 'poison') {
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
    expect(out.map((o) => o.outcome)).toEqual(['INSERTED', 'SKIPPED', 'INSERTED']);
    expect(out[1]!.reason).toContain('UPDATE statement using value: NONE');
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
    expect(sql.indexOf('IF $new = NONE')).toBeLessThan(sql.indexOf('UPDATE $new.id'));
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
    expect(resolveExtractionProfile({} as NodeJS.ProcessEnv).deriveSlotSemantics).toBe(false);
    expect(
      resolveExtractionProfile({
        DERIVER_SLOT_SEMANTICS: '1',
      } as NodeJS.ProcessEnv).deriveSlotSemantics,
    ).toBe(true);
  });
});

describe('migration 0084 (day-granular supersede + slot cosine gate)', () => {
  const sql = readFileSync(
    join(__dirname, '../src/db/migrations/0084_slot_supersede_day_granularity.surql'),
    'utf-8',
  );

  it('bitemporal_event supersedes by DAY, not datetime', () => {
    // V9 diagnosis: occurred_on parses to T00:00 while the sessionDate
    // fallback carries hh:mm of the SAME day — the raw `>` fabricated
    // knowledge updates out of same-day paraphrases.
    expect(sql).toContain(
      "($semantics = 'bitemporal_event' AND time::floor($valid_from, 1d) > time::floor($best_opp.validFrom, 1d))",
    );
    expect(sql).not.toContain(
      "($semantics = 'bitemporal_event' AND $valid_from > $best_opp.validFrom)",
    );
  });

  it('the backdated guard is day-granular for bitemporal_event only', () => {
    expect(sql).toContain('WHERE time::floor(validFrom, 1d) > time::floor($valid_from, 1d)');
    // single_active keeps the raw comparison.
    expect(sql).toContain('WHERE validFrom > $valid_from');
  });

  it('bitemporal_event gates on its own cosine threshold with fallback', () => {
    expect(sql).toContain('$slot_similarity: option<float>');
    expect(sql).toContain('($slot_similarity ?? $similarity_threshold)');
    expect(sql).toContain('>= $eff_similarity');
    // The shared-threshold literal must be gone from the pool gate.
    expect(sql).not.toContain('>= $similarity_threshold');
  });

  it('redefines the batch wrapper in lockstep (25th positional arg)', () => {
    expect(sql).toContain('DEFINE FUNCTION OVERWRITE fn::resolve_facts');
    expect(sql).toContain('$f.predicate_alias, $cfg.slot_similarity');
  });

  it('carries the 0083 fence and event-time recency forward', () => {
    expect(sql).toContain('IF $new = NONE OR $new.id = NONE');
    expect(sql).toContain("'create_returned_none'");
    expect(sql).toContain("IF $semantics = 'bitemporal_event' THEN validFrom ELSE recordedAt END");
  });
});

describe('migration 0085 (pairwise closure + competing re-admission)', () => {
  const sql = readFileSync(
    join(__dirname, '../src/db/migrations/0085_slot_supersede_pairwise_closure.surql'),
    'utf-8',
  );

  it('F1: supersede closes only strictly-earlier-day members', () => {
    expect(sql).toContain('WHERE time::floor(validFrom, 1d) < time::floor($valid_from, 1d)');
    // The pool-wide loser walk is gone; the loop runs over $losers.
    expect(sql).toContain('FOR $loser IN $losers');
    expect(sql).not.toContain('FOR $loser IN $competing');
    // Contested same/later-day members flip to competing, stay open.
    expect(sql).toContain(
      "UPDATE knowledge_fact SET status = 'competing' WHERE id IN $day_peers.id",
    );
    expect(sql).toContain('supersededFactIds: $losers.id');
  });

  it('F1: the decision partitions the pool, not the best_opp pair', () => {
    // Event order decides per member; the pairwise best_opp comparison
    // (which masked the strictly-older row when best_opp was the
    // same-day peer) is gone, and so is the dead margin path for this
    // semantics (0084 declared it unreachable for batch-derived rows).
    expect(sql).toContain("($semantics = 'bitemporal_event' AND array::len($losers) > 0)");
    expect(sql).toContain(
      "($semantics != 'bitemporal_event' AND $new_score >= $best_opp_score + $margin_for_supersede)",
    );
    expect(sql).not.toContain(
      "($semantics = 'bitemporal_event' AND time::floor($valid_from, 1d) > time::floor($best_opp.validFrom, 1d))",
    );
  });

  it('F3: bitemporal_event re-admits competing rows to the pool', () => {
    expect(sql).toContain("OR (status = 'competing' AND $semantics = 'bitemporal_event')");
  });

  it('keeps the 0084 signature — no mapper redefinition', () => {
    expect(sql).toContain('$slot_similarity: option<float>');
    expect(sql).not.toContain('DEFINE FUNCTION OVERWRITE fn::resolve_facts');
  });

  it('carries the 0083 fence and the day-granular backdated guard forward', () => {
    expect(sql).toContain('IF $new = NONE OR $new.id = NONE');
    expect(sql).toContain('WHERE time::floor(validFrom, 1d) > time::floor($valid_from, 1d)');
  });
});

describe('window-deriver targeted re-derive (audit F2)', () => {
  it('revives cross-conversation losers before the scoped delete', () => {
    const src = readFileSync(join(__dirname, '../src/admin/window-deriver.service.ts'), 'utf-8');
    expect(src).toContain('validUntil = priorValidUntil');
    expect(src).toContain('supersededBy IN (');
    expect(src).toContain('source.conversationId != $conv');
    // The revive must precede the conversation-scoped delete in the
    // SAME statement batch (other DELETEs exist elsewhere in the file).
    const revive = src.indexOf("status = 'active',\n          supersededBy = NONE");
    expect(revive).toBeGreaterThan(-1);
    const delAfter = src.indexOf('DELETE knowledge_fact', revive);
    expect(delAfter).toBeGreaterThan(revive);
    expect(delAfter - revive).toBeLessThan(700);
  });
});

describe('DERIVER_SLOT_SIMILARITY plumbing', () => {
  it('both resolver call sites pass the slot threshold', () => {
    const src = readFileSync(join(__dirname, '../src/ingest/fact-resolver.service.ts'), 'utf-8');
    // Batch cfg key (fn::resolve_facts maps it positionally).
    expect(src).toContain('slot_similarity: this.conflict.slotSimilarityThreshold');
    // Inline 25-arg call.
    expect(src).toContain('$predicate_alias, $slot_similarity');
    expect(src).toContain("this.cfgNum('DERIVER_SLOT_SIMILARITY', 0.9)");
  });
});
