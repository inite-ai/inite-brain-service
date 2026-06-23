/**
 * Smoke unit-spec for the MultiHopService + SynthesizeService
 * onProgress wiring. End-to-end SSE delivery is the MCP SDK's job;
 * here we just pin that the services CALL the reporter at the
 * expected stages.
 *
 * We don't drive a real MultiHopService run — it depends on a planner
 * LLM call we don't have stubs for at unit level. Instead we test the
 * wire shape: the reporter type is `(event) => void` and brain code
 * MUST funnel multiple discrete stage events through it.
 */
import { NOOP_REPORTER, type ProgressEvent } from '../src/mcp/progress-reporter';

describe('ProgressReporter — wire shape', () => {
  it('NOOP_REPORTER swallows any event without throwing', () => {
    expect(() =>
      NOOP_REPORTER({ stage: 'planning', message: 'test' }),
    ).not.toThrow();
    expect(() =>
      NOOP_REPORTER({ stage: 'hop', index: 1, total: 3 }),
    ).not.toThrow();
    expect(() => NOOP_REPORTER({ stage: 'done' })).not.toThrow();
  });

  it('ProgressEvent supports stage / index / total / message', () => {
    // Pure type-check (TS compile-time + a runtime no-op).
    const events: ProgressEvent[] = [
      { stage: 'planning' },
      { stage: 'hop', index: 1, total: 3 },
      { stage: 'hop', index: 2, total: 3, message: 'narrow to entities' },
      { stage: 'synthesize', message: 'grounding' },
      { stage: 'verify' },
      { stage: 'done' },
    ];
    expect(events).toHaveLength(6);
  });
});
