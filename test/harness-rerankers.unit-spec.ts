/**
 * In harness mode the server holds a placeholder key and refuses every
 * chat call, so the LLM reranker and the predicate identity judge are
 * not enabled there. Reporting the reranker enabled also kept the entity
 * cross-encoder from ever running (it skips when the LLM "orders" the
 * entities), leaving entities in fused order on a key-less stand.
 */
import type { ConfigService } from '@nestjs/config';
import { RerankerService } from '../src/ai/reranker.service';
import { PredicateIdentityJudgeService } from '../src/ai/predicate-identity-judge.service';

const config = (values: Record<string, string>) =>
  ({ get: (k: string, d?: string) => values[k] ?? d }) as unknown as ConfigService;

describe('model-backed rankers in harness mode', () => {
  const saved = process.env.EXTRACTION_SOURCE;
  afterEach(() => {
    if (saved === undefined) delete process.env.EXTRACTION_SOURCE;
    else process.env.EXTRACTION_SOURCE = saved;
  });
  const cfg = config({ OPENAI_API_KEY: 'sk-harness-mode-no-key' });

  it('the LLM reranker is enabled with a key in server mode only', () => {
    delete process.env.EXTRACTION_SOURCE;
    expect(new RerankerService(cfg).isEnabled()).toBe(true);
    process.env.EXTRACTION_SOURCE = 'harness';
    expect(new RerankerService(cfg).isEnabled()).toBe(false);
  });

  it('the predicate identity judge likewise', () => {
    process.env.EXTRACTION_SOURCE = 'harness';
    const judge = new PredicateIdentityJudgeService(cfg as never);
    expect(judge.isAvailable()).toBe(false);
  });
});
