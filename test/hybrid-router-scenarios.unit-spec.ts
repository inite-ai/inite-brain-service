/**
 * Hybrid-router scenarios — input/expected pairs covering the
 * cumulative local pre-pass from Sprints 1-4.5 (route cache, embedding
 * hints, learned collapse patterns, NLI intent + skip gate).
 *
 * Each scenario exercises the deterministic decisions that happen
 * BEFORE the LLM call. The full ChatRouterService integration with
 * OpenAI is intentionally not mocked here — these scenarios validate
 * the local decision surface in isolation so a regression in
 * heuristics, threshold tuning, or skip logic is caught locally
 * without needing live API keys.
 *
 * Aggregate metric tracked: skip-rate over the scenario table — gives
 * a single number the operator can chart over time.
 */
import type { ConfigService } from '@nestjs/config';
import {
  classifyIntentLocally,
  shouldSkipLLM,
} from '../src/admin/chat-router.service';
import {
  ChatRouterCacheService,
} from '../src/admin/chat-router-cache.service';
import {
  extractCollapseEditsLocally,
  type CollapseSnapshot,
} from '../src/admin/collapse-pattern.service';

const cfg = (data: Record<string, string> = {}): ConfigService =>
  ({
    get: (k: string, def?: string) => data[k] ?? def,
  }) as unknown as ConfigService;

const span = (text: string, start = 0) => ({
  text,
  start,
  end: start + text.length,
});

interface Scenario {
  name: string;
  message: string;
  knownNames: string[];
  collapseSnapshot?: CollapseSnapshot;
  // Stubbed pre-pass outputs (computed by the scenario, asserting
  // shape — not the embedding-based predicate hints which need a
  // live embedder).
  expected: {
    intent: 'ask' | 'tell';
    intentConfidence: number;
    skipAllowed: boolean;
    // Whether the message expresses a state-change verb the demo cares
    // about ("moved", "moves", "joined", "switched"). When `cached`
    // describes what the per-tenant collapse_pattern table already
    // contains, the lookup either finds it (skip-eligible TELL) or
    // misses (LLM safety net).
    cachedCollapseHits?: number;
  };
  // For ASK-skip scenarios: at least one hint must exist for skip to
  // pass shouldSkipLLM. The scenario tells us whether we should
  // simulate a positive hint or not (real hints come from the
  // embedding pipeline, mocked here to keep the test sync).
  mockHints?: Array<{ predicateId: string; similarity: number }>;
  mockMentions?: Array<{ canonical: string }>;
}

const collapseSnapshotWith = (
  pairs: Array<[string, string]>,
): CollapseSnapshot => {
  const m = new Map<string, { pattern: string; replacement: string }>();
  for (const [pattern, replacement] of pairs) {
    m.set(pattern.toLowerCase(), { pattern, replacement });
  }
  return { patterns: m };
};

