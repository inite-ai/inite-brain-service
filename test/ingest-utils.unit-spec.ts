import {
  idTailOf,
  externalRefKey,
  redactPii,
  sourceTrustFor,
  shouldWriteHypeAltEmbedding,
} from '../src/ingest/ingest-utils';
import { SOURCE_TRUST } from '../src/ingest/conflict-resolver';

describe('idTailOf', () => {
  it('strips the table prefix off a record id', () => {
    expect(idTailOf('knowledge_fact:abc123')).toBe('abc123');
  });

  it('returns the input unchanged when there is no colon', () => {
    expect(idTailOf('abc123')).toBe('abc123');
  });

  it('only splits on the first colon (id tails may contain colons)', () => {
    expect(idTailOf('knowledge_entity:a:b')).toBe('a:b');
  });
});

describe('externalRefKey', () => {
  it('joins vertical and id with a double underscore', () => {
    expect(externalRefKey('rent', 'cust42')).toBe('rent__cust42');
  });

  it('replaces dots in either component so SurrealQL CONTENT cannot nest them', () => {
    expect(externalRefKey('rent.eu', 'cust.42')).toBe('rent__eu__cust__42');
  });
});

describe('redactPii', () => {
  it('masks email addresses', () => {
    expect(redactPii('reach me at jane.doe@example.com please')).toBe(
      'reach me at [EMAIL] please',
    );
  });

  it('masks phone-like numbers', () => {
    expect(redactPii('call +1 (415) 555-2671 now')).toContain('[PHONE]');
  });

  it('masks long digit runs (the phone pattern claims them first)', () => {
    const out = redactPii('id 123456789012');
    expect(out).not.toContain('123456789012');
    expect(out).toMatch(/\[(PHONE|NUM)\]/);
  });

  it('leaves non-PII text untouched', () => {
    expect(redactPii('moved to Berlin, tier gold')).toBe(
      'moved to Berlin, tier gold',
    );
  });
});

describe('sourceTrustFor', () => {
  it('maps billing events to the billing trust label', () => {
    expect(sourceTrustFor({ vertical: 'x', eventId: 'billing.charge' })).toBe(
      SOURCE_TRUST.billing_event,
    );
  });

  it('maps incidents events', () => {
    expect(sourceTrustFor({ vertical: 'x', eventId: 'incidents.opened' })).toBe(
      SOURCE_TRUST.incidents_event,
    );
  });

  it('maps auth events', () => {
    expect(sourceTrustFor({ vertical: 'x', eventId: 'auth.login' })).toBe(
      SOURCE_TRUST.auth_event,
    );
  });

  it('maps a message id (no event) to inbox extraction', () => {
    expect(sourceTrustFor({ vertical: 'x', messageId: 'm1' })).toBe(
      SOURCE_TRUST.inbox_extraction,
    );
  });

  it('falls back to the default trust for an unrecognised shape', () => {
    expect(sourceTrustFor({ vertical: 'x' })).toBe(SOURCE_TRUST.default);
  });

  it('prefers the eventId branch over messageId', () => {
    expect(
      sourceTrustFor({ vertical: 'x', eventId: 'billing.x', messageId: 'm1' }),
    ).toBe(SOURCE_TRUST.billing_event);
  });
});

describe('shouldWriteHypeAltEmbedding', () => {
  it('is true only for an INSERTED outcome with HyPE enabled and a factId', () => {
    expect(shouldWriteHypeAltEmbedding('INSERTED', true, 'fact:1')).toBe(true);
  });

  it('is false when HyPE is disabled', () => {
    expect(shouldWriteHypeAltEmbedding('INSERTED', false, 'fact:1')).toBe(false);
  });

  it('is false when there is no factId', () => {
    expect(shouldWriteHypeAltEmbedding('INSERTED', true, null)).toBe(false);
  });

  it('is false for non-INSERTED outcomes (no embedding burned on supersede/compete/reject)', () => {
    for (const outcome of [
      'SUPERSEDED',
      'COMPETING',
      'REJECTED',
      undefined,
      null,
    ]) {
      expect(shouldWriteHypeAltEmbedding(outcome, true, 'fact:1')).toBe(false);
    }
  });
});
