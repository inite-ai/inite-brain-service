/**
 * Trust circles, step 1 (docs/roadmap/trust-circles-2026-10.md §3.2–§3.5):
 * a credential bound to a circle writes into it and reads only it. Pure —
 * the request context and the job ALS are the only state.
 */
import {
  actingCircleTags,
  circleTag,
  circleTagsOf,
  runInCircle,
  runOutsideCircle,
  withSourceCircles,
} from '../src/auth/circle-scope';
import { heldTagsFor, rememberScopeTags } from '../src/auth/scope-principal';
import { parseTag, scopeForUser } from '../src/auth/scope-tags';
import {
  TENANT_WIDE,
  scopeFenceActive,
  scopeFenceSql,
  visibleUnderScope,
} from '../src/auth/scope-visibility';
import { runWithRequestContext } from '../src/common/request-context';

const inCircle = <T>(circle: string | undefined, fn: () => T): T =>
  runWithRequestContext({ correlationId: 'c1', ...(circle ? { actingCircle: circle } : {}) }, fn);

describe('trust circles — the acting circle', () => {
  afterEach(() => {
    delete process.env.SCOPE_TAGS_ENABLED;
  });

  it('comes from the credential, or from a job re-entering a stored scope', () => {
    expect(inCircle(undefined, () => actingCircleTags())).toEqual([]);
    expect(inCircle('coach', () => actingCircleTags())).toEqual(['circle:coach']);
    const stored = ['user:ana', 'circle:coach'];
    expect(runInCircle(circleTagsOf(stored), () => actingCircleTags())).toEqual(['circle:coach']);
    // a job's circle wins over whatever request happens to be around it
    expect(
      inCircle('assistant', () => runInCircle(['circle:coach'], () => actingCircleTags())),
    ).toEqual(['circle:coach']);
  });

  it('is a known namespace — a circle tag never hides its row as malformed', () => {
    expect(parseTag(circleTag('coach'))).toEqual({ namespace: 'circle', id: 'coach' });
  });
});

describe('trust circles — writes', () => {
  it('a write in a circle carries its tag next to the user (narrower, never wider)', () => {
    expect(inCircle(undefined, () => scopeForUser('ana'))).toEqual(['user:ana']);
    expect(inCircle('coach', () => scopeForUser('ana'))).toEqual(['user:ana', 'circle:coach']);
    expect(inCircle('coach', () => scopeForUser(undefined))).toEqual(['circle:coach']);
  });

  it('a share copy is written out of the circle — the only way a write leaves it', () => {
    expect(inCircle('coach', () => runOutsideCircle(() => scopeForUser('ana')))).toEqual([
      'user:ana',
    ]);
    expect(runInCircle(['circle:coach'], () => runOutsideCircle(() => actingCircleTags()))).toEqual(
      [],
    );
  });

  it('a derived row inherits every circle of its sources', () => {
    expect(
      withSourceCircles(
        ['user:ana'],
        [{ scope: ['user:ana', 'circle:coach'] }, { scope: ['user:ana'] }],
      ),
    ).toEqual(['user:ana', 'circle:coach']);
    expect(withSourceCircles(['user:ana'], [{ scope: null }, {}])).toEqual(['user:ana']);
  });
});

describe('trust circles — reads', () => {
  afterEach(() => {
    delete process.env.SCOPE_TAGS_ENABLED;
  });

  it('a principal acting in a circle holds that circle and none of its others', () => {
    inCircle('assistant', () => {
      rememberScopeTags('ana', ['user:ana', 'circle:coach', 'circle:assistant']);
      expect(heldTagsFor('ana')).toEqual(['user:ana', 'circle:assistant']);
    });
    // the person, acting in no circle, holds all of their own
    inCircle(undefined, () => {
      rememberScopeTags('ana', ['user:ana', 'circle:coach', 'circle:assistant']);
      expect(heldTagsFor('ana')).toEqual(['user:ana', 'circle:coach', 'circle:assistant']);
    });
  });

  it("the fence hides another circle's row from an agent asking about the same person", () => {
    const fence = inCircle('assistant', () => scopeFenceSql('ana'));
    expect(fence.clause).toBe('AND (scope = [] OR scope ALLINSIDE $principalScopeTag)');
    expect(fence.params.principalScopeTag).toEqual(['user:ana', 'circle:assistant']);
    // what the clause means, row by row
    const held = fence.params.principalScopeTag as string[];
    const sees = (scope: string[]) => scope.length === 0 || scope.every((t) => held.includes(t));
    expect(sees(['user:ana'])).toBe(true); // her memory from before circles
    expect(sees(['user:ana', 'circle:assistant'])).toBe(true);
    expect(sees(['user:ana', 'circle:coach'])).toBe(false);
  });

  it('applies with SCOPE_TAGS_ENABLED off: privacy does not hang on an operator flag', () => {
    expect(inCircle(undefined, () => scopeFenceActive())).toBe(false);
    expect(inCircle('coach', () => scopeFenceActive())).toBe(true);
    expect(inCircle(undefined, () => scopeFenceSql('ana').clause)).toBe('');
    expect(inCircle('coach', () => scopeFenceSql('ana').clause)).not.toBe('');
  });

  it('a circle credential asking about no one is still not tenant-wide', () => {
    const fence = inCircle('coach', () => scopeFenceSql(undefined));
    expect(fence.params.principalScopeTag).toEqual(['circle:coach']);
  });

  it('tenant-wide authority acting in a circle loses only the other circles', () => {
    inCircle('coach', () => {
      expect(visibleUnderScope(['user:ana'], TENANT_WIDE)).toBe(true);
      expect(visibleUnderScope(['user:ana', 'circle:coach'], TENANT_WIDE)).toBe(true);
      expect(visibleUnderScope(['user:ana', 'circle:assistant'], TENANT_WIDE)).toBe(false);
    });
    inCircle(undefined, () => {
      expect(visibleUnderScope(['user:ana', 'circle:assistant'], TENANT_WIDE)).toBe(true);
    });
  });
});
