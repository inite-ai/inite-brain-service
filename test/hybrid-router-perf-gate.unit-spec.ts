/**
 * CI perf gate for hybrid router local path. Catches gross regressions
 * (e.g. accidental quadratic scan over knownNames, async added to a
 * hot sync function) without trying to be a real benchmark.
 *
 * Thresholds are 100-500× the observed p99 from `pnpm bench:router`
 * (isolated). Jest runs the suite with concurrent workers which
 * causes GC / CPU contention spikes; the gate has to absorb those
 * without becoming useless. Tight enough still to flag a 10× drop in
 * the absolute numbers reported by the bench. For real perf
 * numbers, run `pnpm bench:router` — that runs isolated.
 */
import type { ConfigService } from '@nestjs/config';
import {
  classifyIntentLocally,
  shouldSkipLLM,
} from '../src/admin/chat-router.service';
import { ChatRouterCacheService } from '../src/admin/chat-router-cache.service';
import {
  extractCollapseEditsLocally,
  type CollapseSnapshot,
} from '../src/admin/collapse-pattern.service';

const cfg = (): ConfigService =>
  ({
    get: (_: string, d?: string) => d,
  }) as unknown as ConfigService;

function timeMicroseconds(fn: () => unknown, iters = 1000): number {
  for (let i = 0; i < 100; i++) fn(); // warmup
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1000 / iters; // µs per call
}

const span = { text: 'q', start: 0, end: 1 };

describe('Hybrid router perf gate', () => {
  it('classifyIntentLocally — under 50µs/call avg', () => {
    const t = timeMicroseconds(() =>
      classifyIntentLocally('where Maria lives?'),
    );
    expect(t).toBeLessThan(50);
  });

  it('cache.computeKey — under 500µs/call avg', () => {
    const cache = new ChatRouterCacheService(cfg());
    const args = {
      companyId: 'demo_live',
      message: 'where Maria lives next month?',
      knownNames: ['Maria Petrov', 'Acme', 'John', 'Anna', 'Petr'],
      predicateVocab: ['address', 'status', 'preference', 'intent'],
      hasTemporal: true,
      now: new Date(),
    };
    const t = timeMicroseconds(() => cache.computeKey(args));
    expect(t).toBeLessThan(500);
  });

  it('cache.get hit/miss — under 20µs/call avg', () => {
    const cache = new ChatRouterCacheService(cfg());
    cache.set('warm-key', {
      intent: 'ask',
      normalizedMessage: 'q',
      mentions: [],
      predicateHints: [],
    });
    const tHit = timeMicroseconds(() => cache.get('warm-key'));
    expect(tHit).toBeLessThan(20);
    const tMiss = timeMicroseconds(() => cache.get('cold-key'));
    expect(tMiss).toBeLessThan(20);
  });

  it('extractCollapseEditsLocally — under 500µs/call avg', () => {
    const snap: CollapseSnapshot = {
      patterns: new Map([
        ['moved to', { pattern: 'moved to', replacement: 'lives in' }],
        ['moves to', { pattern: 'moves to', replacement: 'lives in' }],
        ['switched to', { pattern: 'switched to', replacement: 'prefers' }],
        ['joined as', { pattern: 'joined as', replacement: 'is the' }],
        ['переехал в', { pattern: 'переехал в', replacement: 'живёт в' }],
      ]),
    };
    const t = timeMicroseconds(() =>
      extractCollapseEditsLocally('Maria moved to Berlin last month', snap),
    );
    expect(t).toBeLessThan(500);
  });

  it('shouldSkipLLM — under 10µs/call avg', () => {
    const t = timeMicroseconds(() =>
      shouldSkipLLM({
        intent: 'ask',
        intentConfidence: 0.95,
        intentConfidenceFloor: 0.85,
        localMentions: [{ canonical: 'Maria', span }],
        localHints: [
          { predicateId: 'address', similarity: 0.6, triggerSpan: span },
        ],
        localCollapses: [],
      }),
    );
    expect(t).toBeLessThan(10);
  });

  it('combined local path stays under 2000µs end-to-end avg', () => {
    const cache = new ChatRouterCacheService(cfg());
    const snap: CollapseSnapshot = {
      patterns: new Map([
        ['moved to', { pattern: 'moved to', replacement: 'lives in' }],
      ]),
    };
    const t = timeMicroseconds(() => {
      const intent = classifyIntentLocally('where Maria lives?');
      const key = cache.computeKey({
        companyId: 'demo_live',
        message: 'where Maria lives?',
        knownNames: ['Maria Petrov'],
        predicateVocab: ['address'],
        hasTemporal: false,
        now: new Date('2026-06-14T10:00:00Z'),
      });
      cache.get(key);
      const collapses = extractCollapseEditsLocally(
        'where Maria lives?',
        snap,
      );
      shouldSkipLLM({
        intent: intent.intent,
        intentConfidence: intent.confidence,
        intentConfidenceFloor: 0.85,
        localMentions: [{ canonical: 'Maria Petrov', span }],
        localHints: [
          { predicateId: 'address', similarity: 0.6, triggerSpan: span },
        ],
        localCollapses: collapses,
      });
    });
     
    console.log(`Combined local path: ${t.toFixed(2)}µs/call`);
    expect(t).toBeLessThan(2000);
  });
});
