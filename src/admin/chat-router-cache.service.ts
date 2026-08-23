import { Injectable, Logger } from '@nestjs/common';
import { envFlagNotDisabled } from '../common/env-validation';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { LRUCache } from '../common/lru-cache';
import type { ChatRoute } from './chat-router.service';

/**
 * Exact-key route cache for ChatRouterService.
 *
 * Key composition encodes everything that can change the route:
 *   • NFC(message)            — same words, same route
 *   • companyId               — tenants don't share routes
 *   • knownNamesHash          — adding/removing a name changes mention resolution
 *   • predicateVocabHash      — vocab change reshapes predicateHints
 *   • nowDayBucketUTC         — only when message carries a temporal anchor
 *                               ("yesterday" relative to a different day → different ISO)
 *
 * Why exact-key (not embedding-based) for Sprint 1a:
 *   ChatRoute carries character-offset Spans into the input message. A fuzzy
 *   semantic hit would replay spans against a DIFFERENT message — offsets
 *   would not align, validation would degrade every slot. Architecturally
 *   unsafe for grounded routing. Embedding-based fuzzy is deferred (Sprint
 *   1b) and would need structural keying, not raw text similarity.
 *
 * Exact-key hits in real traffic come from:
 *   • Demo recipe replays (sales call → same script multiple times)
 *   • Eval scenario reruns
 *   • Concurrent stock queries ("where does Maria live?") across users
 *   • UI back-button / re-fetch patterns
 *
 * Cache entries are immutable ChatRoute objects — safe to share across
 * concurrent callers without cloning.
 */
@Injectable()
export class ChatRouterCacheService {
  private readonly logger = new Logger(ChatRouterCacheService.name);
  private readonly cache: LRUCache<string, ChatRoute>;
  private readonly enabled: boolean;
  private hits = 0;
  private misses = 0;

  constructor(private readonly config: ConfigService) {
    const size = parseInt(this.config.get<string>('CHAT_ROUTE_CACHE_SIZE', '1000'), 10);
    this.enabled = envFlagNotDisabled(this.config.get<string>('CHAT_ROUTE_CACHE_ENABLED'));
    this.cache = new LRUCache<string, ChatRoute>(size);
  }

  computeKey(input: {
    companyId: string;
    message: string;
    knownNames: string[];
    predicateVocab: string[];
    hasTemporal: boolean;
    now: Date;
  }): string {
    const knownNamesHash = stableArrayHash(input.knownNames);
    const vocabHash = stableArrayHash(input.predicateVocab);
    const nowBucket = input.hasTemporal
      ? input.now.toISOString().slice(0, 10) // UTC day
      : '-';
    const parts = [
      'v1',
      input.companyId,
      knownNamesHash,
      vocabHash,
      nowBucket,
      nfc(input.message),
    ].join('\x1f'); // unit separator
    return createHash('sha256').update(parts).digest('hex');
  }

  get(key: string): ChatRoute | undefined {
    if (!this.enabled) return undefined;
    const hit = this.cache.get(key);
    if (hit) this.hits++;
    else this.misses++;
    return hit;
  }

  set(key: string, route: ChatRoute): void {
    if (!this.enabled) return;
    this.cache.set(key, route);
  }

  /** Diagnostic surface — no business code depends on shape. */
  stats(): {
    size: number;
    hits: number;
    misses: number;
    hitRate: number;
    enabled: boolean;
  } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      enabled: this.enabled,
    };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }
}

function nfc(s: string): string {
  return s.normalize('NFC');
}

function stableArrayHash(arr: string[]): string {
  if (arr.length === 0) return 'empty';
  const sorted = [...arr].sort();
  return createHash('sha256').update(sorted.join('\x1e')).digest('hex').slice(0, 16);
}
