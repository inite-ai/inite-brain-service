import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal } from 'surrealdb';
import { LRUCache } from '../common/lru-cache';
import { envFlagEnabled } from '../common/env-validation';
import { MetricsService } from '../metrics/metrics.service';
import { SurrealService, queryRows } from '../db/surreal.service';
import { compilePolicySet, denyAllSet } from './policy-compile';
import { CompiledPolicySet, MAX_SETS_PER_KEY, PolicyContext, PolicyDocument } from './policy.types';

/** Who is asking: credential hash + claim-carried set names + acting client. */
export interface PolicySubject {
  keyHash: string;
  claimNames?: readonly string[] | undefined;
  actorId?: string | undefined;
}

/** Raw access_policy row: name is stringified, document is compiled. */
interface AccessPolicyRow {
  name: unknown;
  mode?: unknown;
  document: unknown;
}

/** Raw policy_binding row: subject → attached policy set names. */
interface PolicyBindingRow {
  subject: unknown;
  policyNames?: unknown;
}

interface TenantPolicySnapshot {
  /** Compiled sets by name — disabled/inactive sets are absent here… */
  sets: Map<string, CompiledPolicySet>;
  /** …but present here, so "disabled" can be told apart from "missing". */
  knownNames: Set<string>;
  /** subject ('key:<hash>' / 'jwt:<sub>') → attached set names. */
  bindings: Map<string, string[]>;
  loadedAt: number;
  /** `policy_meta:current.version` read just BEFORE the tables (0141). */
  version: number;
  /** When `version` was last confirmed against the database. */
  checkedAt: number;
}

/** Raw `policy_meta:current` row — the coherence counter every writer bumps. */
interface PolicyMetaRow {
  version?: unknown;
}

/** How stale a cached snapshot may be before its version is re-checked. */
const COHERENCE_MS = 5_000;

/**
 * Turns (companyId, keyHash, JWT claim names) into a per-request
 * PolicyContext without adding a DB round-trip: one query per tenant per
 * TTL loads and compiles every set + binding, then every request is a
 * couple of Map lookups. A tenant with zero policy sets caches an empty
 * snapshot (the tombstone) and contextFor returns null immediately —
 * ABAC-free tenants pay one lookup per TTL, nothing per request.
 *
 * Cross-instance coherence: CRUD invalidates in-process and bumps the
 * tenant's `policy_meta:current` counter in the same write; every other
 * replica re-reads that one row at most once per COHERENCE_MS and
 * reloads when it moved, so a tightened policy is enforced everywhere
 * within five seconds instead of POLICY_CACHE_TTL_MS. The TTL remains
 * the full-reload backstop.
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
  private readonly checks = new Map<string, Promise<number>>();
  private readonly ttlMs: number;
  private readonly enabled: boolean;
  private readonly forceReportOnly: boolean;

  constructor(
    private readonly surreal: SurrealService,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.enabled = envFlagEnabled(config.get<string>('ABAC_ENABLED'));
    this.forceReportOnly = envFlagEnabled(config.get<string>('ABAC_FORCE_REPORT_ONLY'));
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
  async contextFor(companyId: string, subject: PolicySubject): Promise<PolicyContext | null> {
    if (!this.enabled) return null;
    const { keyHash, claimNames, actorId } = subject;
    const snap = await this.snapshot(companyId);

    const names: string[] = [];
    const seen = new Set<string>();
    let truncated = false;
    const push = (n: string) => {
      if (seen.has(n)) return;
      // At the cap a NEW set is silently dropped — and a dropped set may
      // be the deny set, so the overflow FAILS OPEN. Flag it so the
      // operator gets a warn + metric instead of a silent weakening.
      if (names.length >= MAX_SETS_PER_KEY) {
        truncated = true;
        return;
      }
      seen.add(n);
      names.push(n);
    };
    for (const n of snap.bindings.get(`key:${keyHash}`) ?? []) push(n);
    // JWT keys without a jti hash to `jwt:<sub>` — honour bindings
    // written against that stable subject too.
    if (keyHash.startsWith('jwt:')) {
      for (const n of snap.bindings.get(keyHash) ?? []) push(n);
    }
    // Per-agent bindings: a tenant can attach sets to the ACTING client
    // (`agent:<client_id>`) regardless of which credential it presents.
    if (actorId) {
      for (const n of snap.bindings.get(`agent:${actorId}`) ?? []) push(n);
    }
    for (const n of claimNames ?? []) push(n);
    if (truncated) {
      this.metrics.countPolicySetsTruncated();
      this.logger.warn(
        `Key ${keyHash.slice(0, 16)}… resolves to more than ${MAX_SETS_PER_KEY} policy sets — overflow dropped (fail-open; prune the binding/claims)`,
      );
    }
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
    if (cached && Date.now() - cached.loadedAt < this.ttlMs) {
      if (await this.stillCurrent(companyId, cached)) return cached;
    }

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

  /**
   * Within COHERENCE_MS of the last check the snapshot is trusted as is;
   * past it, one point read of the tenant's version decides. A failed
   * read trusts the snapshot (and is logged) rather than reloading —
   * the TTL still bounds that.
   */
  private async stillCurrent(companyId: string, cached: TenantPolicySnapshot): Promise<boolean> {
    const now = Date.now();
    if (now - cached.checkedAt < COHERENCE_MS) return true;
    let checking = this.checks.get(companyId);
    if (!checking) {
      checking = this.readVersion(companyId).finally(() => this.checks.delete(companyId));
      this.checks.set(companyId, checking);
    }
    try {
      const current = await checking;
      cached.checkedAt = Date.now();
      return current === cached.version;
    } catch (e) {
      cached.checkedAt = Date.now();
      this.logger.warn(
        `Policy version check failed for ${companyId}, trusting cached snapshot: ${(e as Error).message}`,
      );
      return true;
    }
  }

  private async readVersion(companyId: string): Promise<number> {
    return this.surreal.withCompany(companyId, (db) => readPolicyVersion(db));
  }

  private async loadFresh(companyId: string): Promise<TenantPolicySnapshot> {
    return this.surreal.withCompany(companyId, async (db) => {
      // Version FIRST: a write that lands between this read and the table
      // reads leaves a snapshot that is newer than its version, and the
      // next check reloads it; the other order would miss that write.
      const version = await readPolicyVersion(db);
      const policyRows = await queryRows<AccessPolicyRow>(
        db,
        `SELECT name, mode, document FROM access_policy`,
      );
      const bindingRows = await queryRows<PolicyBindingRow>(
        db,
        `SELECT subject, policyNames FROM policy_binding`,
      );
      const sets = new Map<string, CompiledPolicySet>();
      const knownNames = new Set<string>();
      for (const r of policyRows) {
        const name = String(r.name);
        knownNames.add(name);
        const compiled = compilePolicySet(r.document as PolicyDocument);
        if (compiled) sets.set(name, compiled);
      }
      const bindings = new Map<string, string[]>();
      for (const r of bindingRows) {
        bindings.set(String(r.subject), ((r.policyNames as string[]) ?? []).map(String));
      }
      const now = Date.now();
      return { sets, knownNames, bindings, loadedAt: now, version, checkedAt: now };
    });
  }
}

/** The tenant's coherence counter; 0 until the first policy write. */
async function readPolicyVersion(db: Surreal): Promise<number> {
  const rows = await queryRows<PolicyMetaRow>(db, `SELECT version FROM policy_meta:current`);
  const raw = Number(rows[0]?.version ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}
