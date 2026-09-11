/**
 * Evidence sharing surface (MM-4, migration 0122) — the authorization
 * matrix and the anti-probing invariants, without a database.
 *
 * The point of the PR is that the surface is NOT an existence oracle,
 * so the sharpest assertions here are the INDISTINGUISHABILITY ones: an
 * unknown asset and an asset the caller may not touch must produce the
 * same exception shape AND the same sequence of DB queries. A future
 * "helpful" 403/404-with-message, or an early return that skips the
 * grant probe for a missing asset, fails here rather than in a probing
 * client's log.
 */
import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { EvidenceGrantService, type GrantCaller } from '../src/evidence/evidence-grant.service';
import { EvidenceGrantsController } from '../src/evidence/evidence-grants.controller';
import { EvidenceGrantsEnabledGuard } from '../src/evidence/evidence-grants.guard';
import type { EvidenceStoreService } from '../src/evidence/evidence-store.service';
import type { SurrealService } from '../src/db/surreal.service';

type Row = Record<string, unknown>;

interface DbScript {
  /** evidence_asset row (or null for "no such asset in this tenant"). */
  asset?: Row | null;
  /** live evidence_grant rows of that asset. */
  live?: Row[];
  /** evidence_grant row a revoke addresses. */
  grant?: Row | null;
}

/** A db double that answers by STATEMENT SHAPE and records every call —
 *  the recording is what the indistinguishability assertions compare. */
function mkDb(script: DbScript) {
  const calls: string[] = [];
  const vars: Array<Record<string, unknown> | undefined> = [];
  return {
    calls,
    vars,
    db: {
      query: async (sql: string, params?: Record<string, unknown>) => {
        calls.push(shapeOf(sql));
        vars.push(params);
        if (sql.includes("type::record('evidence_grant'")) {
          return [script.grant ? [script.grant] : []];
        }
        if (sql.includes('FROM evidence_grant')) return [script.live ?? []];
        if (sql.includes("type::record('evidence_asset'")) {
          return [script.asset ? [script.asset] : []];
        }
        return [[]];
      },
    },
  };
}

/** Statement shape, stripped of whitespace — two denials must agree on
 *  this sequence, not merely on the number of round-trips. */
function shapeOf(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function mkSurreal(db: unknown): SurrealService {
  return {
    withCompany: async <T>(_c: string, fn: (d: unknown) => Promise<T>): Promise<T> => fn(db),
  } as unknown as SurrealService;
}

function mkStore(overrides: Partial<EvidenceStoreService> = {}): EvidenceStoreService {
  return {
    addGrant: jest.fn(async () => ({ grantId: 'evidence_grant:new', created: true })),
    revokeGrant: jest.fn(async (_c: string, id: string) => ({ grantId: id })),
    liveGrants: jest.fn(async () => []),
    ...overrides,
  } as unknown as EvidenceStoreService;
}

const ASSET = 'evidence_asset:a1';
/** A clean, live, user-owned asset — the happy path's subject. */
const OWNED_ASSET: Row = {
  id: ASSET,
  availability: 'hot',
  quarantineStatus: 'clean',
  piiClasses: [],
  retainUntil: null,
};
const U1_GRANT: Row = { ownerKind: 'user', ownerId: 'u1' };
const M2M: GrantCaller = { scopes: ['brain:write'] };
const U1: GrantCaller = { scopes: ['brain:write'], userId: 'u1' };
const U2: GrantCaller = { scopes: ['brain:write'], userId: 'u2' };

const share = { ownerKind: 'user' as const, ownerId: 'u9', assetId: ASSET };

describe('evidence grants: the flag guard', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('404s while the surface flag is off, even with the substrate on', () => {
    process.env.EVIDENCE_SUBSTRATE_ENABLED = '1';
    process.env.EVIDENCE_GRANTS_API_ENABLED = '0';
    expect(() => new EvidenceGrantsEnabledGuard().canActivate()).toThrow(NotFoundException);
  });

  it('404s while the substrate is off (double gate — a dark seam advertises nothing)', () => {
    process.env.EVIDENCE_GRANTS_API_ENABLED = '1';
    process.env.EVIDENCE_SUBSTRATE_ENABLED = '0';
    expect(() => new EvidenceGrantsEnabledGuard().canActivate()).toThrow(NotFoundException);
  });

  it('passes only with both on', () => {
    process.env.EVIDENCE_GRANTS_API_ENABLED = '1';
    process.env.EVIDENCE_SUBSTRATE_ENABLED = '1';
    expect(new EvidenceGrantsEnabledGuard().canActivate()).toBe(true);
  });
});

