/**
 * Unit-test for LocalNerService — opt-in flag, lazy classifier seam,
 * span aggregation over the pipeline's raw wordpieces, score filtering,
 * cache. Model not loaded in tests; classifier is injected via
 * setClassifierForTesting and returns what transformers.js 2.x returns:
 * one IOB-tagged row per wordpiece, no offsets.
 */
import type { ConfigService } from '@nestjs/config';
import { LocalNerService } from '../src/ai/local-ner.service';
import { aggregateNerTokens, type NerToken } from '../src/ai/ner-aggregate';

function mkConfig(over: Record<string, string> = {}): ConfigService {
  const data: Record<string, string> = {
    EXTRACTOR_LOCAL_NER_ENABLED: 'true',
    EXTRACTOR_LOCAL_NER_MIN_SCORE: '0.7',
    ...over,
  };
  return {
    get: (k: string, def?: string) => data[k] ?? def,
  } as unknown as ConfigService;
}

type MockPipeline = jest.Mock<any, any>;

function mkPipeline(tokens: NerToken[]): MockPipeline {
  return jest.fn(async () => tokens);
}

/** `[tag, word]` pairs → consecutive pipeline rows (index gaps = O tokens). */
function rows(pairs: Array<[string, string, number?] | null>, start = 1): NerToken[] {
  const out: NerToken[] = [];
  pairs.forEach((p, i) => {
    if (p) out.push({ entity: p[0], word: p[1], score: p[2] ?? 0.9, index: start + i });
  });
  return out;
}

describe('LocalNerService — disabled by default', () => {
  it('isReady=false until warmup completes', async () => {
    const svc = new LocalNerService(mkConfig({ EXTRACTOR_LOCAL_NER_ENABLED: 'false' }));
    expect(svc.isReady()).toBe(false);
    await expect(svc.extract('Maria works at Acme')).resolves.toEqual([]);
  });

  it('stats reflects disabled state', () => {
    const svc = new LocalNerService(mkConfig({ EXTRACTOR_LOCAL_NER_ENABLED: 'false' }));
    const s = svc.stats();
    expect(s.enabled).toBe(false);
    expect(s.ready).toBe(false);
  });
});

