import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LRUCache } from '../common/lru-cache';
import { envFlagEnabled } from '../common/env-validation';
import { MetricsService } from '../metrics/metrics.service';
import { SurrealService } from '../db/surreal.service';
import { compilePolicySet, denyAllSet } from './policy-compile';
import {
  CompiledPolicySet,
  MAX_SETS_PER_KEY,
  PolicyContext,
  PolicyDocument,
} from './policy.types';

interface TenantPolicySnapshot {
  /** Compiled sets by name — disabled/inactive sets are absent here… */
  sets: Map<string, CompiledPolicySet>;
  /** …but present here, so "disabled" can be told apart from "missing". */
  knownNames: Set<string>;
  /** subject ('key:<hash>' / 'jwt:<sub>') → attached set names. */
  bindings: Map<string, string[]>;
  loadedAt: number;
}

/**
 * Turns (companyId, keyHash, JWT claim names) into a per-request
 * PolicyContext without adding a DB round-trip: one query per tenant per
 * TTL loads and compiles every set + binding, then every request is a
 * couple of Map lookups. A tenant with zero policy sets caches an empty
 * snapshot (the tombstone) and contextFor returns null immediately —
 * ABAC-free tenants pay one lookup per TTL, nothing per request.
 *
 * Cross-instance invalidation is TTL-bounded: CRUD invalidates
 * in-process; other pods converge within POLICY_CACHE_TTL_MS.
 *
 * Fail-closed: a referenced name that isn't in the tenant's table
 * resolves to a synthetic enforce deny-all set (metric + warn log).
 * A DISABLED set, by contrast, is skipped silently — turning a set off
 * is an operator action, not a dangling reference.
 */
@Injectable()
export class PolicyResolverService {
  private readonly logger = new Logger(PolicyResolverService.name);
  private readonly cache: LRUCache<string, TenantPolicySnapshot>;
  private readonly inFlight = new Map<string, Promise<TenantPolicySnapshot>>();
  private readonly ttlMs: number;
  private readonly enabled: boolean;
  private readonly forceReportOnly: boolean;

  constructor(
    private readonly surreal: SurrealService,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.enabled = envFlagEnabled(config.get<string>('ABAC_ENABLED'));
    this.forceReportOnly = envFlagEnabled(
      config.get<string>('ABAC_FORCE_REPORT_ONLY'),
    );
    const ttl = parseInt(config.get<string>('POLICY_CACHE_TTL_MS', '60000'), 10);
    this.ttlMs = Number.isFinite(ttl) && ttl >= 0 ? ttl : 60_000;
    const cap = parseInt(config.get<string>('POLICY_CACHE_CAP', '500'), 10);
    this.cache = new LRUCache(Number.isFinite(cap) && cap > 0 ? cap : 500);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Drop the tenant snapshot after a policy/binding mutation. */
  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }

  /**
   * Resolve the request's policy context. Returns null when ABAC is off
   * or the key references no policy sets — the null short-circuits every
   * enforcement point to pre-ABAC behavior.
   */
  async contextFor(
    companyId: string,
    keyHash: string,
    claimNames?: readonly string[],
  ): Promise<PolicyContext | null> {
    if (!this.enabled) return null;
    const snap = await this.snapshot(companyId);

    const names: string[] = [];
    const seen = new Set<string>();
    const push = (n: string) => {
      if (!seen.has(n) && names.length < MAX_SETS_PER_KEY) {
        seen.add(n);
        names.push(n);
      }
    };
    for (const n of snap.bindings.get(`key:${keyHash}`) ?? []) push(n);
    // JWT keys without a jti hash to `jwt:<sub>` — honour bindings
    // written against that stable subject too.
    if (keyHash.startsWith('jwt:')) {
      for (const n of snap.bindings.get(keyHash) ?? []) push(n);
    }
    for (const n of claimNames ?? []) push(n);
    if (names.length === 0) return null;

    const sets: CompiledPolicySet[] = [];
    let resolutionError = false;
    for (const name of names) {
      const compiled = snap.sets.get(name);
      if (compiled) {
        sets.push(compiled);
      } else if (!snap.knownNames.has(name)) {
        resolutionError = true;
        sets.push(denyAllSet(name));
        this.metrics.countPolicyResolutionError();
        this.logger.warn(
          `Key ${keyHash.slice(0, 16)}… references unknown policy set '${name}' — failing closed`,
        );
      }
      // known but disabled → skipped
    }
    if (sets.length === 0) return null;

    return {
      companyId,
      keyHash,
      sets,
      forceReportOnly: this.forceReportOnly,
      resolutionError,
    };
  }

  private async snapshot(companyId: string): Promise<TenantPolicySnapshot> {
    const cached = this.cache.get(companyId);
    if (cached && Date.now() - cached.loadedAt < this.ttlMs) return cached;

    let p = this.inFlight.get(companyId);
    if (!p) {
      p = this.loadFresh(companyId)
        .then((snap) => {
          this.cache.set(companyId, snap);
          return snap;
        })
        .finally(() => this.inFlight.delete(companyId));
      this.inFlight.set(companyId, p);
    }
    // A stale-but-present snapshot is served while a refresh is in
    // flight only if the load fails — otherwise wait for the fresh one
    // (policy changes should apply promptly after TTL).
    try {
      return await p;
    } catch (e) {
      if (cached) {
        this.logger.warn(
          `Policy snapshot refresh failed for ${companyId}, serving stale: ${(e as Error).message}`,
        );
        return cached;
      }
      throw e;
    }
  }

  private async loadFresh(companyId: string): Promise<TenantPolicySnapshot> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [policyRows] = await db.query<[any[]]>(
        `SELECT name, mode, document FROM access_policy`,
      );
      const [bindingRows] = await db.query<[any[]]>(
        `SELECT subject, policyNames FROM policy_binding`,
      );
      const sets = new Map<string, CompiledPolicySet>();
      const knownNames = new Set<string>();
      for (const r of (policyRows as any[]) ?? []) {
        const name = String(r.name);
        knownNames.add(name);
        const compiled = compilePolicySet(r.document as PolicyDocument);
        if (compiled) sets.set(name, compiled);
      }
      const bindings = new Map<string, string[]>();
      for (const r of (bindingRows as any[]) ?? []) {
        bindings.set(
          String(r.subject),
          ((r.policyNames as string[]) ?? []).map(String),
        );
      }
      return { sets, knownNames, bindings, loadedAt: Date.now() };
    });
  }
}
