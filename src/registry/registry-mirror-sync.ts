import { packChecksum, type DomainPackManifest } from '../ai/domain-packs';

/**
 * Pull-only registry mirroring — the pure sync core (docs/domain-packs.md).
 *
 * Consumes another Brain instance's public registry API
 * (GET /v1/registry/packs → /:packId → /:packId/:version) and replays new
 * versions into the LOCAL catalogue through the caller-supplied port — the
 * same publish path operators use, so validation / builtin-id squatting
 * protection / version immutability / local `verified` recomputation all
 * apply unchanged. Framework-free and fetch-injectable so the merge logic
 * is unit-testable without a network.
 *
 * Rules:
 *   - Local rows always win: an (id, version) that exists locally is never
 *     overwritten (skipped at debug).
 *   - Yanks mirror ONE-WAY (upstream yank → local yank) and ONLY onto rows
 *     whose `origin` matches this upstream — locally published versions are
 *     never yanked by the mirror. Unyanks are NOT mirrored.
 *   - A version that is already yanked upstream and absent locally is not
 *     imported (no point pulling known-bad content).
 *   - Every imported manifest's checksum is recomputed locally and compared
 *     against the upstream's declared checksum — a mismatch is rejected.
 *   - Work is bounded: at most `maxVersionsPerRun` manifests are fetched per
 *     run (the rest waits for the next run); each request gets its own
 *     timeout; one pack's failure never aborts the run.
 *
 * Known limitation (documented, accepted): the upstream catalogue listing
 * omits packs whose every version is yanked, so a pack fully yanked upstream
 * stops being visited and its yanks are not mirrored until/unless it lists
 * again.
 */

export interface MirrorLocalVersion {
  version: string;
  yanked: boolean;
  /** Upstream base URL the row was mirrored from; unset = local publish. */
  origin?: string | null;
}

/** Port onto the local registry — implemented over PackRegistryService. */
export interface MirrorLocalRegistry {
  versionsOf(packId: string): Promise<MirrorLocalVersion[]>;
  publish(input: {
    manifest: DomainPackManifest;
    origin: string;
    expectedChecksum: string;
  }): Promise<{ created: boolean }>;
  yank(input: { packId: string; version: string; reason?: string }): Promise<void>;
}

