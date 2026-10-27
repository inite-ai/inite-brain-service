/**
 * What a served answer teaches about raw text (src/synthesize/raw-lesson.ts):
 * any served answer citing raw turns — the primary serve as much as L3 —
 * with whether facts carried it too; nothing for an abstention or an
 * answer that cites no raw turn.
 */
import { rawLessonOf } from '../src/synthesize/raw-lesson';

const ctx = { cache: undefined, companyId: 'co', dto: { query: 'Q?', userId: 'u1' } } as never;
const final = (over: Record<string, unknown> = {}) =>
  ({
    answer: 'A.',
    citations: [],
    results: [],
    evidenceCitations: [{ episodeId: 'episode:1' }, { beliefId: 'belief:x' }],
    ...over,
  }) as never;

describe('rawLessonOf', () => {
  it('names the cited raw turns, the question, the answer and the scope', () => {
    expect(rawLessonOf(ctx, final())).toEqual({
      companyId: 'co',
      userId: 'u1',
      episodeIds: ['episode:1'],
      question: 'Q?',
      answer: 'A.',
      factCited: false,
    });
  });

  it('says when facts carried the answer too', () => {
    expect(
      rawLessonOf(ctx, final({ citations: [{ factId: 'knowledge_fact:f' }] }))?.factCited,
    ).toBe(true);
  });

  it('teaches nothing from an abstention, an empty answer or no raw citation', () => {
    expect(rawLessonOf(ctx, final({ reason: 'low_coverage' }))).toBeNull();
    expect(rawLessonOf(ctx, final({ answer: null }))).toBeNull();
    expect(rawLessonOf(ctx, final({ evidenceCitations: [{ beliefId: 'b' }] }))).toBeNull();
    expect(rawLessonOf({ cache: undefined } as never, final())).toBeNull();
  });
});
