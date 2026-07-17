import { Injectable, Logger } from '@nestjs/common';
import { EmbedderService } from './embedder.service';
import { PredicateRegistryService } from './predicate-registry.service';
import { PACK_NAMESPACE_SEP } from './domain-packs/manifest';
import type {
  PredicateSnapshot,
  PredicateDefinition,
} from './predicate-registry-internals/types';
import { cosineSimilarity } from '../common/vector-math';
import { envFlagEnabled } from '../common/env-validation';

/**
 * Domain-routed retrieval (SEARCH_DOMAIN_ROUTING_ENABLED, default off).
 *
 * Domain packs namespace their predicates as `<packId>__<localId>`, and
 * until this service the namespace was invisible to retrieval: the
 * predicate-router LLM classified over a fixed core vocabulary, and no
 * stage ever narrowed candidates to the domain a query is about. On a
 * tenant with several packs installed, a query about a lease retrieves
 * `hr__*` and `fintech__*` facts on the same embedding neighbourhood.
 *
 * The domain signal computed here is deliberately NOT an extra LLM
 * call. The registry snapshot already carries an embedding per active
 * predicate, and the query embedding is prewarmed before the pipeline —
 * so a domain affinity is one LRU-hit embed plus in-process cosines,
 * grouped per pack namespace. Downstream the signal is consumed twice:
 *
 *  - boost: matched-domain facts get `× (1 + α·sim)` at scoring time
 *    (SEARCH_DOMAIN_BOOST_ALPHA, zero recall risk);
 *  - vocab: the predicate-router LLM prompt/schema is extended with the
 *    tenant's pack predicates so predBoost covers them (cache-keyed by
 *    the snapshot versionHash, so pack installs bust it automatically).
 *
 * Filter-mode candidate narrowing (SEARCH_DOMAIN_ROUTING_MODE=filter)
 * consumes `narrowTo` — core predicates are never excluded, and no
 * matched domain means no filter.
 *
 * Every failure path returns null: no snapshot, no pack predicates, no
 * embeddings, embed error — search behaves exactly as before.
 */
export interface RouterVocabEntry {
  /** Key the router LLM scores — a namespaced predicate id, or a pack id
   *  when the tenant's pack vocabulary exceeds the cap (degraded to one
   *  domain-level entry per pack; see `expandTo`). */
  id: string;
  label: string;
  /** One prompt line of guidance, derived from the predicate card. */
  hint: string;
  /** Domain-level entries only: member predicates the returned weight
   *  fans out to after classification. */
  expandTo?: string[];
}

export interface RouterVocabulary {
  entries: RouterVocabEntry[];
  /** Registry snapshot versionHash — the router's cache-bust signal. */
  version: string;
}

export interface DomainAffinity {
  /** Pack id (the `<packId>` of `<packId>__<localId>`). */
  domain: string;
  /** max cosine(query, member-predicate embedding) over the domain. */
  sim: number;
  predicateIds: string[];
}

export interface DomainSignal {
  version: string;
  vocab: RouterVocabulary;
  /** Every pack domain on the tenant, sorted by sim desc. */
  affinities: DomainAffinity[];
  /** Domains at or above SEARCH_DOMAIN_ROUTING_MIN_SIM. */
  matched: DomainAffinity[];
  /** Scoring-stage boost input — matched pack predicate → domain sim.
   *  Null when no domain matched (factor stays exactly 1.0). */
  boost: { simByPredicate: Record<string, number>; alpha: number } | null;
  /** Filter-mode allow-list: core ∪ matched-domain predicates. Null when
   *  no domain matched — no narrowing. */
  narrowTo: string[] | null;
}

interface DomainIndexEntry {
  packId: string;
  predicateIds: string[];
  /** [predicateId, embedding] for members that have one. */
  embedded: Array<[string, number[]]>;
  labels: string[];
}

interface DomainIndex {
  corePredicateIds: string[];
  domains: Map<string, DomainIndexEntry>;
  packPredicateCount: number;
}

const DEFAULT_MIN_SIM = 0.3;
const DEFAULT_VOCAB_MAX = 24;
const DEFAULT_BOOST_ALPHA = 0.3;
const HINT_MAX_CHARS = 100;

@Injectable()
export class DomainRoutingService {
  private readonly logger = new Logger(DomainRoutingService.name);
  // Memoized per snapshot OBJECT — the registry's TTL/LRU owns the
  // lifecycle, so the index can never outlive the rows it was built from.
  private readonly indexMemo = new WeakMap<PredicateSnapshot, DomainIndex>();

  constructor(
    private readonly registry: PredicateRegistryService,
    private readonly embedder: EmbedderService,
  ) {}

  isEnabled(): boolean {
    return envFlagEnabled(process.env.SEARCH_DOMAIN_ROUTING_ENABLED);
  }