export interface MirrorLogger {
  log(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export interface MirrorSyncOptions {
  /** Upstream base URL (scheme + host [+ port]), no trailing slash. */
  upstreamBase: string;
  /** Optional bearer for the upstream's /v1/registry reads. */
  token?: string | undefined;
  local: MirrorLocalRegistry;
  logger: MirrorLogger;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (default 10s). */
  timeoutMs?: number;
  /** Manifest-fetch budget per run (default 200). */
  maxVersionsPerRun?: number;
  /** Outer cancellation (job lease loss / shutdown). */
  signal?: AbortSignal | undefined;
}

export interface MirrorSyncSummary {
  upstream: string;
  packsSeen: number;
  imported: number;
  skippedExisting: number;
  yanksMirrored: number;
  checksumMismatches: number;
  failures: number;
  capped: boolean;
}

/** Canonical form of the upstream URL — used verbatim as the `origin`
 *  marker, so normalization keeps the yank fence stable across config
 *  edits like a trailing slash. */
export function normalizeUpstreamBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_VERSIONS_PER_RUN = 200;
/** Catalogue page size — the upstream caps limit at 500. */
const PAGE_SIZE = 200;

interface UpstreamVersionRow {
  version: string;
  checksum?: string;
  yanked?: boolean;
  yankReason?: string | null;
}

interface SyncCtx {
  base: string;
  token?: string | undefined;
  local: MirrorLocalRegistry;
  logger: MirrorLogger;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Remaining manifest fetches this run. */
  budget: number;
  maxVersions: number;
  capped: boolean;
  summary: MirrorSyncSummary;
}

export async function syncRegistryMirror(opts: MirrorSyncOptions): Promise<MirrorSyncSummary> {
  const base = normalizeUpstreamBase(opts.upstreamBase);
  const ctx: SyncCtx = {
    base,
    token: opts.token,
    local: opts.local,
    logger: opts.logger,
    fetchImpl: opts.fetchImpl ?? fetch,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: opts.signal,
    budget: opts.maxVersionsPerRun ?? DEFAULT_MAX_VERSIONS_PER_RUN,
    maxVersions: opts.maxVersionsPerRun ?? DEFAULT_MAX_VERSIONS_PER_RUN,
    capped: false,
    summary: {
      upstream: base,
      packsSeen: 0,
      imported: 0,
      skippedExisting: 0,
      yanksMirrored: 0,
      checksumMismatches: 0,
      failures: 0,
      capped: false,
    },
  };
  const packIds = await listUpstreamPackIds(ctx);
  for (const packId of packIds) {
    if (ctx.capped || ctx.signal?.aborted) break;
    ctx.summary.packsSeen++;
    try {
      await syncPack(ctx, packId);
    } catch (e) {
      ctx.summary.failures++;
      ctx.logger.warn(`mirror: pack ${packId} failed — ${(e as Error).message}`);
    }
  }
  ctx.summary.capped = ctx.capped;
  const s = ctx.summary;
  ctx.logger.log(
    `registry mirror ${base}: packs=${s.packsSeen} imported=${s.imported} ` +
      `skipped=${s.skippedExisting} yanksMirrored=${s.yanksMirrored} ` +
      `checksumRejected=${s.checksumMismatches} failures=${s.failures}` +
      (s.capped ? ' CAPPED' : ''),
  );
  return s;
}

/** Page through the upstream catalogue collecting pack ids. */
async function listUpstreamPackIds(ctx: SyncCtx): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = (await fetchUpstreamJson(
      ctx,
      `/v1/registry/packs?limit=${PAGE_SIZE}&offset=${offset}`,
    )) as { packs?: Array<{ packId?: unknown }> };
    const packs = Array.isArray(page?.packs) ? page.packs : [];
    ids.push(...packs.map((p) => String(p.packId ?? '')).filter(Boolean));
    if (packs.length < PAGE_SIZE) return ids;
  }
}

async function syncPack(ctx: SyncCtx, packId: string): Promise<void> {
  const res = (await fetchUpstreamJson(
    ctx,
    `/v1/registry/packs/${encodeURIComponent(packId)}`,
  )) as { versions?: UpstreamVersionRow[] };
  const upstreamVersions = Array.isArray(res?.versions) ? res.versions : [];
  const localByVersion = new Map((await ctx.local.versionsOf(packId)).map((v) => [v.version, v]));
  for (const uv of upstreamVersions) {
    if (ctx.capped || ctx.signal?.aborted) return;
    const existing = localByVersion.get(uv.version);
    if (existing) {
      await reconcileExisting(ctx, { packId, upstream: uv, local: existing });
      continue;
    }
    if (uv.yanked) {
      // Born-yanked upstream and absent here: nothing installable to gain
      // by pulling known-bad content.
      ctx.logger.debug(
        `mirror: skip ${packId}@${uv.version} — yanked upstream, not present locally`,
      );
      continue;
    }
    try {
      await importVersion(ctx, { packId, row: uv });
    } catch (e) {
      ctx.summary.failures++;
      ctx.logger.warn(`mirror: import ${packId}@${uv.version} failed — ${(e as Error).message}`);
    }
  }
}

/** A version that exists locally: local rows always win — the only action
 *  ever taken is mirroring an upstream yank onto an origin-matching row. */
