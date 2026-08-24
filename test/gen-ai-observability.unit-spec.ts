/**
 * Unit-test for withGenAiCall: ensures both the OTel span attribute
 * shape AND the MetricsService.recordOpenAiCall plumbing fire on the
 * same call. Pre-fix, both paths were live but unwired — covers the
 * regression risk that a future refactor splits one but not the other.
 */
import { withGenAiCall } from '../src/common/gen-ai-observability';

interface RecordedCall {
  kind: 'chat' | 'embed';
  outcome: 'ok' | 'error';
  durationSeconds: number;
  promptTokens?: number;
  completionTokens?: number;
}

class FakeMetrics {
  recorded: RecordedCall[] = [];
  recordOpenAiCall(c: RecordedCall) {
    this.recorded.push(c);
  }
}

describe('withGenAiCall', () => {
  it('records ok + token counts from chat response.usage', async () => {
    const m = new FakeMetrics();
    const res = await withGenAiCall(
      { kind: 'chat', spanName: 'gen_ai.chat.test', system: 'openai', model: 'gpt-test' },
      m as any,
      async () => ({
        id: 'resp_abc',
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      }),
    );
    expect((res as any).id).toBe('resp_abc');
    expect(m.recorded).toHaveLength(1);
    expect(m.recorded[0]!.kind).toBe('chat');
    expect(m.recorded[0]!.outcome).toBe('ok');
    expect(m.recorded[0]!.promptTokens).toBe(12);
    expect(m.recorded[0]!.completionTokens).toBe(4);
    expect(m.recorded[0]!.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it('folds embed response.usage.total_tokens into promptTokens', async () => {
    const m = new FakeMetrics();
    await withGenAiCall(
      {
        kind: 'embed',
        spanName: 'gen_ai.embed.test',
        system: 'openai',
        model: 'text-embedding-3-small',
      },
      m as any,
      async () => ({ usage: { total_tokens: 7 } }),
    );
    expect(m.recorded[0]!.promptTokens).toBe(7);
    expect(m.recorded[0]!.completionTokens).toBeUndefined();
  });

  it('records outcome=error and re-throws when the inner fn throws', async () => {
    const m = new FakeMetrics();
    await expect(
      withGenAiCall(
        { kind: 'chat', spanName: 'gen_ai.chat.boom', system: 'openai', model: 'x' },
        m as any,
        async () => {
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');
    expect(m.recorded[0]!.outcome).toBe('error');
  });

  it('handles missing MetricsService gracefully (Optional inject)', async () => {
    const res = await withGenAiCall(
      { kind: 'chat', spanName: 'gen_ai.chat.no_metrics', system: 'openai', model: 'x' },
      undefined,
      async () => ({ id: 'r' }),
    );
    expect((res as any).id).toBe('r');
  });

  it('handles responses with no usage block (e.g. cached / partial)', async () => {
    const m = new FakeMetrics();
    await withGenAiCall(
      { kind: 'chat', spanName: 'gen_ai.chat.nousage', system: 'openai', model: 'x' },
      m as any,
      async () => ({ id: 'r' }),
    );
    expect(m.recorded[0]!.outcome).toBe('ok');
    expect(m.recorded[0]!.promptTokens).toBeUndefined();
    expect(m.recorded[0]!.completionTokens).toBeUndefined();
  });
});
