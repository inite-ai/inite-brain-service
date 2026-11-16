import {
  expiredUsers,
  FAMILY_RETENTION_DAYS,
  lastContactByUser,
  readRetentionDays,
  RETENTION_USERS_PER_RUN,
  UserRetentionService,
  type RetentionDb,
} from '../src/entities/user-retention.service';
import {
  RetentionResponseSchema,
  RetentionSetRequestSchema,
} from '../src/contracts/admin/retention.schema';
import type { SurrealService } from '../src/db/surreal.service';
import type { UserForgetService } from '../src/entities/user-forget.service';
import type { ApiKeyService } from '../src/auth/api-key.service';
import type { JobClaimService } from '../src/jobs/job-claim.service';

/**
 * Retention: a person's memory goes after the tenant's window without a
 * write (two years for the family products), through the user forget, in
 * the job system, and only for a tenant that turned it on.
 */
const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-11-15T00:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

/** A tenant db answering the policy read and the three last-contact legs. */
function tenantDb(opts: {
  days: number | null;
  episode?: Array<[string, string]>;
  fact?: Array<[string, string]>;
  doc?: Array<[string, string]>;
}): RetentionDb {
  const rows = (pairs: Array<[string, string]> = []) =>
    pairs.map(([userId, last]) => ({ userId, last }));
  return {
    query: async <T>(sql: string): Promise<T> => {
      if (sql.includes('retention_policy')) {
        return [opts.days === null ? [] : [{ userInactiveDays: opts.days }]] as unknown as T;
      }
      if (sql.includes('FROM episode')) return [rows(opts.episode)] as unknown as T;
      if (sql.includes('FROM knowledge_fact')) return [rows(opts.fact)] as unknown as T;
      if (sql.includes('FROM source_document')) return [rows(opts.doc)] as unknown as T;
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

function service(db: RetentionDb) {
  const forgotten: string[] = [];
  const enqueued: Array<Record<string, unknown>> = [];
  const surreal = {
    withCompany: async <T>(_co: string, fn: (d: RetentionDb) => Promise<T>) => fn(db),
  } as unknown as SurrealService;
  const forget = {
    forgetUser: jest.fn(async (_co: string, userId: string) => {
      forgotten.push(userId);
      return {};
    }),
  } as unknown as UserForgetService;
  const apiKeys = { fanOutRoster: () => ['co_a', 'co_b'] } as unknown as ApiKeyService;
  const claim = {
    enqueue: jest.fn(async (row: Record<string, unknown>) => {
      enqueued.push(row);
      return { created: true };
    }),
  } as unknown as JobClaimService;
  const svc = new UserRetentionService(surreal, forget, apiKeys, undefined, claim);
  return { svc, forgotten, enqueued };
}

describe('user retention', () => {
  beforeAll(() => jest.useFakeTimers({ now: NOW, doNotFake: ['setImmediate', 'nextTick'] }));
  afterAll(() => jest.useRealTimers());

  it('is off unless the tenant set it', async () => {
    expect(await readRetentionDays(tenantDb({ days: null }))).toBeNull();
    const { svc, forgotten } = service(tenantDb({ days: null, episode: [['u_old', ago(5000)]] }));
    expect(await svc.runTenant('co_a')).toMatchObject({ days: null, forgotten: 0 });
    expect(forgotten).toEqual([]);
  });

  it('last contact is the latest write across turns, facts and documents', async () => {
    const last = await lastContactByUser(
      tenantDb({
        days: 730,
        episode: [['u1', ago(800)]],
        fact: [
          ['u1', ago(10)],
          ['u2', ago(900)],
        ],
        doc: [['u2', ago(1000)]],
      }),
    );
    expect(last.get('u1')?.toISOString()).toBe(ago(10));
    expect(last.get('u2')?.toISOString()).toBe(ago(900));
  });

  it('forgets only people silent for longer than the window, oldest first', () => {
    const last = new Map([
      ['recent', new Date(ago(100))],
      ['old', new Date(ago(731))],
      ['older', new Date(ago(2000))],
      ['edge', new Date(ago(729))],
    ]);
    expect(expiredUsers(last, FAMILY_RETENTION_DAYS, NOW)).toEqual(['older', 'old']);
  });

  it('erases through the user forget, a batch per run, and resumes the rest', async () => {
    const many = Array.from(
      { length: RETENTION_USERS_PER_RUN + 3 },
      (_, i) => [`u${i}`, ago(800 + i)] as [string, string],
    );
    const { svc, forgotten, enqueued } = service(
      tenantDb({ days: 730, fact: [...many, ['active', ago(3)]] }),
    );
    const run = await svc.runTenant('co_a');
    expect(run).toMatchObject({
      days: 730,
      expired: many.length,
      forgotten: RETENTION_USERS_PER_RUN,
      failed: 0,
      remaining: 3,
    });
    expect(forgotten).not.toContain('active');
    expect(enqueued).toEqual([
      expect.objectContaining({ jobType: 'user_retention', companyId: 'co_a' }),
    ]);
  });

  it('the daily cron enqueues one job per tenant, deduplicated per day', async () => {
    const { svc, enqueued } = service(tenantDb({ days: null }));
    await svc.enqueueAll();
    expect(enqueued.map((e) => e.companyId)).toEqual(['co_a', 'co_b']);
    expect(new Set(enqueued.map((e) => e.dedupKey))).toEqual(
      new Set(['user_retention_2026-11-15']),
    );
  });

  it('the admin contract takes 30..3650 days or null', () => {
    expect(RetentionSetRequestSchema.safeParse({ userInactiveDays: 730 }).success).toBe(true);
    expect(RetentionSetRequestSchema.safeParse({ userInactiveDays: null }).success).toBe(true);
    expect(RetentionSetRequestSchema.safeParse({ userInactiveDays: 7 }).success).toBe(false);
    expect(RetentionSetRequestSchema.safeParse({ userInactiveDays: 730, x: 1 }).success).toBe(
      false,
    );
    expect(
      RetentionResponseSchema.parse({
        companyId: 'co_a',
        userInactiveDays: null,
        familyDefaultDays: FAMILY_RETENTION_DAYS,
      }).familyDefaultDays,
    ).toBe(730);
  });
});
