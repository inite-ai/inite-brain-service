import { BadRequestException } from '@nestjs/common';
import { envFlagNotDisabled } from './env-flag';
import { sanitizeSourceMeta, type SourceMeta } from '../policy/source-meta';

/**
 * The one gate for CALLER meta on every write route: document `meta`,
 * direct-fact `metadata` (and a raw `source.meta`), mention `meta`.
 *
 * Caller meta becomes ABAC-matchable `source.meta`, so it must be
 * operator vocabulary (src/policy/source-meta.ts). STRICT IS THE
 * DEFAULT: `SOURCE_META_STRICT` is read with `envFlagNotDisabled`, so
 * any entry the sanitizer would drop answers 400 unless the flag is
 * explicitly `0`/`false`. Only then are drops logged and the clean
 * remainder kept — a silently-dropped `data_class` would silently widen
 * access, which is why lax mode is the opt-out and not the other way
 * round.
 *
 * One machine code: `invalid_meta` (`INVALID_META`), carried as `code`
 * on every rejection. The fact route answered `error: 'invalid_metadata'`
 * before the codes were unified and still does (`legacyError`), so a
 * client matching on `error` keeps working; read `code`. The alias goes
 * in a `!` release, per AGENTS.md § Evolving data and contracts.
 */
export const INVALID_META = 'invalid_meta';

/** The fact route's pre-unification `error` value. Deprecated: read `code`. */
export const LEGACY_INVALID_METADATA = 'invalid_metadata';

export interface CallerMetaGateOptions {
  /** Called in lax mode with the drop count and the first reason. */
  warn: (count: number, first: string) => void;
  /** The `error` value this route answered before `code` existed. */
  legacyError?: string;
}

/** Strict (the default) unless SOURCE_META_STRICT is explicitly disabled. */
export function sourceMetaStrict(): boolean {
  return envFlagNotDisabled(process.env.SOURCE_META_STRICT);
}

/**
 * Sanitize a caller's meta bag: 400 on any dropped entry when strict,
 * else warn and return what survived. `undefined` in, `undefined` out.
 */
export function gateCallerMeta(raw: unknown, opts: CallerMetaGateOptions): SourceMeta | undefined {
  if (raw === undefined) return undefined;
  const { meta, dropped } = sanitizeSourceMeta(raw);
  if (dropped.length > 0) {
    if (sourceMetaStrict()) {
      throw new BadRequestException({
        error: opts.legacyError ?? INVALID_META,
        code: INVALID_META,
        issues: dropped,
      });
    }
    opts.warn(dropped.length, dropped[0] ?? '');
  }
  return meta;
}
