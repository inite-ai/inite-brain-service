/** 3.x does not coerce string↔record: only a `table:key` string can be
 *  bound as a record id, so anything else is untrackable. */
export function isRecordId(v: unknown): v is string {
  return typeof v === 'string' && v.includes(':') && v.length > 2;
}

export function toMs(v: Date | string): number {
  return v instanceof Date ? v.getTime() : Date.parse(String(v));
}