describe('evidence grants: the authorization ladder', () => {
  it('an owner may share; the write seam gets the resolved asset id', async () => {
    const { db } = mkDb({ asset: OWNED_ASSET, live: [U1_GRANT] });
    const store = mkStore();
    const svc = new EvidenceGrantService(mkSurreal(db), store);
    const out = await svc.grant('co', U1, share);
    expect(out).toEqual({
      grantId: 'evidence_grant:new',
      created: true,
      assetId: ASSET,
      retainUntil: null,
    });
    expect(store.addGrant).toHaveBeenCalledWith('co', {
      assetId: ASSET,
      ownerKind: 'user',
      ownerId: 'u9',
      // Defaulted by the surface: 'share' is what this route does.
      purpose: 'share',
    });
  });

  it('an M2M key acts with tenant authority when ANY live grant exists', async () => {
    const { db } = mkDb({ asset: OWNED_ASSET, live: [{ ownerKind: 'system', ownerId: 'system' }] });
    const svc = new EvidenceGrantService(mkSurreal(db), mkStore());
    await expect(svc.grant('co', M2M, share)).resolves.toMatchObject({ assetId: ASSET });
  });

  it('a NON-READER (another tenant user) cannot grant — no escalation', async () => {
    const { db } = mkDb({ asset: OWNED_ASSET, live: [U1_GRANT] });
    const store = mkStore();
    const svc = new EvidenceGrantService(mkSurreal(db), store);
    await expect(svc.grant('co', U2, share)).rejects.toThrow(NotFoundException);
    expect(store.addGrant).not.toHaveBeenCalled();
  });

  it('an administratively dead asset (all grants revoked) grants nothing to anyone', async () => {
    const { db } = mkDb({ asset: OWNED_ASSET, live: [] });
    const svc = new EvidenceGrantService(mkSurreal(db), mkStore());
    await expect(svc.grant('co', M2M, share)).rejects.toThrow(NotFoundException);
  });

  it('media-PII polarity fences sharing exactly as it fences reading', async () => {
    const cases: Array<[unknown, string[], boolean]> = [
      // classes,     caller scopes,                          may share
      [[], ['brain:write'], true],
      [undefined, ['brain:write'], false], // unclassified = fail closed
      [['face'], ['brain:write'], false],
      [['face'], ['brain:write', 'brain:read_media'], true],
      [undefined, ['brain:write', 'brain:read_media'], true],
    ];
    for (const [piiClasses, scopes, allowed] of cases) {
      const { db } = mkDb({
        asset: { ...OWNED_ASSET, piiClasses },
        live: [U1_GRANT],
      });
      const svc = new EvidenceGrantService(mkSurreal(db), mkStore());
      const call = svc.grant('co', { scopes, userId: 'u1' }, share);
      if (allowed) await expect(call).resolves.toMatchObject({ assetId: ASSET });
      else await expect(call).rejects.toThrow(NotFoundException);
    }
  });

  it('dead, quarantined and past-retention assets are unshareable', async () => {
    const unshareable: Row[] = [
      { ...OWNED_ASSET, availability: 'gone' },
      { ...OWNED_ASSET, quarantineStatus: 'quarantined' },
      { ...OWNED_ASSET, quarantineStatus: 'scanning' },
      // A grant may not outlive the asset's own retention policy: past
      // the horizon the sweeper merely owes this row a tombstone.
      { ...OWNED_ASSET, retainUntil: new Date(Date.now() - 60_000).toISOString() },
    ];
    for (const asset of unshareable) {
      const { db } = mkDb({ asset, live: [U1_GRANT] });
      const svc = new EvidenceGrantService(mkSurreal(db), mkStore());
      await expect(svc.grant('co', U1, share)).rejects.toThrow(NotFoundException);
    }
  });

  it('a metadata-only (external) asset IS shareable — no bytes move here', async () => {
    const { db } = mkDb({
      asset: { ...OWNED_ASSET, availability: 'external' },
      live: [U1_GRANT],
    });
    const svc = new EvidenceGrantService(mkSurreal(db), mkStore());
    await expect(svc.grant('co', U1, share)).resolves.toMatchObject({ assetId: ASSET });
  });

  it('a future retention horizon rides back as the grant’s effective end', async () => {
    const retainUntil = new Date(Date.now() + 86_400_000);
    const { db } = mkDb({
      asset: { ...OWNED_ASSET, retainUntil },
      live: [U1_GRANT],
    });
    const svc = new EvidenceGrantService(mkSurreal(db), mkStore());
    await expect(svc.grant('co', U1, share)).resolves.toMatchObject({
      retainUntil: retainUntil.toISOString(),
    });
  });
});

