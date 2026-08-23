import { changefeedRow, changefeedRecordId } from '../src/db/changefeed-row';

/**
 * The `SHOW CHANGES` item shape under `CHANGEFEED … INCLUDE ORIGINAL`, pinned
 * from what SurrealDB 3.2.1 actually emits.
 *
 * This exists because the shape is a trap. On a CREATE the row sits under
 * `update`; on an UPDATE `update` is a PATCH ARRAY and the row moves to
 * `current`. A consumer that reads `item.update.id` therefore sees creates
 * only and silently misses every update — while still draining, advancing its
 * cursor, and reporting success. Two drains in this codebase were written that
 * way before a live check caught it.
 */
describe('changefeedRow', () => {
  const created = {
    update: {
      id: 'knowledge_fact:p1',
      object: 'a renowned outdoor gear company',
      status: 'active',
    },
  };

  // Verbatim from SurrealDB 3.2.1: the post-image under `current`, and a
  // REVERSED patch list under `update` (how to get back to the original).
  const updated = {
    current: {
      id: 'knowledge_fact:p1',
      object: 'a renowned outdoor gear company',
      status: 'superseded',
      supersededBy: 'knowledge_fact:p1v2',
    },
    update: [
      { op: 'remove', path: '/supersededBy' },
      { op: 'change', path: '/status', value: '@@ -1,10 +1,6 @@\n-superseded\n+active\n' },
    ],
  };

  it('reads the row out of a CREATE', () => {
    expect(changefeedRow(created)).toMatchObject({
      id: 'knowledge_fact:p1',
      status: 'active',
    });
  });

  it('reads the POST-IMAGE out of an UPDATE, not the patch array', () => {
    expect(changefeedRow(updated)).toMatchObject({
      id: 'knowledge_fact:p1',
      status: 'superseded',
    });
  });

  it('never returns the patch array as if it were a row', () => {
    const row = changefeedRow(updated);
    expect(Array.isArray(row)).toBe(false);
    expect(row!.id).toBe('knowledge_fact:p1');
  });

  it('returns null for a delete and for malformed items', () => {
    expect(changefeedRow({ delete: 'knowledge_fact:p1' })).toBeNull();
    expect(changefeedRow({ define_table: { name: 'knowledge_fact' } })).toBeNull();
    expect(changefeedRow(null)).toBeNull();
    expect(changefeedRow('nonsense')).toBeNull();
  });

  describe('changefeedRecordId', () => {
    it('reads the id from creates, updates and deletes alike', () => {
      expect(changefeedRecordId(created)).toBe('knowledge_fact:p1');
      expect(changefeedRecordId(updated)).toBe('knowledge_fact:p1');
      expect(changefeedRecordId({ delete: 'knowledge_fact:gone' })).toBe('knowledge_fact:gone');
    });

    it('returns null when there is no id to read', () => {
      expect(changefeedRecordId({ define_table: {} })).toBeNull();
      expect(changefeedRecordId(undefined)).toBeNull();
    });
  });
});
