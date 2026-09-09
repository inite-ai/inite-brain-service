import { scopedTokenDurationDecision, surrealDurationToMs } from '../src/db/surreal.service';

/**
 * SURREALDB_SCOPED_TOKEN_DURATION is spliced into DDL (durations cannot be
 * bound), so its validation is the only thing between an operator typo and
 * a broken `DEFINE USER` at boot — and a value at or under the session
 * re-auth margin silently turns every scoped read into a signin (the 48×
 * KDF tax the expiry e2e deliberately pays). Both rules were implemented in
 * #521 and never pinned; this pins them on the pure decision.
 */
describe('surrealDurationToMs', () => {
  it('parses the SurrealDB duration literals and rounds sub-millisecond units down', () => {
    expect(surrealDurationToMs('5s')).toBe(5_000);
    expect(surrealDurationToMs('1h')).toBe(3_600_000);
    expect(surrealDurationToMs('30m')).toBe(1_800_000);
    expect(surrealDurationToMs('2d')).toBe(172_800_000);
    expect(surrealDurationToMs('250ms')).toBe(250);
    expect(surrealDurationToMs('999us')).toBe(0);
  });

  it('refuses anything that is not a bare <int><unit> literal', () => {
    for (const bad of ['', '5', 's', '5 s', '1.5h', '-5s', '5S', '1h30m', '5sec']) {
      expect(surrealDurationToMs(bad)).toBeUndefined();
    }
  });
});

describe('scopedTokenDurationDecision', () => {
  const MARGIN = 5 * 60_000;

  it('unset or blank leaves the server default in place and says nothing', () => {
    expect(scopedTokenDurationDecision(undefined, MARGIN)).toEqual({ clause: '' });
    expect(scopedTokenDurationDecision('   ', MARGIN)).toEqual({ clause: '' });
  });

  it('a valid duration above the margin becomes the DDL clause, silently', () => {
    expect(scopedTokenDurationDecision('2h', MARGIN)).toEqual({ clause: ' DURATION FOR TOKEN 2h' });
    expect(scopedTokenDurationDecision(' 30m ', MARGIN)).toEqual({
      clause: ' DURATION FOR TOKEN 30m',
    });
  });

  it('an unparseable literal is IGNORED (server default stays) and reported — never spliced', () => {
    const d = scopedTokenDurationDecision('1h30m', MARGIN);
    expect(d.clause).toBe('');
    expect(d.problem).toMatch(/Ignoring SURREALDB_SCOPED_TOKEN_DURATION='1h30m'/);
  });

  it('a duration at or under the re-auth margin is honoured but flagged as test-only', () => {
    for (const raw of ['5s', '5m']) {
      const d = scopedTokenDurationDecision(raw, MARGIN);
      expect(d.clause).toBe(` DURATION FOR TOKEN ${raw}`);
      expect(d.problem).toMatch(/within the 300000ms session re-auth margin/);
      expect(d.problem).toMatch(/Intended for tests only/);
    }
  });

  it('the margin is the boundary: one unit above it is silent', () => {
    expect(scopedTokenDurationDecision('301s', MARGIN).problem).toBeUndefined();
    expect(scopedTokenDurationDecision('300s', MARGIN).problem).toBeDefined();
  });
});