describe('evidence grants: no existence oracle', () => {
  /** Run one verb against a scripted db and report what came back and
   *  which statements ran — the two axes a prober could read. */
  async function probe(
    script: DbScript,
    caller: GrantCaller,
    verb: 'grant' | 'list' | 'revoke' = 'grant',
  ): Promise<{ error: unknown; calls: string[] }> {
    const { db, calls } = mkDb(script);
    const svc = new EvidenceGrantService(mkSurreal(db), mkStore());
    try {
      if (verb === 'grant') await svc.grant('co', caller, share);
      else if (verb === 'list') await svc.list('co', caller, ASSET);
      else await svc.revoke('co', caller, 'evidence_grant:g1');
      return { error: null, calls };
    } catch (e) {
      const err = e as NotFoundException;
      return { error: { name: err.constructor.name, body: err.getResponse() }, calls };
    }
  }

  it('unknown asset and unauthorized asset are IDENTICAL (body and query trace)', async () => {
    const unknown = await probe({ asset: null, live: [] }, U2);
    const forbidden = await probe({ asset: OWNED_ASSET, live: [U1_GRANT] }, U2);
    expect(unknown.error).toEqual(forbidden.error);
    // The bare 404 carries no message that could name the subject.
    expect(unknown.error).toEqual({
      name: 'NotFoundException',
      body: { message: 'Not Found', statusCode: 404 },
    });
    // ...and the ladder did not short-circuit: the grant probe runs even
    // when the asset lookup found nothing, so the two denials cost the
    // same round-trips against the same indexes.
    expect(unknown.calls).toEqual(forbidden.calls);
    expect(unknown.calls).toHaveLength(2);
  });

  it('a malformed / foreign-shaped id is answered by the same 404, never a 400', async () => {
    const { db, vars } = mkDb({ asset: null, live: [] });
    const svc = new EvidenceGrantService(mkSurreal(db), mkStore());
    for (const bad of ['not-a-record-id', 'knowledge_fact:1', 'evidence_asset:', 'x'.repeat(300)]) {
      await expect(svc.list('co', M2M, bad)).rejects.toThrow(NotFoundException);
    }
    // Every malformed id collapses onto the never-matching sentinel tail
    // — the id space itself teaches nothing.
    const tails = new Set(vars.map((v) => String(v?.tail)));
    expect(tails.size).toBe(1);
  });

  it('the three verbs deny alike — the cheapest one is no better a probe', async () => {
    const grantDeny = await probe({ asset: OWNED_ASSET, live: [U1_GRANT] }, U2, 'grant');
    const listDeny = await probe({ asset: OWNED_ASSET, live: [U1_GRANT] }, U2, 'list');
    expect(listDeny.error).toEqual(grantDeny.error);
    const revokeDeny = await probe(
      { grant: { id: 'evidence_grant:g1', assetId: ASSET }, asset: OWNED_ASSET, live: [U1_GRANT] },
      U2,
      'revoke',
    );
    expect(revokeDeny.error).toEqual(grantDeny.error);
  });

  it('an unknown GRANT id costs the same trace as a foreign one', async () => {
    const unknown = await probe({ grant: null, asset: null, live: [] }, U1, 'revoke');
    const foreign = await probe(
      { grant: { id: 'evidence_grant:g1', assetId: ASSET }, asset: OWNED_ASSET, live: [U1_GRANT] },
      U2,
      'revoke',
    );
    expect(unknown.error).toEqual(foreign.error);
    expect(unknown.calls).toEqual(foreign.calls);
    expect(unknown.calls).toHaveLength(3);
  });

  it('a seam error that would NAME the subject is flattened to the bare 404', async () => {
    const { db } = mkDb({ asset: OWNED_ASSET, live: [U1_GRANT] });
    const store = mkStore({
      addGrant: jest.fn(async () => {
        throw new ConflictException('asset evidence_asset:a1 is no longer available');
      }) as unknown as EvidenceStoreService['addGrant'],
    });
    const svc = new EvidenceGrantService(mkSurreal(db), store);
    await expect(svc.grant('co', U1, share)).rejects.toMatchObject({
      response: { message: 'Not Found', statusCode: 404 },
    });
  });

  it('the write gate (503) is NOT flattened — operator state is not a denial', async () => {
    const { db } = mkDb({ asset: OWNED_ASSET, live: [U1_GRANT] });
    const store = mkStore({
      addGrant: jest.fn(async () => {
        throw new ServiceUnavailableException('EVIDENCE_SUBSTRATE_ENABLED is off');
      }) as unknown as EvidenceStoreService['addGrant'],
    });
    const svc = new EvidenceGrantService(mkSurreal(db), store);
    await expect(svc.grant('co', U1, share)).rejects.toThrow(ServiceUnavailableException);
  });
});

