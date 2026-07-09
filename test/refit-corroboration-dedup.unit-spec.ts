import {
  buildTrustEvents,
  aggregateByScope,
  type TrustEventRow,
} from '../src/ai/calibration/calibration-refit-runner.service';

/**
 * Source-reputation anti-abuse: corroboration wins must be deduped per
 * (source, domain, origin, incumbent) so a source can't farm reputation by
 * echo-ingesting the same standing fact repeatedly.
 */
describe('buildTrustEvents — corroboration win dedup', () => {
  const base: Omit<TrustEventRow, 'status'> = {
    vertical: 'rent',
    recorder: 'echobot',
    predicate: 'price',
    recordedAt: '2026-07-08T00:00:00Z',
    originKey: null,
    corroborates: 'knowledge_fact:incumbent1',
  };

  it('collapses repeated corroboration of one incumbent from one origin to a single win', () => {
    // Same source echoes the same incumbent five times (originKey stripped on
    // the fact-path → all fall back to the source key → one origin).
    const rows: TrustEventRow[] = Array.from({ length: 5 }, () => ({
      ...base,
      status: 'corroborating',
    }));
    const events = buildTrustEvents(rows);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sourceKey: 'rent:echobot', win: 1 });
  });

  it('counts genuinely independent origins corroborating one incumbent separately', () => {
    const rows: TrustEventRow[] = [
      { ...base, status: 'corroborating', originKey: 'doc:aaa' },
      { ...base, status: 'corroborating', originKey: 'doc:bbb' },
      { ...base, status: 'corroborating', originKey: 'doc:ccc' },
    ];
    expect(buildTrustEvents(rows)).toHaveLength(3);
  });

  it('counts corroboration of DIFFERENT incumbents separately', () => {
    const rows: TrustEventRow[] = [
      { ...base, status: 'corroborating', corroborates: 'knowledge_fact:a' },
      { ...base, status: 'corroborating', corroborates: 'knowledge_fact:b' },
    ];
    expect(buildTrustEvents(rows)).toHaveLength(2);
  });

  it('does not dedup active/superseded rows (only corroboration)', () => {
    const rows: TrustEventRow[] = [
      { ...base, status: 'active', corroborates: null },
      { ...base, status: 'active', corroborates: null },
      { ...base, status: 'superseded', corroborates: null },
    ];
    const events = buildTrustEvents(rows);
    expect(events).toHaveLength(3);
    expect(events.filter((e) => e.win === 1)).toHaveLength(2);
    expect(events.filter((e) => e.loss === 1)).toHaveLength(1);
  });

  it('echo-farming one incumbent cannot drive agreementRate via win inflation', () => {
    // 10 echoes of one incumbent (one origin) + one genuine loss.
    const rows: TrustEventRow[] = [
      ...Array.from({ length: 10 }, () => ({
        ...base,
        status: 'corroborating',
      })),
      { ...base, status: 'superseded', corroborates: null },
    ];
    const scopes = aggregateByScope(
      buildTrustEvents(rows).map((e) => ({
        sourceKey: e.sourceKey,
        domain: e.domain,
        win: e.win,
        loss: e.loss,
        recordedAt: e.recordedAt,
      })),
    );
    const domainScope = scopes.find(
      (s) => s.sourceKey === 'rent:echobot' && s.domain === 'price',
    )!;
    // Deduped: 1 win (not 10) + 1 loss → rate 0.5, not ~0.91.
    expect(domainScope.wins).toBe(1);
    expect(domainScope.losses).toBe(1);
  });
});
