/**
 * operator_action persist — SurrealDB 3.x datetime binding.
 *
 * `ts` is a `datetime` field (migration 0027). 3.x refuses to coerce a
 * bound ISO STRING into datetime, so every audited admin call logged a
 * persist WARN (caught live by the W3 leg boot). The write must bind a
 * JS Date — the SDK serializes it as a Surreal datetime.
 */
import { OperatorActionService } from '../src/admin/operator-action.service';

function surrealMock(capture: Record<string, any>[]) {
  return {
    withCompany: async (_c: string, fn: (db: any) => Promise<any>) =>
      fn({
        query: async (_sql: string, binds?: Record<string, any>) => {
          if (binds) capture.push(binds);
          return [[]];
        },
      }),
  } as any;
}

describe('OperatorActionService.persist (3.x datetime coercion)', () => {
  it('binds ts as a Date, not an ISO string', async () => {
    const capture: Record<string, any>[] = [];
    const svc = new OperatorActionService(surrealMock(capture));
    await (svc as any).persist({
      ts: '2026-08-07T12:00:00.000Z',
      actor: 'evalops',
      scopes: ['brain:admin'],
      method: 'POST',
      path: '/v1/admin/maintenance/derive',
      status: 201,
      durationMs: 42,
      query: null,
      bodySummary: null,
      companyId: 'evalops',
    });
    expect(capture).toHaveLength(1);
    const content = capture[0].content as Record<string, unknown>;
    expect(content.ts).toBeInstanceOf(Date);
    expect((content.ts as Date).toISOString()).toBe('2026-08-07T12:00:00.000Z');
    // Null option fields stay omitted (the 0027 NULL-vs-none contract).
    expect('query' in content).toBe(false);
    expect('bodySummary' in content).toBe(false);
  });
});
