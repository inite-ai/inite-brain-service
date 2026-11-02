import { checkClaims, type CitedFact, type NliPort } from '../src/synthesize/claim-check';

/** A model with no opinion: every claim stands unless the number check removes it. */
const quiet: NliPort = async (_p, h) => h.map(() => 'neutral' as const);
const split = async (answer: string) =>
  (await checkClaims(answer, () => undefined, quiet)).sentences;

describe('sentence split', () => {
  it('splits sentences and reads the handles each cites', async () => {
    const s = await split(
      'Maya lives in Lisbon [f1]. She works at Acme [f2, f3]. Nothing cited here.',
    );
    expect(s.map((x) => x.handles)).toEqual([['f1'], ['f2', 'f3'], []]);
    expect(s[0]!.claim).toBe('Maya lives in Lisbon.');
    expect(s[1]!.claim).toBe('She works at Acme.');
  });

  it('a citation group the segmenter leaves on the next sentence belongs to the one before', async () => {
    const s = await split('Maya moved to Porto. [f1][r2] She likes it there.');
    expect(s).toHaveLength(2);
    expect(s[0]!.handles).toEqual(['f1', 'r2']);
    expect(s[1]!.handles).toEqual([]);
  });

  it('a bracket that is not a citation stays in the claim', async () => {
    const s = await split('The tier is gold [beta] [f4].');
    expect(s[0]!.handles).toEqual(['f4']);
    expect(s[0]!.claim).toBe('The tier is gold [beta].');
  });

  it('reads expanded record ids as citations', async () => {
    const s = await split('Maya lives in Porto [knowledge_fact:abc123, knowledge_edge:x9].');
    expect(s[0]!.handles).toEqual(['knowledge_fact:abc123', 'knowledge_edge:x9']);
    expect(s[0]!.claim).toBe('Maya lives in Porto.');
  });

  it('splits Russian and Portuguese prose', async () => {
    expect(await split('Мария живёт в Лиссабоне [f1]. Она врач [f2].')).toHaveLength(2);
    expect(await split('A Ana mora no Porto [f1]. Ela é médica [f2].')).toHaveLength(2);
  });
});

describe('checkClaims', () => {
  const facts: Record<string, CitedFact> = {
    'knowledge_fact:aaa111': { canonicalName: 'Maya', predicate: 'lives_in', object: 'Porto' },
    'knowledge_fact:bbb222': { canonicalName: 'Leo', predicate: 'manager', object: 'Ana' },
    'knowledge_fact:ccc333': { canonicalName: 'launch', predicate: 'budget', object: '2500 euros' },
  };
  /** A model that contradicts any hypothesis naming Bruno, and calls the rest neutral. */
  const calls: string[] = [];
  const nli: NliPort = async (premise, hypotheses) => {
    calls.push(premise);
    return hypotheses.map((h) => (h.includes('Bruno') ? 'contradiction' : 'neutral'));
  };
  beforeEach(() => (calls.length = 0));

  it('pairs a sentence with exactly the facts it cites, rendered as the generator saw them', async () => {
    await checkClaims(
      'Maya lives in Porto [knowledge_fact:aaa111]. Leo reports to Ana [knowledge_fact:aaa111, knowledge_fact:bbb222, f99].',
      (t) => facts[t],
      nli,
    );
    expect(calls).toEqual(['Maya — lives in: Porto', 'Maya — lives in: Porto\nLeo — manager: Ana']);
  });

  it('a sentence citing only unresolvable handles is not checked', async () => {
    await checkClaims('Bruno runs it [f99].', (t) => facts[t], nli);
    expect(calls).toEqual([]);
  });

  it('removes a contradicted sentence of a served answer and the citation only it carried', async () => {
    const answer =
      'Maya lives in Porto [knowledge_fact:aaa111]. Her manager is Bruno [knowledge_fact:bbb222]. Nothing else.';
    const r = await checkClaims(answer, (t) => facts[t], nli);
    expect(r.answer).toBe('Maya lives in Porto [knowledge_fact:aaa111]. Nothing else.');
    expect(r.removed.map((s) => s.claim)).toEqual(['Her manager is Bruno.']);
    expect(r.droppedTokens).toEqual(['knowledge_fact:bbb222']);
  });

  it('a number the cited fact does not state is removed even when the model says neutral', async () => {
    const r = await checkClaims(
      'The launch budget is 4000 euros [knowledge_fact:ccc333].',
      (t) => facts[t],
      nli,
    );
    expect(r.answer).toBe('');
    expect(r.removed).toHaveLength(1);
  });

  it('a citation another kept sentence also carries stays', async () => {
    const r = await checkClaims(
      'Maya lives in Porto [f1]. Bruno manages her [f1].',
      (t) => (t === 'f1' ? facts['knowledge_fact:aaa111'] : undefined),
      nli,
    );
    expect(r.answer).toBe('Maya lives in Porto [f1].');
    expect(r.droppedTokens).toEqual([]);
  });

  it('returns the answer untouched, layout included, when nothing is contradicted', async () => {
    const answer = 'Maya lives in Porto [f1].\n\n- one\n- two';
    const r = await checkClaims(
      answer,
      (t) => (t === 'f1' ? facts['knowledge_fact:aaa111'] : undefined),
      nli,
    );
    expect(r.answer).toBe(answer);
    expect(r.removed).toEqual([]);
  });

  it('keeps the layout of what remains after a removal', async () => {
    const r = await checkClaims(
      'Maya lives in Porto [f1].\nBruno manages Leo [f2].\nThat is all.',
      (t) =>
        t === 'f1'
          ? facts['knowledge_fact:aaa111']
          : t === 'f2'
            ? facts['knowledge_fact:bbb222']
            : undefined,
      nli,
    );
    expect(r.answer).toBe('Maya lives in Porto [f1].\nThat is all.');
  });

  it('sentences citing the same facts share one model call', async () => {
    await checkClaims(
      'Maya is in Porto [f1]. She likes Porto [f1].',
      () => facts['knowledge_fact:aaa111'],
      nli,
    );
    expect(calls).toHaveLength(1);
  });

  it('with no model every sentence stands but a number clash', async () => {
    const none: NliPort = async (_p, h) => h.map(() => undefined);
    const r = await checkClaims(
      'Bruno manages Leo [f1].',
      () => facts['knowledge_fact:bbb222'],
      none,
    );
    expect(r.removed).toEqual([]);
  });
});
