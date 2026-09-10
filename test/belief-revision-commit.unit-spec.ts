/**
 * The belief revision compare-and-set, error classification (audit
 * 2026-09-09).
 *
 * `commitRevision` returning false means ONE thing to its caller: another
 * writer won this revision, nothing was written, decide again. Every
 * failure used to be reported that way — a schema rejection or a lost
 * connection was warned as contention and counted as `skippedContended`,
 * so a write path that could never work read as harmless contention
 * forever. Only a read conflict, a unique violation and the
 * transaction's own two aborts are contention now; anything else is
 * rethrown.
 */
import type { Logger } from '@nestjs/common';
import { commitRevision } from '../src/admin/belief-revision';
import type { BeliefDb, FoldedBelief } from '../src/admin/belief-promotion.service';

const belief = (): FoldedBelief => ({
  userId: 'u1',
  subject: 'alice',
  field: 'city',
  value: 'Porto',
  priorValue: 'Lisbon',
  displacedValue: 'Lisbon',
  displacedAt: new Date('2026-01-01T00:00:00.000Z'),
  validFrom: new Date('2026-02-01T00:00:00.000Z'),
  evidenceAt: new Date('2026-02-01T00:00:00.000Z'),
  runEvidenceAt: [new Date('2026-02-01T00:00:00.000Z')],
  sceneIds: [],
  allSceneIds: [],
  conversationIds: [],
  confidence: 0.8,
  worlds: [],
});

const logger = { warn: jest.fn(), debug: jest.fn(), log: jest.fn() } as unknown as Logger;

/** A db whose transaction fails exactly the way the driver reports it. */
const failing = (make: () => Error): BeliefDb => ({
  query: <T>(): Promise<T> => Promise.reject(make()),
});

const commit = (db: BeliefDb): Promise<boolean> =>
  commitRevision({
    db,
    belief: belief(),
    revision: 2,
    promoterVersion: 'belief-promotion-v1',
    statement: { text: 'alice — city: Porto (was: Lisbon)', source: 'template' },
    displaced: {
      id: 'semantic_belief:head',
      revision: 1,
      until: new Date('2026-02-01T00:00:00.000Z'),
      watermark: new Date('2026-01-01T00:00:00.000Z'),
    },
    logger,
  });

/** The wrapper shape runTransaction enriches, with a per-statement cause. */
const wrapped = (cause: string): Error => {
  const err = new Error('The query was not executed due to a failed transaction');
  (err as Error & { cause?: unknown }).cause = new Error(cause);
  return err;
};

beforeEach(() => jest.clearAllMocks());

describe('commitRevision reports contention, and only contention, as false', () => {
  it('a datastore read conflict is contention', async () => {
    await expect(
      commit(
        failing(
          () =>
            new Error(
              'Failed to commit transaction due to a read or write conflict. ' +
                'This transaction can be retried',
            ),
        ),
      ),
    ).resolves.toBe(false);
  });

  it('a unique violation is contention', async () => {
    await expect(
      commit(failing(() => new Error('Database record `semantic_belief:x` already exists'))),
    ).resolves.toBe(false);
  });

  it("the transaction's own aborts are contention", async () => {
    await expect(
      commit(failing(() => wrapped('An error occurred: belief head moved'))),
    ).resolves.toBe(false);
    await expect(
      commit(
        failing(() =>
          wrapped('An error occurred: belief revision slot already holds another value'),
        ),
      ),
    ).resolves.toBe(false);
  });

  it('a schema rejection is rethrown, not warned as contention', async () => {
    await expect(
      commit(
        failing(() =>
          wrapped(
            "Found 'later' for field `latestEvidenceAt`, with record " +
              '`semantic_belief:x`, but expected a datetime',
          ),
        ),
      ),
    ).rejects.toThrow('expected a datetime');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a lost connection is rethrown, not warned as contention', async () => {
    await expect(
      commit(failing(() => new Error('There was a problem with the datastore: connection closed'))),
    ).rejects.toThrow('connection closed');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('the supersede predicate carries the watermark the caller read', () => {
  it('binds $wm and guards latestEvidenceAt in the same UPDATE', async () => {
    const seen: Array<{ sql: string; vars: Record<string, unknown> | undefined }> = [];
    const db: BeliefDb = {
      query: <T>(sql: string, vars?: Record<string, unknown>): Promise<T> => {
        seen.push({ sql, vars });
        return Promise.resolve([null, null, null, null, null, true, null] as unknown as T);
      },
    };
    await expect(commit(db)).resolves.toBe(true);
    const tx = seen[0]!;
    expect(tx.sql).toContain(
      "WHERE status = 'active' AND revision = $headRevision " +
        'AND (latestEvidenceAt IS NONE OR latestEvidenceAt = $wm)',
    );
    expect(tx.vars?.wm).toEqual(new Date('2026-01-01T00:00:00.000Z'));
  });
});
