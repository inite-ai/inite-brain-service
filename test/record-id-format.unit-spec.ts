/**
 * The public string form of a record id (src/db/record-id-format.ts): the
 * ids brain has always written, whatever the driver's own query-text
 * escaping does.
 */
import { RecordId } from 'surrealdb';
import { isBareIdent } from '../src/db/record-id-format';

describe('record id string form', () => {
  it('keeps an id that starts with a digit bare — as stored, as served', () => {
    const id = new RecordId('knowledge_fact', '4m8govhpnwhq2feid6fe');
    expect(String(id)).toBe('knowledge_fact:4m8govhpnwhq2feid6fe');
    expect(JSON.stringify({ factId: id })).toBe('{"factId":"knowledge_fact:4m8govhpnwhq2feid6fe"}');
  });

  it('keeps a keyword-looking id bare too', () => {
    expect(String(new RecordId('setting', 'value'))).toBe('setting:value');
  });

  it('still delimits what the 2.0.8 driver delimited', () => {
    expect(String(new RecordId('t', '12345'))).toBe('t:⟨12345⟩');
    expect(String(new RecordId('t', 'a-b'))).toMatch(/^t:[⟨`]a-b[⟩`]$/);
    expect(String(new RecordId('t', 42))).toBe('t:42');
  });

  it('isBareIdent is the 2.0.8 rule', () => {
    expect(isBareIdent('4abc')).toBe(true);
    expect(isBareIdent('abc_1')).toBe(true);
    expect(isBareIdent('123')).toBe(false);
    expect(isBareIdent('')).toBe(false);
    expect(isBareIdent('a:b')).toBe(false);
  });
});
