import { RecordId } from 'surrealdb';
import { recordIdOf, recordKey } from '../src/db/record-key';

describe('recordKey — the key bound into type::record(table, $key)', () => {
  it('strips the table off a full id and passes a bare key through', () => {
    expect(recordKey('knowledge_fact:abc123')).toBe('abc123');
    expect(recordKey('abc123')).toBe('abc123');
  });

  it('removes the delimiters the driver renders around a non-plain key', () => {
    expect(recordKey('job_run:⟨0a1b-2c3d⟩')).toBe('0a1b-2c3d');
    expect(recordKey('leader_lease:`a-b`')).toBe('a-b');
    expect(recordKey('t:⟨a\\⟩b⟩')).toBe('a⟩b');
  });

  it('keeps a key with dashes, dots and colons intact when it is bare', () => {
    expect(recordKey('dreams_tenant_acme-corp')).toBe('dreams_tenant_acme-corp');
    expect(recordKey('source_document:doc.v2-final')).toBe('doc.v2-final');
  });

  it('reads a bare all-digit key as the integer key the parser would', () => {
    expect(recordKey('memory_outcome:42')).toBe(42);
    expect(recordKey('job_run:⟨42⟩')).toBe('42');
    // Past the safe-integer range it stays a string rather than lose digits.
    expect(recordKey('t:123456789012345678901234567890')).toBe('123456789012345678901234567890');
  });
});

describe('recordIdOf', () => {
  it('builds a RecordId from table + key without parsing a composed string', () => {
    const rid = recordIdOf('knowledge_entity', 'knowledge_entity:acme-corp');
    expect(rid).toBeInstanceOf(RecordId);
    expect(rid.table.name).toBe('knowledge_entity');
    expect(rid.id).toBe('acme-corp');
  });

  it('round-trips the plain rendered form brain hands out', () => {
    expect(String(recordIdOf('knowledge_fact', 'knowledge_fact:abc'))).toBe('knowledge_fact:abc');
    expect(String(recordIdOf('knowledge_fact', 'abc'))).toBe('knowledge_fact:abc');
  });
});