async function reconcileExisting(
  ctx: SyncCtx,
  args: {
    packId: string;
    upstream: UpstreamVersionRow;
    local: MirrorLocalVersion;
  },
): Promise<void> {
  const { packId, upstream, local } = args;
  const at = `${packId}@${upstream.version}`;
  if (!upstream.yanked || local.yanked) {
    ctx.summary.skippedExisting++;
    ctx.logger.debug(`mirror: skip ${at} — already present locally`);
    return;
  }
  if ((local.origin ?? null) !== ctx.base) {
    // The yank fence: never yank a locally published (or other-origin) row.
    ctx.summary.skippedExisting++;
    ctx.logger.debug(`mirror: yank fence ${at} — local row does not originate from this upstream`);
    return;
  }
  await ctx.local.yank({
    packId,
    version: upstream.version,
    reason: upstream.yankReason
      ? `mirrored yank from ${ctx.base}: ${upstream.yankReason}`
      : `mirrored yank from ${ctx.base}`,
  });
  ctx.summary.yanksMirrored++;
  ctx.logger.log(`mirror: yanked ${at} (mirrored from ${ctx.base})`);
}

async function importVersion(
  ctx: SyncCtx,
  args: { packId: string; row: UpstreamVersionRow },
): Promise<void> {
  const { packId, row } = args;
  const at = `${packId}@${row.version}`;
  if (ctx.budget <= 0) {
    ctx.capped = true;
    ctx.logger.log(
      `mirror: version budget (${ctx.maxVersions}) exhausted — remaining versions deferred to the next run`,
    );
    return;
  }
  ctx.budget--;
  const resolved = (await fetchUpstreamJson(
    ctx,
    `/v1/registry/packs/${encodeURIComponent(packId)}/${encodeURIComponent(row.version)}`,
  )) as { checksum?: string; manifest?: Record<string, unknown> };
  const manifest = resolved?.manifest as DomainPackManifest | undefined;
  if (!manifest || typeof manifest !== 'object') {
    ctx.summary.failures++;
    ctx.logger.warn(`mirror: ${at} returned no manifest — skipped`);
    return;
  }
  // A hostile/buggy upstream must not smuggle content for a DIFFERENT
  // (id, version) under this pack's URL.
  if (manifest.id !== packId || manifest.version !== row.version) {
    ctx.summary.failures++;
    ctx.logger.warn(
      `mirror: ${at} manifest identifies as ${String(manifest.id)}@${String(manifest.version)} — skipped`,
    );
    return;
  }
  // Recompute with the LOCAL checksum util; the upstream's declared value
  // (manifest response, cross-checked against its versions listing) must
  // match the content we actually received.
  const computed = packChecksum(manifest);
  const declared = String(resolved?.checksum ?? '');
  const listed = row.checksum ? String(row.checksum) : declared;
  if (computed !== declared || computed !== listed) {
    ctx.summary.checksumMismatches++;
    ctx.logger.warn(
      `mirror: rejected ${at} — checksum mismatch (declared ${declared.slice(0, 12)}…, computed ${computed.slice(0, 12)}…)`,
    );
    return;
  }
  // Same code path as an operator publish: validation, builtin-id squatting
  // protection, immutability and local trust-store `verified` recomputation
  // all apply. `origin` marks the row as mirrored.
  const { created } = await ctx.local.publish({
    manifest,
    origin: ctx.base,
    expectedChecksum: computed,
  });
  if (created) {
    ctx.summary.imported++;
    ctx.logger.log(`mirror: imported ${at} from ${ctx.base}`);
  } else {
    ctx.summary.skippedExisting++;
    ctx.logger.debug(`mirror: ${at} already present (idempotent republish)`);
  }
}

/** GET a JSON document from the upstream with a per-request timeout and
 *  optional bearer, honouring the outer abort signal. */
async function fetchUpstreamJson(ctx: SyncCtx, path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  timer.unref?.();
  const onOuterAbort = () => controller.abort();
  ctx.signal?.addEventListener('abort', onOuterAbort, { once: true });
  if (ctx.signal?.aborted) controller.abort();
  try {
    const res = await ctx.fetchImpl(`${ctx.base}${path}`, {
      headers: {
        accept: 'application/json',
        ...(ctx.token ? { authorization: `Bearer ${ctx.token}` } : {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`upstream ${path} answered HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onOuterAbort);
  }
}