describe('evidence grants: revoke and list', () => {
  it('revoke is idempotent — an already-revoked grant answers identically', async () => {
    const script: DbScript = {
      grant: { id: 'evidence_grant:g1', assetId: ASSET, revokedAt: '2026-01-01T00:00:00Z' },
      asset: OWNED_ASSET,
      live: [U1_GRANT],
    };
    const first = new EvidenceGrantService(mkSurreal(mkDb(script).db), mkStore());
    const again = new EvidenceGrantService(mkSurreal(mkDb(script).db), mkStore());
    const a = await first.revoke('co', U1, 'evidence_grant:g1');
    const b = await again.revoke('co', U1, 'evidence_grant:g1');
    expect(a).toEqual({ grantId: 'evidence_grant:g1', revoked: true });
    expect(b).toEqual(a);
  });

  it('list returns the live rows the owner is entitled to see', async () => {
    const { db } = mkDb({ asset: OWNED_ASSET, live: [U1_GRANT] });
    const grantedAt = new Date('2026-03-01T10:00:00.000Z');
    const store = mkStore({
      liveGrants: jest.fn(async () => [
        { grantId: 'evidence_grant:g1', ownerKind: 'user', ownerId: 'u1', grantedAt },
        {
          grantId: 'evidence_grant:g2',
          ownerKind: 'pack',
          ownerId: 'pack_alpha',
          purpose: 'processor',
          grantedAt,
        },
      ]) as unknown as EvidenceStoreService['liveGrants'],
    });
    const svc = new EvidenceGrantService(mkSurreal(db), store);
    await expect(svc.list('co', U1, ASSET)).resolves.toEqual({
      assetId: ASSET,
      grants: [
        {
          grantId: 'evidence_grant:g1',
          ownerKind: 'user',
          ownerId: 'u1',
          grantedAt: grantedAt.toISOString(),
        },
        {
          grantId: 'evidence_grant:g2',
          ownerKind: 'pack',
          ownerId: 'pack_alpha',
          purpose: 'processor',
          grantedAt: grantedAt.toISOString(),
        },
      ],
    });
  });

  it('list never reaches the store for a non-owner (no handle leaves the tenant)', async () => {
    const { db } = mkDb({ asset: OWNED_ASSET, live: [U1_GRANT] });
    const store = mkStore();
    const svc = new EvidenceGrantService(mkSurreal(db), store);
    await expect(svc.list('co', U2, ASSET)).rejects.toThrow(NotFoundException);
    expect(store.liveGrants).not.toHaveBeenCalled();
  });
});

describe('evidence grants: the controller wiring', () => {
  const req = {
    brainAuth: { companyId: 'co', scopes: ['brain:write'], keyHash: 'sha256:k', userId: 'u1' },
  } as never;

  it('passes tenant + caller from the AUTHENTICATED key, never from the body', async () => {
    const svc = {
      grant: jest.fn(async () => ({
        grantId: 'evidence_grant:g',
        created: true,
        assetId: ASSET,
        retainUntil: null,
      })),
      list: jest.fn(async () => ({ assetId: ASSET, grants: [] })),
      revoke: jest.fn(async () => ({ grantId: 'evidence_grant:g', revoked: true as const })),
    } as unknown as EvidenceGrantService;
    const ctrl = new EvidenceGrantsController(svc);
    await ctrl.grant(req, ASSET, { ownerKind: 'user', ownerId: 'u9', purpose: undefined });
    expect(svc.grant).toHaveBeenCalledWith(
      'co',
      { scopes: ['brain:write'], userId: 'u1' },
      { assetId: ASSET, ownerKind: 'user', ownerId: 'u9', purpose: undefined },
    );
    await ctrl.list(req, ASSET);
    await ctrl.revoke(req, 'evidence_grant:g');
    expect(svc.list).toHaveBeenCalledWith('co', { scopes: ['brain:write'], userId: 'u1' }, ASSET);
    expect(svc.revoke).toHaveBeenCalledWith(
      'co',
      { scopes: ['brain:write'], userId: 'u1' },
      'evidence_grant:g',
    );
  });
});
