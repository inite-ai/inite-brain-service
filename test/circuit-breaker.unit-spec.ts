/** The circuit breaker state machine (#853, ai/circuit-breaker.ts). */
import { CircuitBreaker, breakerSettings } from '../src/ai/circuit-breaker';

const settings = () => ({ failures: 3, cooldownMs: 1_000 });

describe('circuit breaker', () => {
  it('stays closed under fewer consecutive failures than the threshold', () => {
    const b = new CircuitBreaker(settings);
    b.onFailure(0);
    b.onFailure(0);
    b.onSuccess();
    b.onFailure(0);
    b.onFailure(0);
    expect(b.current()).toBe('closed');
    expect(b.allow(0)).toBe(true);
  });

  it('opens at the threshold and refuses until the cool-down passes', () => {
    const b = new CircuitBreaker(settings);
    for (let i = 0; i < 3; i++) b.onFailure(100);
    expect(b.current()).toBe('open');
    expect(b.allow(500)).toBe(false);
    expect(b.allow(1_099)).toBe(false);
  });

  it('lets exactly one probe through after the cool-down; its success closes', () => {
    const b = new CircuitBreaker(settings);
    for (let i = 0; i < 3; i++) b.onFailure(0);
    expect(b.allow(1_000)).toBe(true);
    expect(b.current()).toBe('half_open');
    expect(b.allow(1_001)).toBe(false);
    b.onSuccess();
    expect(b.current()).toBe('closed');
    expect(b.allow(1_002)).toBe(true);
  });

  it('a failed probe re-opens for another cool-down', () => {
    const b = new CircuitBreaker(settings);
    for (let i = 0; i < 3; i++) b.onFailure(0);
    expect(b.allow(1_000)).toBe(true);
    b.onFailure(1_000);
    expect(b.current()).toBe('open');
    expect(b.allow(1_500)).toBe(false);
    expect(b.allow(2_000)).toBe(true);
  });

  it('a probe that ended neutral (a request-side error) frees the slot for the next', () => {
    const b = new CircuitBreaker(settings);
    for (let i = 0; i < 3; i++) b.onFailure(0);
    expect(b.allow(1_000)).toBe(true);
    b.onNeutral();
    expect(b.allow(1_001)).toBe(true);
  });

  it('reads its thresholds as values with the documented defaults', () => {
    expect(breakerSettings(() => undefined)).toEqual({ failures: 5, cooldownMs: 30_000 });
    expect(breakerSettings((k) => (k === 'LLM_BREAKER_FAILURES' ? '2' : '500'))).toEqual({
      failures: 2,
      cooldownMs: 500,
    });
  });
});
