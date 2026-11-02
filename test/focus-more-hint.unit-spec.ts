/**
 * The focus view ends with how to see what it left out. That hint is an
 * instruction to the model, so it must name an argument the calling tool
 * accepts: synthesize and search_multi_hop printed `detail "compact"`,
 * which their schema refuses (found on a harness HaluMem run).
 */
import { renderFocus } from '../src/mcp/compact-read';
import { ANSWER_MORE, answerDetailArg } from '../src/mcp/answer-views';

const hit = (n: number) => ({
  entityId: 'knowledge_entity:m',
  canonicalName: 'Martin',
  score: 1,
  facts: Array.from({ length: n }, (_, i) => ({
    factId: `knowledge_fact:${i}`,
    predicate: `p${i}`,
    object: `value ${i}`,
    score: 1 / (i + 1),
  })),
});

describe('the omitted-facts hint', () => {
  it('names the value the answer tools accept', () => {
    const value = /detail "(\w+)"/.exec(ANSWER_MORE)?.[1];
    expect(answerDetailArg.safeParse(value).success).toBe(true);
  });

  it("is the caller's own, defaulting to search_knowledge's", () => {
    const out = { results: [hit(12)] } as never;
    const chars = (s: string) => s.length;
    const own = renderFocus({ out, sources: new Map(), tokens: chars, more: ANSWER_MORE });
    const search = renderFocus({ out, sources: new Map(), tokens: chars });
    expect(own).toMatch(/more: detail "full"\)/);
    expect(search).toMatch(/more: detail "compact"\)/);
  });
});
