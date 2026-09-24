/**
 * The prompt/schema side of the memory contract and the audit stage:
 *  - both extraction headers carry the MEMORY section; the schema has
 *    entities[].known, facts[].eventTime and facts[].supersedes in lockstep;
 *  - the extractor's user message opens with the memory sections and
 *    ends with CURRENT TURN before the text, speaker framing first;
 *  - the auditor's prompt states the query's date and the seven non-claims;
 *  - the generator's revision frame carries the previous answer and the
 *    named claims ahead of the evidence.
 */
import type OpenAI from 'openai';
import {
  buildConversationContext,
  buildDialogueSystemPrompt,
  buildExtractionSchema,
  buildSystemPrompt,
  MEMORY_CONTRACT_SECTION,
} from '../src/ai/extractor-internals/prompts';
import { runVerifier } from '../src/synthesize/verifier';
import { buildGeneratorUserMessage } from '../src/synthesize/generator-prompt';

describe('the memory contract in the extraction prompts', () => {
  it('both headers carry the section; the schema fields are required in lockstep', () => {
    expect(buildSystemPrompt([])).toContain(MEMORY_CONTRACT_SECTION);
    expect(buildDialogueSystemPrompt([])).toContain(MEMORY_CONTRACT_SECTION);
    const schema = buildExtractionSchema() as {
      properties: {
        entities: { items: { properties: Record<string, unknown>; required: string[] } };
        facts: { items: { properties: Record<string, unknown>; required: string[] } };
      };
    };
    expect(schema.properties.entities.items.properties.known).toMatchObject({
      type: ['string', 'null'],
    });
    expect(schema.properties.entities.items.required).toContain('known');
    expect(schema.properties.facts.items.properties.eventTime).toMatchObject({
      type: ['string', 'null'],
    });
    expect(schema.properties.facts.items.properties.supersedes).toMatchObject({ type: 'array' });
    expect(schema.properties.facts.items.required).toEqual(
      expect.arrayContaining(['eventTime', 'supersedes']),
    );
  });

  it('the user-message prefix: speaker framing, then the memory, then CURRENT TURN', () => {
    const prefix = buildConversationContext({
      speakerName: 'Mike',
      memory: {
        occurredAt: '2026-09-16T11:00:00Z',
        recentTurns: [],
        entities: [
          { handle: 'e1', id: 'knowledge_entity:rk', name: 'RK Imóveis', type: 'customer' },
        ],
        facts: [],
        predicates: [],
      },
    });
    expect(prefix.indexOf('CONVERSATION CONTEXT')).toBeLessThan(prefix.indexOf('TURN DATE'));
    expect(prefix).toContain('[e1] RK Imóveis (customer)');
    expect(prefix.endsWith('CURRENT TURN:\n')).toBe(true);
    // No speaker, no memory ⇒ byte-identical to the context-free call.
    expect(buildConversationContext({})).toBe('');
  });
});

describe("the auditor knows the query's date and the non-claims", () => {
  function capturing(users: string[], systems: string[]): OpenAI {
    return {
      chat: {
        completions: {
          create: async (req: { messages: Array<{ role: string; content: string }> }) => {
            users.push(req.messages.find((m) => m.role === 'user')?.content ?? '');
            systems.push(req.messages.find((m) => m.role === 'system')?.content ?? '');
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
                  },
                },
              ],
            };
          },
        },
      },
    } as unknown as OpenAI;
  }
  const base = {
    query: 'what is due this week?',
    answer: 'The board decides on 19 September.',
    factLines: ['[f1] RK Imóveis — decision_date: 19 сентября (on 2026-09-19)'],
    model: 'gpt-test',
  };

  it('renders Today only when given; the rules cover calendar placement, evidence scope, layout and currency', async () => {
    const users: string[] = [];
    const systems: string[] = [];
    await runVerifier({ ...base, dateContext: '2026-09-18', openai: capturing(users, systems) });
    await runVerifier({ ...base, openai: capturing(users, systems) });
    expect(users[0]).toContain("Today (the query's date): 2026-09-18");
    expect(users[1]).not.toContain('Today (');
    expect(systems[0]).toContain('Seven things are NOT unsupported claims');
    expect(systems[0]).toContain('Placing the evidence on the calendar');
    expect(systems[0]).toContain('A statement about the evidence itself');
    expect(systems[0]).toContain('Layout is not a claim');
    expect(systems[0]).toContain('The evidence IS the current state');
  });

  it('names the asker beside Today, only when one is known', async () => {
    const users: string[] = [];
    const systems: string[] = [];
    await runVerifier({
      ...base,
      query: 'Do I currently own the Riga apartment?',
      dateContext: '2026-09-18',
      asker: { entityId: 'knowledge_entity:u', name: 'Sasha' },
      openai: capturing(users, systems),
    });
    await runVerifier({ ...base, openai: capturing(users, systems) });
    expect(users[0]).toContain(
      'Today (the query\'s date): 2026-09-18\nAsker: "you" in the evidence is the person asking (Sasha)',
    );
    expect(users[0]).toContain('evidence headed "you" supports claims about them');
    expect(users[1]).not.toContain('Asker:');
  });
});

describe('the asker in the generator frame', () => {
  it('opens right after the query and addresses them in the second person; absent without one', () => {
    const base = { query: 'Do I own the Riga apartment?', factLines: ['[f1] a'], answerLang: null };
    const msg = buildGeneratorUserMessage({
      ...base,
      asker: { entityId: 'knowledge_entity:u', name: 'Sasha' },
    });
    expect(
      msg.startsWith(
        'Query: Do I own the Riga apartment?\nAsker: the evidence lines headed "you" are about the person asking (Sasha)',
      ),
    ).toBe(true);
    expect(msg).toContain('Address them in the second person ("you", "your")');
    // No name learned yet: the line says so instead of showing an id.
    expect(
      buildGeneratorUserMessage({ ...base, asker: { entityId: 'knowledge_entity:u', name: null } }),
    ).toContain('(the memory has not learned their name yet)');
    expect(buildGeneratorUserMessage(base)).not.toContain('Asker:');
  });
});

describe('the revision frame', () => {
  const base = {
    query: 'q',
    factLines: ['[f1] a', '[f2] b'],
    answerLang: null as string | null,
  };

  it('opens the message with the previous answer and the named claims', () => {
    const msg = buildGeneratorUserMessage({
      ...base,
      revise: { answer: 'A and B [f2]', unsupportedClaims: ['«B» is inferred'] },
    });
    expect(msg.indexOf('REVISION.')).toBeLessThan(msg.indexOf('Retrieved facts:'));
    expect(msg).toContain('Previous answer:\nA and B [f2]');
    expect(msg).toContain('Claims the evidence does not support:\n- «B» is inferred');
  });

  it('is absent without a revision', () => {
    expect(buildGeneratorUserMessage(base)).not.toContain('REVISION.');
  });
});