describe('aggregateNerTokens — wordpieces become spans', () => {
  it('glues ## subwords and IOB runs into one span cut from the source text', () => {
    // The prod junk: He / ##lio / Robot / ##ics minted four entities.
    const text = 'Helio Robotics launches its pilot in April.';
    const spans = aggregateNerTokens(
      text,
      rows([
        ['B-ORG', 'He', 0.98],
        ['I-ORG', '##lio', 0.9],
        ['I-ORG', 'Robot', 0.95],
        ['I-ORG', '##ics', 0.85],
      ]),
    );
    expect(spans).toEqual([
      { text: 'Helio Robotics', type: 'ORG', start: 0, end: 14, score: 0.92 },
    ]);
  });

  it('joins single CJK characters into the name, middle dot included', () => {
    // mBERT splits CJK into one token per character; the · was tagged
    // inside the run.
    const text = '阿尔乔姆·索科洛夫搬到波尔图。';
    const spans = aggregateNerTokens(
      text,
      rows([
        ['B-PER', '阿'],
        ['I-PER', '尔'],
        ['I-PER', '乔'],
        ['I-PER', '姆'],
        ['I-PER', '·'],
        ['I-PER', '索'],
        ['I-PER', '科'],
        ['I-PER', '洛'],
        ['I-PER', '夫'],
        null, // 搬 O
        null, // 到 O
        ['B-LOC', '波'],
        ['I-LOC', '尔'],
        ['I-LOC', '图'],
      ]),
    );
    expect(spans.map((s) => [s.text, s.type])).toEqual([
      ['阿尔乔姆·索科洛夫', 'PER'],
      ['波尔图', 'LOC'],
    ]);
    // No word completion over an unspaced script: 波尔图 stops before 。
    expect(spans[1]).toMatchObject({ start: 11, end: 14 });
  });

  it('a B- tag or an index gap (a dropped O token) ends the span', () => {
    const text = 'Maria met Ivan at Acme';
    const spans = aggregateNerTokens(
      text,
      rows([['B-PER', 'Maria'], null, ['B-PER', 'Ivan'], null, ['B-ORG', 'Acme']]),
    );
    expect(spans.map((s) => s.text)).toEqual(['Maria', 'Ivan', 'Acme']);
    const twoNames = aggregateNerTokens(
      'Maria Ivan',
      rows([
        ['B-PER', 'Maria'],
        ['B-PER', 'Ivan'],
      ]),
    );
    expect(twoNames.map((s) => s.text)).toEqual(['Maria', 'Ivan']);
  });

  it('completes a span to the word when its other pieces were tagged O', () => {
    // "Robot" tagged, "##ics" dropped as O: the entity is still the word.
    const text = 'at Robotics today';
    const spans = aggregateNerTokens(text, rows([['B-ORG', 'Robot']], 2));
    expect(spans).toEqual([{ text: 'Robotics', type: 'ORG', start: 3, end: 11, score: 0.9 }]);
    // A run starting on a continuation piece walks back to the word start.
    const tail = aggregateNerTokens(text, rows([['B-ORG', '##ics']], 3));
    expect(tail[0]).toMatchObject({ text: 'Robotics', start: 3, end: 11 });
  });

  it('a stray punctuation token never becomes a span', () => {
    expect(aggregateNerTokens('Acme · Corp', rows([['B-ORG', '·']], 2))).toEqual([]);
  });

  it('a piece missing from the text is skipped, closing the open span', () => {
    const spans = aggregateNerTokens(
      'Maria at Acme',
      rows([
        ['B-PER', 'Maria'],
        ['I-PER', '[UNK]'],
        ['B-ORG', 'Acme'],
      ]),
    );
    expect(spans.map((s) => s.text)).toEqual(['Maria', 'Acme']);
  });
});

describe('LocalNerService — with mocked classifier', () => {
  it('extracts entities above min score threshold', async () => {
    const svc = new LocalNerService(mkConfig());
    svc.setClassifierForTesting(
      mkPipeline(
        rows([
          ['B-PER', 'Maria', 0.96],
          ['I-PER', 'Petrov', 0.94],
          null,
          ['B-MISC', 'CTO', 0.5],
          null,
          ['B-ORG', 'Acme', 0.85],
        ]),
      ),
    );
    const out = await svc.extract('Maria Petrov is CTO at Acme');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      text: 'Maria Petrov',
      type: 'PER',
      start: 0,
      end: 12,
      score: 0.95,
    });
    expect(out[1]!.type).toBe('ORG');
  });

  it('uppercases entity types', async () => {
    const svc = new LocalNerService(mkConfig());
    svc.setClassifierForTesting(mkPipeline(rows([['B-loc', 'Berlin']])));
    const out = await svc.extract('Berlin');
    expect(out[0]!.type).toBe('LOC');
  });

  it('caches results per trimmed input', async () => {
    const svc = new LocalNerService(mkConfig());
    const pipe = mkPipeline(rows([['B-PER', 'Maria']]));
    svc.setClassifierForTesting(pipe);
    await svc.extract('Maria');
    await svc.extract('Maria');
    expect(pipe).toHaveBeenCalledTimes(1);
  });

  it('falls back to [] on pipeline throw', async () => {
    const svc = new LocalNerService(mkConfig());
    svc.setClassifierForTesting(
      jest.fn(async () => {
        throw new Error('boom');
      }) as MockPipeline,
    );
    await expect(svc.extract('anything')).resolves.toEqual([]);
  });

  it('respects min score override', async () => {
    const svc = new LocalNerService(mkConfig({ EXTRACTOR_LOCAL_NER_MIN_SCORE: '0.99' }));
    svc.setClassifierForTesting(mkPipeline(rows([['B-PER', 'Maria', 0.95]])));
    await expect(svc.extract('Maria')).resolves.toEqual([]);
  });
});
