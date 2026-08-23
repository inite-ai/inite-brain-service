/**
 * Rolling user profile v1 (USER_PROFILE_API_ENABLED) — deterministic
 * query-time assembly over a stubbed DB:
 *
 *  - SQL contract: user-scope idiom, combined derived-world fence,
 *    lifecycle "actual now" closure (the filtering itself is the DB's
 *    job — the gate here is that the clauses are present, the
 *    digest-lane precedent);
 *  - grouping by predicate/aspect + per-aspect and global caps;
 *  - persona_attr-first section ordering;
 *  - PII gating both ways via the predicate scope-fence;
 *  - controller auth: user-token mismatch 403, M2M passthrough,
 *    flag-off 404;
 *  - determinism: same rows in any arrival order → identical output.
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UserProfileService } from '../src/users/user-profile.service';
import { UserProfileController } from '../src/users/user-profile.controller';
import type { UserProfileWire } from '../src/users/dto/user-profile.dto';
import type { SurrealService } from '../src/db/surreal.service';
import type { ReadPinService } from '../src/episodes/read-pin.service';
import type { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import type { AuthenticatedRequest } from '../src/auth/api-key.types';
import { runWithRequestContext } from '../src/common/request-context';

type Row = Record<string, unknown>;
type Capture = { sql: string; params?: Record<string, unknown> | undefined };

function makeService(opts: {
  rows: Row[];
  capture?: Capture[];
  readPin?: string | null;
  piiPredicates?: string[];
}): UserProfileService {
  const surreal = {
    withScopedCompany: async (
      _c: string,
      _scopes: readonly string[],
      fn: (db: unknown) => Promise<unknown>,
    ) =>
      fn({
        query: async (sql: string, params?: Record<string, unknown>) => {
          opts.capture?.push({ sql, params });
          return [opts.rows];
        },
      }),
  } as unknown as SurrealService;
  const readPin =
    opts.readPin !== undefined
      ? ({
          resolveRead: async () => opts.readPin,
        } as unknown as ReadPinService)
      : undefined;
  const registry = {
    rowPolicyLookup: async () => (predicate: string) => ({
      piiClass: opts.piiPredicates?.includes(predicate) ? 'sensitive' : 'none',
      ...(opts.piiPredicates?.includes(predicate)
        ? { requiresScope: 'brain:read_pii' }
        : {}),
    }),
  } as unknown as PredicateRegistryService;
  return new UserProfileService(surreal, readPin, registry);
}

let seq = 0;
function row(overrides: Row): Row {
  seq += 1;
  return {
    id: `knowledge_fact:f${String(seq).padStart(3, '0')}`,
    predicate: 'work',
    object: `fact ${seq}`,
    confidence: 0.9,
    validFrom: new Date('2026-06-01T00:00:00Z'),
    source: {},
    userId: 'u1',
    ...overrides,
  };
}

const baseOpts = {
  companyId: 'c1',
  userId: 'u1',
  callerScopes: ['brain:read'] as const,
  maxFacts: 60,
};

describe('UserProfileService — SQL contract', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('applies user scope, combined derived fence, and the lifecycle closure', async () => {
    const capture: Capture[] = [];
    const svc = makeService({ rows: [], capture, readPin: 'wd-v1' });
    await svc.getProfile({ ...baseOpts });
    const { sql, params } = capture[0]!;
    // Audit 2026-08-21: STRICT user scope — tenant-global rows are
    // knowledge about arbitrary entities, not facts OF this user, and
    // must never leak into a profile. The user's own derived facts
    // carry userId by construction (derive-row-builder scope rule).
    expect(sql).toContain('userId = $scopeUserId');
    expect(sql).not.toContain('userId IS NONE');
    expect(params?.scopeUserId).toBe('u1');
    // Combined world fence: legacy namespace UNION the pinned world.
    expect(sql).toContain(
      '(derivedVersion IS NONE OR derivedVersion = $derivedVersion)',
    );
    expect(params?.derivedVersion).toBe('wd-v1');
    // Lifecycle: the where-builder "actual now" closure + no competing.
    expect(sql).toContain('retractedAt IS NONE');
    expect(sql).toContain(`status != 'competing'`);
    expect(sql).toContain(`status != 'compacted'`);
    expect(sql).toContain(`status != 'corroborating'`);
    expect(sql).toContain(
      `(status != 'superseded' OR validUntil > time::now())`,
    );
    expect(sql).toContain('validFrom <= time::now()');
    expect(sql).toContain('(validUntil IS NONE OR validUntil > time::now())');
    // Deterministic fetch order.
    expect(sql).toContain('ORDER BY validFrom DESC, id ASC');
  });

  it('no pin → the legacy namespace collapses to a tautology, not a leak', async () => {
    const capture: Capture[] = [];
    const svc = makeService({ rows: [], capture, readPin: null });
    await svc.getProfile({ ...baseOpts });
    expect(capture[0]!.sql).toContain(
      '(derivedVersion IS NONE OR derivedVersion IS NONE)',
    );
  });

  it('lang filter is soft on unstamped rows and only added when asked', async () => {
    const capture: Capture[] = [];
    const svc = makeService({ rows: [], capture, readPin: null });
    await svc.getProfile({ ...baseOpts, lang: 'en' });
    expect(capture[0]!.sql).toContain('(lang = $langFilter OR lang IS NONE)');
    expect(capture[0]!.params?.langFilter).toBe('en');
    const capture2: Capture[] = [];
    const svc2 = makeService({ rows: [], capture: capture2, readPin: null });
    await svc2.getProfile({ ...baseOpts });
    expect(capture2[0]!.sql).not.toContain('langFilter');
  });
});

describe('UserProfileService — assembly', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('groups by predicate/aspect and orders facts validFrom DESC', async () => {
    const svc = makeService({
      rows: [
        row({
          predicate: 'work',
          object: 'older',
          validFrom: new Date('2026-01-01T00:00:00Z'),
        }),
        row({
          predicate: 'work',
          object: 'newer',
          validFrom: new Date('2026-05-01T00:00:00Z'),
        }),
        row({ predicate: 'travel', object: 'trip' }),
      ],
      readPin: null,
    });
    const res = await svc.getProfile({ ...baseOpts });
    expect(res.factCount).toBe(3);
    const work = res.sections.find((s) => s.aspect === 'work');
    expect(work?.facts.map((f) => f.statement)).toEqual(['newer', 'older']);
    expect(res.sections.map((s) => s.aspect)).toEqual(['work', 'travel']);
  });

  it('caps each aspect at 5 and the whole profile at maxFacts', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 7; i++) {
      rows.push(
        row({
          predicate: 'work',
          validFrom: new Date(`2026-03-0${i + 1}T00:00:00Z`),
        }),
      );
    }
    for (let i = 0; i < 3; i++) rows.push(row({ predicate: 'travel' }));
    const svc = makeService({ rows, readPin: null });
    const capped = await svc.getProfile({ ...baseOpts });
    expect(
      capped.sections.find((s) => s.aspect === 'work')?.facts,
    ).toHaveLength(5);
    // Newest 5 of the 7 survive the per-aspect cap.
    expect(
      capped.sections
        .find((s) => s.aspect === 'work')
        ?.facts.map((f) => f.validFrom.slice(0, 10)),
    ).toEqual([
      '2026-03-07',
      '2026-03-06',
      '2026-03-05',
      '2026-03-04',
      '2026-03-03',
    ]);
    const svc2 = makeService({ rows, readPin: null });
    const tight = await svc2.getProfile({ ...baseOpts, maxFacts: 6 });
    expect(tight.factCount).toBe(6);
    // Global cut walks sections in order: 5 work + 1 travel.
    expect(tight.sections.map((s) => s.facts.length)).toEqual([5, 1]);
  });

  it('orders sections persona_attr-first, then by fact count, then aspect', async () => {
    const svc = makeService({
      rows: [
        row({ predicate: 'work' }),
        row({ predicate: 'work' }),
        row({ predicate: 'work' }),
        row({ predicate: 'travel' }),
        row({ predicate: 'travel' }),
        row({ predicate: 'identity', source: { kind: 'persona_attr' } }),
        row({ predicate: 'events', source: { kind: 'event' } }),
        row({ predicate: 'activities' }),
      ],
      readPin: null,
    });
    const res = await svc.getProfile({ ...baseOpts });
    expect(res.sections.map((s) => s.aspect)).toEqual([
      'identity', // persona_attr tier first
      'work', // then count DESC
      'travel',
      'activities', // count ties broken by aspect ASC
      'events',
    ]);
    expect(
      res.sections.find((s) => s.aspect === 'identity')?.facts[0]!.kind,
    ).toBe('persona_attr');
    expect(
      res.sections.find((s) => s.aspect === 'events')?.facts[0]!.kind,
    ).toBe('event');
    expect(
      res.sections.find((s) => s.aspect === 'work')?.facts[0]!.kind,
    ).toBeUndefined();
  });

  it('renders profileText one line per fact, sections persona-first', async () => {
    const svc = makeService({
      rows: [
        row({
          predicate: 'work',
          object: 'Alex works at Acme',
          validFrom: new Date('2026-02-03T12:00:00Z'),
        }),
        row({
          predicate: 'identity',
          object: 'Alex is a vegetarian',
          validFrom: new Date('2026-01-15T00:00:00Z'),
          source: { kind: 'persona_attr' },
        }),
      ],
      readPin: null,
    });
    const res = await svc.getProfile({ ...baseOpts });
    expect(res.profileText).toBe(
      '- [identity] Alex is a vegetarian (as of 2026-01-15)\n' +
        '- [work] Alex works at Acme (as of 2026-02-03)',
    );
  });

  it('surfaces lastSeenAt from corroboration.lastAt when present', async () => {
    const svc = makeService({
      rows: [
        row({
          corroboration: { count: 2, lastAt: new Date('2026-07-01T00:00:00Z') },
        }),
        row({}),
      ],
      readPin: null,
    });
    const res = await svc.getProfile({ ...baseOpts });
    const [first, second] = res.sections[0]!.facts;
    // Rows share validFrom → factId ASC keeps f001 (corroborated) first.
    expect(first!.lastSeenAt).toBe('2026-07-01T00:00:00.000Z');
    expect(second!.lastSeenAt).toBeUndefined();
  });

  it('gates PII predicates on brain:read_pii — both ways', async () => {
    const rows = [
      row({ predicate: 'health_note', object: 'secret' }),
      row({ predicate: 'work', object: 'public' }),
    ];
    const without = await makeService({
      rows,
      readPin: null,
      piiPredicates: ['health_note'],
    }).getProfile({ ...baseOpts });
    expect(without.factCount).toBe(1);
    expect(without.profileText).not.toContain('secret');
    const withPii = await makeService({
      rows,
      readPin: null,
      piiPredicates: ['health_note'],
    }).getProfile({
      ...baseOpts,
      callerScopes: ['brain:read', 'brain:read_pii'],
    });
    expect(withPii.factCount).toBe(2);
    expect(withPii.profileText).toContain('secret');
  });

  it('is deterministic: same rows in any arrival order → identical output', async () => {
    const rows = [
      row({ predicate: 'work', object: 'a' }),
      row({ predicate: 'travel', object: 'b' }),
      row({
        predicate: 'identity',
        object: 'c',
        source: { kind: 'persona_attr' },
      }),
      row({
        predicate: 'work',
        object: 'd',
        validFrom: new Date('2026-07-01T00:00:00Z'),
      }),
    ];
    const strip = (r: UserProfileWire): Omit<UserProfileWire, 'generatedAt'> => {
      const { generatedAt: _g, ...rest } = r;
      return rest;
    };
    const forward = await makeService({ rows, readPin: null }).getProfile({
      ...baseOpts,
    });
    const reversed = await makeService({
      rows: [...rows].reverse(),
      readPin: null,
    }).getProfile({ ...baseOpts });
    expect(strip(forward)).toEqual(strip(reversed));
    expect(JSON.stringify(strip(forward))).toBe(
      JSON.stringify(strip(reversed)),
    );
  });
});

describe('UserProfileController — flag gate + user-scope pin', () => {
  const FLAG = 'USER_PROFILE_API_ENABLED';
  const saved = process.env[FLAG];
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  function makeController(): {
    controller: UserProfileController;
    calls: Array<Record<string, unknown>>;
  } {
    const calls: Array<Record<string, unknown>> = [];
    const service = {
      getProfile: async (opts: Record<string, unknown>) => {
        calls.push(opts);
        return {
          userId: opts.userId,
          generatedAt: 'now',
          factCount: 0,
          sections: [],
          profileText: '',
        };
      },
    } as unknown as UserProfileService;
    return { controller: new UserProfileController(service), calls };
  }

  const req = {
    brainAuth: { companyId: 'c1', scopes: ['brain:read'] },
  } as unknown as AuthenticatedRequest;

  it('404s while the flag is off — indistinguishable from an absent route', async () => {
    delete process.env[FLAG];
    const { controller } = makeController();
    await expect(controller.getProfile(req, 'u1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('M2M credential (no authUserId) reads any user profile', async () => {
    process.env[FLAG] = '1';
    const { controller, calls } = makeController();
    await runWithRequestContext({ correlationId: 't1' }, async () => {
      await controller.getProfile(req, 'someone-else');
    });
    expect(calls[0]!.userId).toBe('someone-else');
    expect(calls[0]!.maxFacts).toBe(60);
  });

  it('user-bound token: own profile passes, another user 403s', async () => {
    process.env[FLAG] = '1';
    const { controller, calls } = makeController();
    await runWithRequestContext(
      { correlationId: 't2', authUserId: 'u1' },
      async () => {
        await controller.getProfile(req, 'u1');
        await expect(controller.getProfile(req, 'u2')).rejects.toThrow(
          ForbiddenException,
        );
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.userId).toBe('u1');
  });

  it('clamps maxFacts to the hard cap and rejects garbage', async () => {
    process.env[FLAG] = '1';
    const { controller, calls } = makeController();
    await controller.getProfile(req, 'u1', '500');
    expect(calls[0]!.maxFacts).toBe(200);
    await expect(controller.getProfile(req, 'u1', '0')).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.getProfile(req, 'u1', 'abc')).rejects.toThrow(
      BadRequestException,
    );
  });
});
