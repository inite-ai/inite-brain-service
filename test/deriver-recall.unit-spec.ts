import { ConfigService } from '@nestjs/config';
import {
  WindowDeriverService,
  DERIVER_COMPLETION_PROMPT,
  propositionKey,
} from '../src/admin/window-deriver.service';
import { SurrealService } from '../src/db/surreal.service';
import { FactEmbeddingService } from '../src/ingest/fact-embedding.service';
import { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';

/**
 * V7 deriver-recall: the finish_reason truncation guard and the
 * DERIVER_COMPLETION_PASS "what was missed" second pass. The base
 * behavior (flag off, untruncated response) must be byte-identical
 * single-pass — worlds derived under different pass counts must not
 * share a version (ewave rule).
 */
describe('deriver recall (V7)', () => {
  const OLD = process.env.DERIVER_COMPLETION_PASS;
  afterEach(() => {
    if (OLD === undefined) delete process.env.DERIVER_COMPLETION_PASS;
    else process.env.DERIVER_COMPLETION_PASS = OLD;
  });

  const prop = (subject: string, proposition: string) => ({
    subject,
    aspect: 'pets',
    proposition,
    occurred_on: null,
    turns: [1],
  });

  function makeSvc(create: jest.Mock): WindowDeriverService {
    const config = {
      get: (k: string, d?: string) => (k === 'OPENAI_API_KEY' ? 'sk' : d),
      getOrThrow: () => 'sk',
    } as unknown as ConfigService;
    const surreal = {} as unknown as SurrealService;
    const svc = new WindowDeriverService(
      surreal,
      config,
      {} as unknown as FactEmbeddingService,
      {} as unknown as EpisodeReadStoreService,
      {} as never,
    );
    (svc as unknown as { openai: unknown }).openai = {
      chat: { completions: { create } },
    };
    return svc;
  }

  const callDeriver = (svc: WindowDeriverService) =>
    (
      svc as unknown as {
        callDeriver(
          d: Date,
          p: string[],
          t: string[],
        ): Promise<Array<{ subject: string; proposition: string }>>;
      }
    ).callDeriver(new Date('2023-05-01T00:00:00Z'), ['A', 'B'], ['1: hi']);

  const ok = (props: unknown[]) => ({
    choices: [
      {
        finish_reason: 'stop',
        message: { content: JSON.stringify({ propositions: props }) },
      },
    ],
  });
  const truncated = () => ({
    choices: [{ finish_reason: 'length', message: { content: '{"proposi' } }],
  });

  it('flag off → exactly one pass', async () => {
    delete process.env.DERIVER_COMPLETION_PASS;
    const create = jest.fn(async () => ok([prop('A', 'A has a dog.')]));
    const out = await callDeriver(makeSvc(create));
    expect(out).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('truncated response retries once at a larger cap, then succeeds', async () => {
    delete process.env.DERIVER_COMPLETION_PASS;
    const create = jest
      .fn()
      .mockResolvedValueOnce(truncated())
      .mockResolvedValueOnce(ok([prop('A', 'A has a dog.')]));
    const out = await callDeriver(makeSvc(create));
    expect(out).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].max_completion_tokens).toBeLessThan(
      create.mock.calls[1][0].max_completion_tokens,
    );
  });

  it('still truncated at the top cap → throws (fail-loud)', async () => {
    delete process.env.DERIVER_COMPLETION_PASS;
    const create = jest.fn(async () => truncated());
    await expect(callDeriver(makeSvc(create))).rejects.toThrow(/truncated/);
  });

  it('completion pass unions ONLY novel propositions', async () => {
    process.env.DERIVER_COMPLETION_PASS = '1';
    const base = [prop('A', 'A has a dog named Rex.')];
    const extra = [
      prop('A', 'A has a dog named Rex'), // dup modulo period — dropped
      prop('B', 'B is moving to Lisbon in June.'), // novel — kept
    ];
    const create = jest
      .fn()
      .mockResolvedValueOnce(ok(base))
      .mockResolvedValueOnce(ok(extra));
    const out = await callDeriver(makeSvc(create));
    expect(out).toHaveLength(2);
    expect(out[1]!.proposition).toContain('Lisbon');
    // The follow-up turn carries the base list + the completion prompt.
    const followupMessages = create.mock.calls[1][0].messages;
    expect(followupMessages.at(-1).content).toBe(DERIVER_COMPLETION_PROMPT);
    expect(followupMessages.at(-2).role).toBe('assistant');
    expect(followupMessages.at(-2).content).toContain('Rex');
  });

  it('completion-pass failure degrades to the base pass', async () => {
    process.env.DERIVER_COMPLETION_PASS = '1';
    const create = jest
      .fn()
      .mockResolvedValueOnce(ok([prop('A', 'A has a dog.')]))
      .mockRejectedValueOnce(new Error('boom'));
    const out = await callDeriver(makeSvc(create));
    expect(out).toHaveLength(1);
  });

  it('propositionKey normalizes case/whitespace/trailing period', () => {
    expect(
      propositionKey({ subject: ' Caroline ', proposition: 'Has  two cats.' }),
    ).toBe(propositionKey({ subject: 'caroline', proposition: 'has two cats' }));
  });

  /**
   * G3 (DERIVER_SPANS): quotes exist in the request schema and the
   * system prompt ONLY under the flag — off must stay byte-identical
   * to today's call (same conditional-schema idiom as scene/kind).
   */
  describe('DERIVER_SPANS schema gating (G3)', () => {
    const OLD_SPANS = process.env.DERIVER_SPANS;
    afterEach(() => {
      if (OLD_SPANS === undefined) delete process.env.DERIVER_SPANS;
      else process.env.DERIVER_SPANS = OLD_SPANS;
    });

    const itemSchema = (call: unknown) =>
      (
        call as {
          response_format: {
            json_schema: {
              schema: {
                properties: {
                  propositions: {
                    items: {
                      properties: Record<string, unknown>;
                      required: string[];
                    };
                  };
                };
              };
            };
          };
        }
      ).response_format.json_schema.schema.properties.propositions.items;

    it('flag off (default): no quotes in schema, no span section in prompt', async () => {
      delete process.env.DERIVER_SPANS;
      const create = jest.fn().mockResolvedValue(ok([prop('A', 'A has a dog.')]));
      await callDeriver(makeSvc(create));
      const items = itemSchema(create.mock.calls[0][0]);
      expect(items.properties).not.toHaveProperty('quotes');
      expect(items.required).not.toContain('quotes');
      expect(create.mock.calls[0][0].messages[0].content).not.toContain(
        'GROUNDING QUOTES',
      );
    });

    it('flag on: quotes required in schema, span section in the prompt, quotes ride through', async () => {
      process.env.DERIVER_SPANS = '1';
      const create = jest
        .fn()
        .mockResolvedValue(
          ok([{ ...prop('A', 'A has a dog.'), quotes: ['has a dog'] }]),
        );
      const out = await callDeriver(makeSvc(create));
      const items = itemSchema(create.mock.calls[0][0]);
      expect(items.properties.quotes).toEqual({
        type: 'array',
        items: { type: ['string', 'null'] },
      });
      expect(items.required).toContain('quotes');
      expect(create.mock.calls[0][0].messages[0].content).toContain(
        'GROUNDING QUOTES',
      );
      expect(
        (out[0] as { quotes?: Array<string | null> }).quotes,
      ).toEqual(['has a dog']);
    });
  });
});