const SCENARIOS: Scenario[] = [
  // ── ASK scenarios ───────────────────────────────────────────────────
  {
    name: 'ASK: demo step 3 — "where Maria lives?"',
    message: 'where Maria lives?',
    knownNames: ['Maria Petrov'],
    mockMentions: [{ canonical: 'Maria Petrov' }],
    mockHints: [{ predicateId: 'address', similarity: 0.62 }],
    expected: {
      intent: 'ask',
      intentConfidence: 0.95,
      skipAllowed: true,
    },
  },
  {
    name: 'ASK: demo step 4 — "where Maria lives next month?"',
    message: 'where Maria lives next month?',
    knownNames: ['Maria Petrov'],
    mockMentions: [{ canonical: 'Maria Petrov' }],
    mockHints: [{ predicateId: 'address', similarity: 0.58 }],
    expected: {
      intent: 'ask',
      intentConfidence: 0.95,
      skipAllowed: true,
    },
  },
  {
    name: 'ASK: Russian — "где живёт Мария?"',
    message: 'где живёт Мария?',
    knownNames: ['Мария'],
    mockMentions: [{ canonical: 'Мария' }],
    mockHints: [{ predicateId: 'address', similarity: 0.55 }],
    expected: {
      intent: 'ask',
      intentConfidence: 0.95,
      skipAllowed: true,
    },
  },
  {
    name: 'ASK: question without `?` — punctuation-fallback (LLM safety)',
    message: 'where Maria lives',
    knownNames: ['Maria Petrov'],
    mockMentions: [{ canonical: 'Maria Petrov' }],
    mockHints: [{ predicateId: 'address', similarity: 0.62 }],
    expected: {
      intent: 'tell',
      intentConfidence: 0.7,
      skipAllowed: false, // intent below floor 0.85 unless NLI overrides
    },
  },
  {
    name: 'ASK: ? with no mentions — LLM safety net',
    message: 'what is the latest news?',
    knownNames: ['Maria Petrov'],
    mockMentions: [],
    mockHints: [{ predicateId: 'status', similarity: 0.5 }],
    expected: {
      intent: 'ask',
      intentConfidence: 0.95,
      skipAllowed: false, // no mentions
    },
  },
  {
    name: 'ASK: ? with mentions but no hints — LLM safety net',
    message: 'what about Maria?',
    knownNames: ['Maria Petrov'],
    mockMentions: [{ canonical: 'Maria Petrov' }],
    mockHints: [],
    expected: {
      intent: 'ask',
      intentConfidence: 0.95,
      skipAllowed: false, // no hints
    },
  },

  // ── TELL scenarios ──────────────────────────────────────────────────
  {
    name: 'TELL: demo step 1 — long state-change sentence (cold cache)',
    message:
      'Maria Petrov is our new CTO at Acme. She moved from Berlin and prefers vegan lunch.',
    knownNames: ['Maria Petrov', 'Acme'],
    mockMentions: [{ canonical: 'Maria Petrov' }, { canonical: 'Acme' }],
    collapseSnapshot: collapseSnapshotWith([]), // first-time — empty cache
    expected: {
      intent: 'tell',
      intentConfidence: 0.7,
      skipAllowed: false,
      cachedCollapseHits: 0,
    },
  },
  {
    name: 'TELL: demo step 1 replay — warm cache',
    message:
      'Maria Petrov is our new CTO at Acme. She moved from Berlin and prefers vegan lunch.',
    knownNames: ['Maria Petrov', 'Acme'],
    mockMentions: [{ canonical: 'Maria Petrov' }, { canonical: 'Acme' }],
    collapseSnapshot: collapseSnapshotWith([['moved from', 'lives in']]),
    expected: {
      intent: 'tell',
      intentConfidence: 0.7,
      skipAllowed: false, // intent floor blocks tell; route cache would skip
      cachedCollapseHits: 1,
    },
  },
  {
    name: 'TELL: demo step 2 — "Maria moves to Dublin next month"',
    message: 'Maria moves to Dublin next month',
    knownNames: ['Maria Petrov'],
    mockMentions: [{ canonical: 'Maria Petrov' }],
    collapseSnapshot: collapseSnapshotWith([['moves to', 'lives in']]),
    expected: {
      intent: 'tell',
      intentConfidence: 0.7,
      skipAllowed: false,
      cachedCollapseHits: 1,
    },
  },
  {
    name: 'TELL: simple declarative — no state-change verb',
    message: 'Maria is the CTO',
    knownNames: ['Maria Petrov'],
    mockMentions: [{ canonical: 'Maria Petrov' }],
    collapseSnapshot: collapseSnapshotWith([['moves to', 'lives in']]),
    expected: {
      intent: 'tell',
      intentConfidence: 0.7,
      skipAllowed: false,
      cachedCollapseHits: 0,
    },
  },

  // ── Edge cases ──────────────────────────────────────────────────────
  {
    name: 'EDGE: empty message',
    message: '',
    knownNames: ['Maria Petrov'],
    mockMentions: [],
    expected: {
      intent: 'tell',
      intentConfidence: 0,
      skipAllowed: false,
    },
  },
  {
    name: 'EDGE: trailing whitespace after `?`',
    message: 'where Maria lives?   ',
    knownNames: ['Maria Petrov'],
    mockMentions: [{ canonical: 'Maria Petrov' }],
    mockHints: [{ predicateId: 'address', similarity: 0.62 }],
    expected: {
      intent: 'ask',
      intentConfidence: 0.95,
      skipAllowed: true,
    },
  },
];

describe('Hybrid router scenarios — punctuation intent', () => {
  for (const s of SCENARIOS) {
    it(s.name, () => {
      const intent = classifyIntentLocally(s.message);
      expect(intent.intent).toBe(s.expected.intent);
      expect(intent.confidence).toBe(s.expected.intentConfidence);
    });
  }
});

describe('Hybrid router scenarios — collapse cache lookup', () => {
  for (const s of SCENARIOS) {
    if (s.collapseSnapshot === undefined) continue;
    it(s.name, () => {
      const hits = extractCollapseEditsLocally(s.message, s.collapseSnapshot!);
      expect(hits.length).toBe(s.expected.cachedCollapseHits ?? 0);
    });
  }
});

