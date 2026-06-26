import {
  isUniqueViolation,
  isReadConflict,
  enrichTransactionError,
  retryOnUniqueViolation,
} from '../src/db/surreal-retry';

const noSleep = (): Promise<void> => Promise.resolve();

describe('isUniqueViolation', () => {
  it.each([
    'Database index `idx` already contains a record with id foo',
    'Database index `x` already contains 1',
    'IndexExists: boom',
    'Database record `entity:1` already exists',
    'Found a record with the same value',
  ])('matches the unique-violation wording: %s', (msg) => {
    expect(isUniqueViolation(new Error(msg))).toBe(true);
  });

  it('does not match an unrelated error', () => {
    expect(isUniqueViolation(new Error('parse error: unexpected token'))).toBe(
      false,
    );
  });

  it('returns false for non-Error values', () => {
    expect(isUniqueViolation('already exists')).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});

describe('isReadConflict', () => {
  it.each([
    'Transaction read conflict on key',
    'two writers wrote at the same key',
    'Failed to commit transaction due to a read or write conflict',
    'This transaction can be retried',
    'Transaction conflict: Write conflict, retry the transaction',
    'Write conflict',
  ])('matches the read/write-conflict wording: %s', (msg) => {
    expect(isReadConflict(new Error(msg))).toBe(true);
  });

  it('does not match a permission denial or parse error', () => {
    expect(isReadConflict(new Error('IAM error: permission denied'))).toBe(
      false,
    );
    expect(isReadConflict(new Error('parse error near COMMIT'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isReadConflict({ message: 'Write conflict' })).toBe(false);
  });
});

describe('enrichTransactionError', () => {
  it('appends the cause message to a "failed transaction" wrapper so it becomes retriable', () => {
    const wrapper = new Error(
      'The query was not executed due to a failed transaction',
    );
    (wrapper as Error & { cause?: unknown }).cause = new Error(
      'Failed to commit transaction due to a read or write conflict',
    );
    const enriched = enrichTransactionError(wrapper) as Error;
    expect(enriched).not.toBe(wrapper);
    expect(isReadConflict(enriched)).toBe(true);
    // original wrapper alone is NOT classifiable — enrichment is what unlocks retry
    expect(isReadConflict(wrapper)).toBe(false);
    expect((enriched as Error & { cause?: unknown }).cause).toBe(wrapper);
  });

  it('falls back to the canonical suffix when no cause is attached', () => {
    const wrapper = new Error('failed transaction envelope');
    const enriched = enrichTransactionError(wrapper) as Error;
    expect(enriched.message).toContain(
      'read or write conflict; this transaction can be retried',
    );
    expect(isReadConflict(enriched)).toBe(true);
  });

  it('returns non-wrapper errors unchanged (so callers can throw it unconditionally)', () => {
    const other = new Error('parse error');
    expect(enrichTransactionError(other)).toBe(other);
    const notError = { message: 'failed transaction' };
    expect(enrichTransactionError(notError)).toBe(notError);
  });
});

describe('retryOnUniqueViolation', () => {
  it('returns immediately on success without retrying', async () => {
    let calls = 0;
    const out = await retryOnUniqueViolation(
      async () => {
        calls++;
        return 'ok';
      },
      7,
      noSleep,
    );
    expect(out).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries on a unique violation, then succeeds', async () => {
    let calls = 0;
    const out = await retryOnUniqueViolation(
      async () => {
        calls++;
        if (calls < 3) throw new Error('Database index `x` already contains 1');
        return calls;
      },
      7,
      noSleep,
    );
    expect(out).toBe(3);
    expect(calls).toBe(3);
  });

  it('retries on a read conflict, then succeeds', async () => {
    let calls = 0;
    const out = await retryOnUniqueViolation(
      async () => {
        calls++;
        if (calls < 2) throw new Error('Write conflict');
        return 'done';
      },
      7,
      noSleep,
    );
    expect(out).toBe('done');
    expect(calls).toBe(2);
  });

  it('does NOT retry a non-retriable error — rethrows immediately', async () => {
    let calls = 0;
    await expect(
      retryOnUniqueViolation(
        async () => {
          calls++;
          throw new Error('permission denied');
        },
        7,
        noSleep,
      ),
    ).rejects.toThrow('permission denied');
    expect(calls).toBe(1);
  });

  it('gives up after exhausting attempts and throws the last error', async () => {
    let calls = 0;
    await expect(
      retryOnUniqueViolation(
        async () => {
          calls++;
          throw new Error(`Write conflict #${calls}`);
        },
        3,
        noSleep,
      ),
    ).rejects.toThrow('Write conflict #3');
    expect(calls).toBe(3);
  });
});