  /** `filter` narrows retrieval legs (PR2); anything else means boost-only. */
  mode(): 'boost' | 'filter' {
    return process.env.SEARCH_DOMAIN_ROUTING_MODE === 'filter'
      ? 'filter'
      : 'boost';
  }

  async getDomainSignal(
    companyId: string,
    query: string,
  ): Promise<DomainSignal | null> {
    if (!this.isEnabled() || !query.trim()) return null;
    try {
      const snapshot = await this.registry.getSnapshot(companyId);
      const index = this.indexFor(snapshot);
      if (index.domains.size === 0) return null;

      const queryEmbedding = await this.embedder.embed(query);
      const affinities: DomainAffinity[] = [];
      for (const entry of index.domains.values()) {
        let sim = 0;
        for (const [, emb] of entry.embedded) {
          const s = cosineSimilarity(queryEmbedding, emb);
          if (s > sim) sim = s;
        }
        affinities.push({
          domain: entry.packId,
          sim,
          predicateIds: entry.predicateIds,
        });
      }
      affinities.sort((a, b) => b.sim - a.sim);

      const minSim = floatEnv('SEARCH_DOMAIN_ROUTING_MIN_SIM', DEFAULT_MIN_SIM);
      const matched = affinities.filter((a) => a.sim >= minSim);
      const simByPredicate: Record<string, number> = {};
      for (const m of matched) {
        for (const pid of m.predicateIds) simByPredicate[pid] = m.sim;
      }
      const alpha = floatEnv('SEARCH_DOMAIN_BOOST_ALPHA', DEFAULT_BOOST_ALPHA);

      return {
        version: snapshot.versionHash,
        vocab: this.vocabFor(snapshot, index),
        affinities,
        matched,
        boost: matched.length ? { simByPredicate, alpha } : null,
        narrowTo: matched.length
          ? [
              ...index.corePredicateIds,
              ...matched.flatMap((m) => m.predicateIds),
            ]
          : null,
      };
    } catch (err) {
      this.logger.warn(
        `domain signal failed (fail-open): ${(err as Error).message}`,
      );
      return null;
    }
  }

  private indexFor(snapshot: PredicateSnapshot): DomainIndex {
    const memo = this.indexMemo.get(snapshot);
    if (memo) return memo;
    const domains = new Map<string, DomainIndexEntry>();
    const corePredicateIds: string[] = [];
    let packPredicateCount = 0;
    for (const def of snapshot.active) {
      const sep = def.predicateId.indexOf(PACK_NAMESPACE_SEP);
      if (sep <= 0) {
        corePredicateIds.push(def.predicateId);
        continue;
      }
      packPredicateCount += 1;
      const packId = def.predicateId.slice(0, sep);
      const entry =
        domains.get(packId) ??
        ({
          packId,
          predicateIds: [],
          embedded: [],
          labels: [],
        } as DomainIndexEntry);
      entry.predicateIds.push(def.predicateId);
      entry.labels.push(def.displayLabel);
      const emb = snapshot.embeddings.get(def.predicateId);
      if (emb) entry.embedded.push([def.predicateId, emb]);
      domains.set(packId, entry);
    }
    const index = { corePredicateIds, domains, packPredicateCount };
    this.indexMemo.set(snapshot, index);
    return index;
  }

  private vocabFor(
    snapshot: PredicateSnapshot,
    index: DomainIndex,
  ): RouterVocabulary {
    const vocabMax = intEnv('SEARCH_DOMAIN_ROUTER_VOCAB_MAX', DEFAULT_VOCAB_MAX);
    const entries: RouterVocabEntry[] = [];
    if (index.packPredicateCount <= vocabMax) {
      for (const domain of index.domains.values()) {
        for (const pid of domain.predicateIds) {
          const def = snapshot.byId.get(pid);
          entries.push({
            id: pid,
            label: def?.displayLabel ?? pid,
            hint: hintFrom(def),
          });
        }
      }
    } else {
      // Degrade to one domain-level line per pack; the router's weight
      // fans out to member predicates after classification.
      for (const domain of index.domains.values()) {
        entries.push({
          id: domain.packId,
          label: domain.packId,
          hint: `domain pack covering: ${domain.labels.slice(0, 6).join(', ')}`,
          expandTo: domain.predicateIds,
        });
      }
    }
    return { entries, version: snapshot.versionHash };
  }
}

/** First sentence of the predicate card, truncated — one prompt line. */
function hintFrom(def: PredicateDefinition | undefined): string {
  const raw = (def?.description ?? '').replace(/\s+/g, ' ').trim();
  const sentence = raw.split(/(?<=[.!?])\s/, 1)[0] ?? '';
  const hint = sentence || def?.displayLabel || '';
  return hint.length > HINT_MAX_CHARS
    ? `${hint.slice(0, HINT_MAX_CHARS - 1)}…`
    : hint;
}

function floatEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function intEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}