describe('Hybrid router scenarios — skip gate', () => {
  for (const s of SCENARIOS) {
    it(s.name, () => {
      const intent = classifyIntentLocally(s.message);
      const collapseHits = s.collapseSnapshot
        ? extractCollapseEditsLocally(s.message, s.collapseSnapshot)
        : [];
      const decision = shouldSkipLLM({
        intent: intent.intent,
        intentConfidence: intent.confidence,
        intentConfidenceFloor: 0.85,
        localMentions: (s.mockMentions ?? []).map((m) => ({
          canonical: m.canonical,
          span: span(m.canonical),
        })),
        localHints: (s.mockHints ?? []).map((h) => ({
          predicateId: h.predicateId,
          similarity: h.similarity,
          triggerSpan: span(s.message),
        })),
        localCollapses: collapseHits,
      });
      expect(decision.skip).toBe(s.expected.skipAllowed);
    });
  }
});

describe('Hybrid router scenarios — route cache key isolation', () => {
  const cache = new ChatRouterCacheService(cfg());

  it('demo step 3 and step 4 produce different cache keys (different message)', () => {
    const k3 = cache.computeKey({
      companyId: 'demo_live',
      message: 'where Maria lives?',
      knownNames: ['Maria Petrov'],
      predicateVocab: ['address'],
      hasTemporal: false,
      now: new Date('2026-06-14T10:00:00Z'),
    });
    const k4 = cache.computeKey({
      companyId: 'demo_live',
      message: 'where Maria lives next month?',
      knownNames: ['Maria Petrov'],
      predicateVocab: ['address'],
      hasTemporal: true,
      now: new Date('2026-06-14T10:00:00Z'),
    });
    expect(k3).not.toBe(k4);
  });

  it('same temporal query in same UTC day reuses cache', () => {
    const args = (now: Date) => ({
      companyId: 'demo_live',
      message: 'where Maria lives next month?',
      knownNames: ['Maria Petrov'],
      predicateVocab: ['address'],
      hasTemporal: true,
      now,
    });
    const k1 = cache.computeKey(args(new Date('2026-06-14T02:00:00Z')));
    const k2 = cache.computeKey(args(new Date('2026-06-14T22:00:00Z')));
    expect(k1).toBe(k2);
  });

  it('different tenants do not share cache', () => {
    const a = cache.computeKey({
      companyId: 'demo_live',
      message: 'where Maria lives?',
      knownNames: ['Maria Petrov'],
      predicateVocab: ['address'],
      hasTemporal: false,
      now: new Date('2026-06-14T10:00:00Z'),
    });
    const b = cache.computeKey({
      companyId: 'other_tenant',
      message: 'where Maria lives?',
      knownNames: ['Maria Petrov'],
      predicateVocab: ['address'],
      hasTemporal: false,
      now: new Date('2026-06-14T10:00:00Z'),
    });
    expect(a).not.toBe(b);
  });
});

describe('Hybrid router scenarios — aggregate skip rate', () => {
  it('reports skip rate over the scenario table for trend tracking', () => {
    let skips = 0;
    let total = 0;
    const breakdown: Record<string, number> = {};
    for (const s of SCENARIOS) {
      total++;
      const intent = classifyIntentLocally(s.message);
      const collapseHits = s.collapseSnapshot
        ? extractCollapseEditsLocally(s.message, s.collapseSnapshot)
        : [];
      const decision = shouldSkipLLM({
        intent: intent.intent,
        intentConfidence: intent.confidence,
        intentConfidenceFloor: 0.85,
        localMentions: (s.mockMentions ?? []).map((m) => ({
          canonical: m.canonical,
          span: span(m.canonical),
        })),
        localHints: (s.mockHints ?? []).map((h) => ({
          predicateId: h.predicateId,
          similarity: h.similarity,
          triggerSpan: span(s.message),
        })),
        localCollapses: collapseHits,
      });
      if (decision.skip) skips++;
      breakdown[decision.reason] = (breakdown[decision.reason] ?? 0) + 1;
    }
    const rate = skips / total;
    // Snapshot the current floor — if heuristics improve, this floor
    // should be RAISED (not lowered). The failing test forces an
    // explicit acknowledgement instead of silent drift.
    expect(rate).toBeGreaterThanOrEqual(0.25);
    // Surface the breakdown via console so a CI run preserves it.
     
    console.log(
      `Hybrid router scenario skip-rate: ${(rate * 100).toFixed(1)}%  breakdown=${JSON.stringify(breakdown)}`,
    );
  });
});
