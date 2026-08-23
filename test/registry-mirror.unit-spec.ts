/**
 * Pull-only registry mirror — the pure sync core against a stubbed fetch.
 *
 * Covers the merge rules end-to-end without a network or DB: new versions
 * imported with origin + locally recomputed checksum, local rows always win,
 * one-way yank mirroring fenced to origin-matching rows, checksum-mismatch
 * rejection, the per-run version budget, and per-pack failure isolation.
 */
import {
  normalizeUpstreamBase,
  syncRegistryMirror,
  type MirrorLocalRegistry,
  type MirrorLocalVersion,
  type MirrorLogger,
} from '../src/registry/registry-mirror-sync';
import { packChecksum, type DomainPackManifest } from '../src/ai/domain-packs';

const BASE = 'https://upstream.example.com';

function manifest(id: string, version: string): DomainPackManifest {
  return {
    id,
    version,
    description: `${id} pack`,
    predicates: [],
  } as unknown as DomainPackManifest;
}

interface UpstreamVersionFixture {
  version: string;
  yanked?: boolean;
  yankReason?: string | null;
  /** Override the declared checksum (defaults to the true one). */
  checksum?: string;
  /** Override the manifest body served for this version. */
  manifest?: DomainPackManifest;
}

/** Build a fetch stub serving a fake upstream registry API. */
function fakeUpstream(packs: Record<string, UpstreamVersionFixture[]>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const path = url.replace(BASE, '');
    const json = (body: unknown) =>
      ({ ok: true, status: 200, json: async () => body }) as Response;

    if (path.startsWith('/v1/registry/packs?')) {
      const offset = Number(/offset=(\d+)/.exec(path)?.[1] ?? '0');
      const ids = Object.keys(packs).slice(offset, offset + 200);
      return json({ packs: ids.map((packId) => ({ packId })) });
    }
    const m = /^\/v1\/registry\/packs\/([^/?]+)(?:\/([^/?]+))?$/.exec(path);
    const packId = m ? decodeURIComponent(m[1]!) : '';
    const version = m?.[2] ? decodeURIComponent(m[2]) : undefined;
    const rows = packs[packId];
    if (!rows) return { ok: false, status: 404 } as Response;
    if (!version) {
      return json({
        packId,
        latestVersion: rows[0]?.version ?? null,
        versions: rows.map((r) => ({
          packId,
          version: r.version,
          checksum: r.checksum ?? packChecksum(r.manifest ?? manifest(packId, r.version)),
          yanked: Boolean(r.yanked),
          yankReason: r.yankReason ?? null,
        })),
      });
    }
    const row = rows.find((r) => r.version === version);
    if (!row) return { ok: false, status: 404 } as Response;
    const body = row.manifest ?? manifest(packId, row.version);
    return json({
      packId,
      version: row.version,
      checksum: row.checksum ?? packChecksum(body),
      yanked: Boolean(row.yanked),
      manifest: body,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** In-memory local registry port recording publishes and yanks. */
function fakeLocal(existing: Record<string, MirrorLocalVersion[]> = {}) {
  const published: Array<{
    manifest: DomainPackManifest;
    origin: string;
    expectedChecksum: string;
  }> = [];
  const yanks: Array<{ packId: string; version: string; reason?: string }> =
    [];
  const port: MirrorLocalRegistry = {
    versionsOf: async (packId) => existing[packId] ?? [],
    publish: async (input) => {
      published.push(input);
      return { created: true };
    },
    yank: async (input) => {
      yanks.push(input);
    },
  };
  return { port, published, yanks };
}

function fakeLogger() {
  const lines: string[] = [];
  const logger: MirrorLogger = {
    log: (m) => lines.push(`LOG ${m}`),
    warn: (m) => lines.push(`WARN ${m}`),
    debug: (m) => lines.push(`DEBUG ${m}`),
  };
  return { logger, lines };
}

function runSync(args: {
  upstream: ReturnType<typeof fakeUpstream>;
  local: ReturnType<typeof fakeLocal>;
  logger: ReturnType<typeof fakeLogger>;
  maxVersionsPerRun?: number;
  token?: string;
  upstreamBase?: string;
}) {
  return syncRegistryMirror({
    upstreamBase: args.upstreamBase ?? BASE,
    token: args.token,
    local: args.local.port,
    logger: args.logger.logger,
    fetchImpl: args.upstream.fetchImpl,
    maxVersionsPerRun: args.maxVersionsPerRun,
  });
}

describe('registry mirror — sync core', () => {
  it('imports a new upstream version with origin set and a locally recomputed checksum', async () => {
    const upstream = fakeUpstream({ alpha: [{ version: '1.0.0' }] });
    const local = fakeLocal();
    const logger = fakeLogger();
    const summary = await runSync({ upstream, local, logger });

    expect(summary.imported).toBe(1);
    expect(summary.checksumMismatches).toBe(0);
    expect(local.published).toHaveLength(1);
    expect(local.published[0]!.origin).toBe(BASE);
    expect(local.published[0]!.manifest.id).toBe('alpha');
    expect(local.published[0]!.expectedChecksum).toBe(
      packChecksum(manifest('alpha', '1.0.0')),
    );
  });

  it('skips a version that already exists locally (local rows always win)', async () => {
    const upstream = fakeUpstream({ alpha: [{ version: '1.0.0' }] });
    const local = fakeLocal({
      alpha: [{ version: '1.0.0', yanked: false, origin: null }],
    });
    const logger = fakeLogger();
    const summary = await runSync({ upstream, local, logger });

    expect(summary.imported).toBe(0);
    expect(summary.skippedExisting).toBe(1);
    expect(local.published).toHaveLength(0);
    expect(
      logger.lines.some((l) => l.startsWith('DEBUG') && l.includes('skip')),
    ).toBe(true);
  });

  it('mirrors an upstream yank ONLY onto rows whose origin matches this upstream', async () => {
    const upstream = fakeUpstream({
      mirrored_pack: [
        { version: '1.0.0', yanked: true, yankReason: 'CVE-2026-1' },
      ],
      local_pack: [{ version: '1.0.0', yanked: true }],
      other_origin: [{ version: '1.0.0', yanked: true }],
    });
    const local = fakeLocal({
      mirrored_pack: [{ version: '1.0.0', yanked: false, origin: BASE }],
      local_pack: [{ version: '1.0.0', yanked: false, origin: null }],
      other_origin: [
        { version: '1.0.0', yanked: false, origin: 'https://elsewhere.example' },
      ],
    });
    const logger = fakeLogger();
    const summary = await runSync({ upstream, local, logger });

    expect(summary.yanksMirrored).toBe(1);
    expect(local.yanks).toHaveLength(1);
    expect(local.yanks[0]).toMatchObject({
      packId: 'mirrored_pack',
      version: '1.0.0',
    });
    expect(local.yanks[0]!.reason).toContain('CVE-2026-1');
    // Neither the local publish nor the foreign-origin row was touched.
    expect(local.yanks.some((y) => y.packId === 'local_pack')).toBe(false);
    expect(local.yanks.some((y) => y.packId === 'other_origin')).toBe(false);
  });

  it('does not re-yank an already-yanked local row', async () => {
    const upstream = fakeUpstream({
      alpha: [{ version: '1.0.0', yanked: true }],
    });
    const local = fakeLocal({
      alpha: [{ version: '1.0.0', yanked: true, origin: BASE }],
    });
    const logger = fakeLogger();
    const summary = await runSync({ upstream, local, logger });
    expect(summary.yanksMirrored).toBe(0);
    expect(local.yanks).toHaveLength(0);
  });

  it('does not import a version that is born-yanked upstream', async () => {
    const upstream = fakeUpstream({
      alpha: [{ version: '1.0.0', yanked: true }],
    });
    const local = fakeLocal();
    const logger = fakeLogger();
    const summary = await runSync({ upstream, local, logger });
    expect(summary.imported).toBe(0);
    expect(local.published).toHaveLength(0);
  });

  it('rejects and logs a checksum mismatch (content differs from declaration)', async () => {
    const upstream = fakeUpstream({
      alpha: [{ version: '1.0.0', checksum: 'deadbeef'.repeat(8) }],
    });
    const local = fakeLocal();
    const logger = fakeLogger();
    const summary = await runSync({ upstream, local, logger });

    expect(summary.checksumMismatches).toBe(1);
    expect(summary.imported).toBe(0);
    expect(local.published).toHaveLength(0);
    expect(
      logger.lines.some(
        (l) => l.startsWith('WARN') && l.includes('checksum mismatch'),
      ),
    ).toBe(true);
  });

  it('rejects a manifest that identifies as a different (id, version)', async () => {
    const smuggled = manifest('beta', '9.9.9');
    const upstream = fakeUpstream({
      alpha: [
        {
          version: '1.0.0',
          manifest: smuggled,
          checksum: packChecksum(smuggled),
        },
      ],
    });
    const local = fakeLocal();
    const logger = fakeLogger();
    const summary = await runSync({ upstream, local, logger });
    expect(summary.imported).toBe(0);
    expect(summary.failures).toBe(1);
    expect(local.published).toHaveLength(0);
  });

  it('respects the per-run version budget and flags the run as capped', async () => {
    const upstream = fakeUpstream({
      alpha: [{ version: '1.0.0' }, { version: '1.1.0' }, { version: '1.2.0' }],
    });
    const local = fakeLocal();
    const logger = fakeLogger();
    const summary = await runSync({
      upstream,
      local,
      logger,
      maxVersionsPerRun: 2,
    });

    expect(summary.imported).toBe(2);
    expect(summary.capped).toBe(true);
    expect(local.published).toHaveLength(2);
    expect(
      logger.lines.some((l) => l.includes('budget') && l.includes('2')),
    ).toBe(true);
  });

  it('one failing pack does not abort the rest of the run', async () => {
    const upstream = fakeUpstream({ beta: [{ version: '2.0.0' }] });
    // 'broken' is listed in the catalogue but 500s on its versions endpoint.
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v1/registry/packs?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ packs: [{ packId: 'broken' }, { packId: 'beta' }] }),
        } as Response;
      }
      if (url.includes('/broken')) return { ok: false, status: 500 } as Response;
      return upstream.fetchImpl(input as string, init);
    }) as unknown as typeof fetch;

    const local = fakeLocal();
    const logger = fakeLogger();
    const summary = await syncRegistryMirror({
      upstreamBase: BASE,
      local: local.port,
      logger: logger.logger,
      fetchImpl,
    });

    expect(summary.failures).toBe(1);
    expect(summary.imported).toBe(1);
    expect(local.published[0]!.manifest.id).toBe('beta');
  });

  it('sends the bearer token when configured and omits it otherwise', async () => {
    const withToken = fakeUpstream({ alpha: [{ version: '1.0.0' }] });
    await runSync({
      upstream: withToken,
      local: fakeLocal(),
      logger: fakeLogger(),
      token: 'sekret',
    });
    expect(
      withToken.calls.every(
        (c) => c.headers.authorization === 'Bearer sekret',
      ),
    ).toBe(true);

    const noToken = fakeUpstream({ alpha: [{ version: '1.0.0' }] });
    await runSync({
      upstream: noToken,
      local: fakeLocal(),
      logger: fakeLogger(),
    });
    expect(
      noToken.calls.every((c) => c.headers.authorization === undefined),
    ).toBe(true);
  });

  it('normalizes the upstream base so a trailing slash cannot split the yank fence', async () => {
    expect(normalizeUpstreamBase(`${BASE}/`)).toBe(BASE);
    expect(normalizeUpstreamBase(` ${BASE}// `)).toBe(BASE);

    // A base configured WITH a slash still matches rows stored without one.
    const upstream = fakeUpstream({
      alpha: [{ version: '1.0.0', yanked: true }],
    });
    const local = fakeLocal({
      alpha: [{ version: '1.0.0', yanked: false, origin: BASE }],
    });
    const summary = await runSync({
      upstream,
      local,
      logger: fakeLogger(),
      upstreamBase: `${BASE}/`,
    });
    expect(summary.yanksMirrored).toBe(1);
  });
});
