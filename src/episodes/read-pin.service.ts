import { Injectable, Logger, Optional } from '@nestjs/common';
import { ProjectionRegistryService } from './projection-registry.service';

/** Short cache TTL: a world flip must land within one page-refresh. */
const CACHE_TTL_MS = 5_000;

/**
 * A resolved READ pin: one world, a UNION of worlds (multiworld §10 —
 * typed projections over one substrate are read together), or the
 * legacy namespace (null). Write/maintenance consumers (deriver,
 * dreams, compaction, communities) never take the union form — they
 * operate on exactly one world and keep using `resolve()`.
 */
export type ReadPin = string | readonly string[] | null;

/**
 * Which derived world the read path serves, per tenant.
 *
 * Audit W2 (engine-architecture-audit-2026-08.md #9): the pin used to be
 * `process.env.RETRIEVAL_DERIVED_VERSION`, MUTATED at runtime by
 * `window-deriver.run({activate:true})`. That is a per-tenant input with
 * a process-global effect — activating tenant A's world repointed every
 * other tenant on the pod at a namespace where their memory does not
 * exist; other pods and worker-role processes never saw the flip at all;
 * a restart silently rolled back; and the registry row that said
 * `status='live'` was a DB truth no reader consulted.
 *
 * Now the registry IS the pin. `projection` rows (migration 0076) are
 * per-tenant and durable, so every pod resolves the same world and a
 * restart changes nothing. The env var survives as the BOOTSTRAP default
 * for tenants with no registry row yet (eval runners pin it this way),
 * never as mutable state.
 */
@Injectable()
export class ReadPinService {
  private readonly logger = new Logger(ReadPinService.name);
  private readonly cache = new Map<
    string,
    { version: string | null; at: number }
  >();

  constructor(
    @Optional() private readonly registry?: ProjectionRegistryService,
  ) {}

  /** The env bootstrap default (no registry evidence yet, or no registry). */
  static bootstrapDefault(): string | null {
    return process.env.RETRIEVAL_DERIVED_VERSION?.trim() || null;
  }

  /**
   * Multiworld §10: the READ-union bootstrap — RETRIEVAL_DERIVED_VERSIONS
   * as a comma-separated world list. null when unset/blank, so every
   * deployment without the key is byte-identical single-pin.
   */
  static bootstrapUnion(): string[] | null {
    const raw = process.env.RETRIEVAL_DERIVED_VERSIONS;
    if (!raw?.trim()) return null;
    const pins = [
      ...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)),
    ];
    return pins.length > 0 ? pins : null;
  }

  /**
   * The READ-path pin shape for service-less callers (pure functions,
   * tests): the union bootstrap when configured — always including the
   * single-pin bootstrap so the tenant's own world stays readable —
   * else exactly `bootstrapDefault()`.
   */
  static bootstrapRead(): ReadPin {
    return ReadPinService.composeRead(ReadPinService.bootstrapDefault());
  }

  /** Fold one resolved single pin into the union bootstrap (if any). */
  private static composeRead(single: string | null): ReadPin {
    const union = ReadPinService.bootstrapUnion();
    if (!union) return single;
    const pins = single && !union.includes(single) ? [...union, single] : union;
    return pins.length === 1 ? pins[0] : pins;
  }

  /**
   * The full read set around one resolved primary pin, as a Set —
   * the shape lifecycle surfaces consume (derive rewrite guard, GC;
   * audit 2026-08-21 P1): a union-served world is as live as the
   * primary pin and must survive both.
   */
  static readSet(primary: string | null | undefined): Set<string> {
    return new Set(
      [primary, ...(ReadPinService.bootstrapUnion() ?? [])].filter(
        (v): v is string => Boolean(v),
      ),
    );
  }

  /**
   * Live derived version for this tenant, or null for the legacy
   * namespace. Registry `live` row wins; otherwise the env bootstrap.
   * Registry failures degrade to the bootstrap rather than emptying a
   * tenant's memory.
   */
  async resolve(companyId: string): Promise<string | null> {
    const cached = this.cache.get(companyId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.version;

    let version = ReadPinService.bootstrapDefault();
    if (this.registry) {
      try {
        const rows = await this.registry.list(companyId);
        const live = rows.find(
          (r) => r.name === 'facts' && r.status === 'live',
        );
        if (live) version = live.version;
      } catch (e) {
        this.logger.warn(
          `read-pin resolve fell back to the bootstrap default ` +
            `(companyId=${companyId}): ${(e as Error).message}`,
        );
      }
    }
    this.cache.set(companyId, { version, at: Date.now() });
    return version;
  }

  /**
   * Multiworld §10: the READ-path resolution — the tenant's single
   * world (registry live row, else env bootstrap) unioned with the
   * RETRIEVAL_DERIVED_VERSIONS list. No union configured → exactly
   * `resolve()`, so single-pin deployments are byte-identical. The
   * union NEVER drops the tenant's own world — extra worlds add to it.
   */
  async resolveRead(companyId: string): Promise<ReadPin> {
    return ReadPinService.composeRead(await this.resolve(companyId));
  }

  /** Drop the cached pin after an activation so readers see it at once. */
  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }
}

/**
 * The one WHERE-fragment every version-fenced consumer shares (audit W2
 * #10 — compaction was the first port, dreams the second): a resolved
 * pin scopes to that world, no pin scopes to the legacy namespace.
 * Multiworld §10: a union pin scopes to the SET of worlds (INSIDE) —
 * a one-element union collapses to the equality form so single-pin
 * consumers stay byte-identical. Interpolate `clause` into the query
 * and spread `params` into the bindings.
 */
export function derivedVersionFence(derivedVersion: ReadPin): {
  clause: string;
  params: Record<string, unknown>;
} {
  const pin = Array.isArray(derivedVersion)
    ? derivedVersion.length === 1
      ? (derivedVersion[0] as string)
      : derivedVersion.length === 0
        ? null
        : [...derivedVersion]
    : derivedVersion;
  if (Array.isArray(pin)) {
    return {
      clause: 'AND derivedVersion INSIDE $derivedVersions',
      params: { derivedVersions: pin },
    };
  }
  return pin
    ? {
        clause: 'AND derivedVersion = $derivedVersion',
        params: { derivedVersion: pin },
      }
    : { clause: 'AND derivedVersion IS NONE', params: {} };
}
