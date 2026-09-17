import { ConfigService } from '@nestjs/config';
import { PredicateSemanticsJudgeService } from '../src/ai/predicate-semantics-judge.service';
import { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import { DEFAULT_FALLBACK } from '../src/ai/predicate-registry-internals/types';

/**
 * The predicate CARDINALITY judge — the "future LLM-classify pass" the
 * canonicalize propose branch named and never got.
 *
 * Without it every coined predicate was registered `append_only`, and
 * append_only means no conflict is possible at ingest: the prior value
 * is never closed, never superseded, never marked competing. Measured on
 * a live tenant, 186 of 223 predicates were auto-coined and ALL 186 were
 * append_only, so supersession existed only for the ~15 seeded
 * single_active predicates and "what is the value NOW" had nothing to
 * answer with for anything else.
 *
 * What is pinned here is the SAFETY shape, not the model's taste: every
 * failure mode — no key, a throw, a malformed answer, an unknown enum
 * value — resolves to append_only, which is exactly today's behaviour.
 * The pass may only ever ADD supersession, never remove it.
 */
function makeConfig(over: Record<string, string> = {}): ConfigService {
  return {
    get: <T>(k: string, dflt?: T) => (over[k] as unknown as T) ?? (dflt as T),
  } as unknown as ConfigService;
}

/** A judge with a stubbed OpenAI client answering `content`. */
function judgeWith(content: string | null | (() => never)): PredicateSemanticsJudgeService {
  const judge = new PredicateSemanticsJudgeService(makeConfig());
  (judge as unknown as { openai: unknown }).openai = {
    chat: {
      completions: {
        create: async () => {
          if (typeof content === 'function') content();
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
  return judge;
}

describe('PredicateSemanticsJudgeService', () => {
  it('returns single_active only when the model says so', async () => {
    const judge = judgeWith(JSON.stringify({ semantics: 'single_active' }));
    await expect(judge.classify('deploy_target', 'deploy_target: AWS ECS Fargate')).resolves.toBe(
      'single_active',
    );
  });

  it('passes append_only through', async () => {
    const judge = judgeWith(JSON.stringify({ semantics: 'append_only' }));
    await expect(judge.classify('mentioned_topic', 'mentioned_topic: rate limits')).resolves.toBe(
      'append_only',
    );
  });

  it.each([
    ['no API key', null],
    ['empty response', ''],
  ])('degrades to append_only: %s', async (_label, content) => {
    const judge =
      content === null
        ? new PredicateSemanticsJudgeService(makeConfig())
        : judgeWith(content as string);
    if (content === null) {
      // No client at all — the shape a deployment without OPENAI_API_KEY has.
      (judge as unknown as { openai: unknown }).openai = undefined;
      expect(judge.isAvailable()).toBe(false);
    }
    await expect(judge.classify('deploy_target', 'x')).resolves.toBe('append_only');
  });

  it('degrades to append_only when the call throws', async () => {
    const judge = judgeWith(() => {
      throw new Error('boom');
    });
    await expect(judge.classify('deploy_target', 'x')).resolves.toBe('append_only');
  });

  it('degrades to append_only on unparseable or off-enum answers', async () => {
    await expect(judgeWith('not json').classify('p', 'x')).resolves.toBe('append_only');
    await expect(
      judgeWith(JSON.stringify({ semantics: 'bitemporal' })).classify('p', 'x'),
    ).resolves.toBe('append_only');
  });

  it('carries the nearest predicate and its semantics into the prompt', async () => {
    // The hint exists because `best` sits BELOW the alias threshold:
    // related enough to inform the judgment, too far to inherit from.
    let seen = '';
    const judge = new PredicateSemanticsJudgeService(makeConfig());
    (judge as unknown as { openai: unknown }).openai = {
      chat: {
        completions: {
          create: async (req: { messages: Array<{ content: string }> }) => {
            seen = req.messages.map((m) => m.content).join('\n');
            return { choices: [{ message: { content: '{"semantics":"single_active"}' } }] };
          },
        },
      },
    };
    await judge.classify('payout_cutoff', 'payout_cutoff: 16:30 UTC', {
      predicateId: 'payout_cutoff_time',
      semantics: 'single_active',
      similarity: 0.71,
    });
    expect(seen).toContain('payout_cutoff_time');
    expect(seen).toContain('single_active');
    expect(seen).toContain('0.710');
  });
});

describe('PredicateRegistryService — judge wiring', () => {
  /**
   * The @Optional() trap: an unwired judge must fall back to the
   * historical default rather than silently classifying nothing while
   * looking wired. Constructed positionally with three args — the shape
   * every existing unit test uses.
   */
  it('without a judge, a proposed predicate keeps DEFAULT_FALLBACK semantics', async () => {
    const svc = new PredicateRegistryService(undefined as never, undefined as never, makeConfig());
    const classify = (
      svc as unknown as {
        classifyProposedSemantics: (a: unknown) => Promise<string>;
      }
    ).classifyProposedSemantics.bind(svc);
    await expect(
      classify({
        predicate: 'deploy_target',
        contextText: 'x',
        best: undefined,
        snapshot: { byId: new Map() },
      }),
    ).resolves.toBe(DEFAULT_FALLBACK.semantics);
  });

  it('with a judge, the verdict is what lands on the row', async () => {
    const judge = { classify: async () => 'single_active' as const };
    const svc = new PredicateRegistryService(
      undefined as never,
      undefined as never,
      makeConfig(),
      judge as never,
    );
    const classify = (
      svc as unknown as {
        classifyProposedSemantics: (a: unknown) => Promise<string>;
      }
    ).classifyProposedSemantics.bind(svc);
    await expect(
      classify({
        predicate: 'deploy_target',
        contextText: 'x',
        best: undefined,
        snapshot: { byId: new Map() },
      }),
    ).resolves.toBe('single_active');
  });
});

/**
 * The prompt's contract, pinned as text.
 *
 * These are not style assertions. Each line is there because its absence
 * produced a measured failure: extraction passes the CLAUSE with the
 * coinage, and a clause narrates an action, so `deployed_to: Fly.io
 * (clause: we deploy ledger-sync to Fly.io for the pilot)` read as an
 * event and came back append_only on all six live tenants built from one
 * corpus — with `deploy_target` and `deploys_to` aliasing onto it and
 * inheriting that, so nothing in the deploy family could supersede at
 * all. The whole "what does it deploy to NOW" failure was that, not the
 * name fragmentation it was blamed on.
 */
describe('the cardinality prompt states what it must', () => {
  const sys = async (): Promise<string> => {
    let captured = '';
    const judge = new PredicateSemanticsJudgeService(makeConfig());
    (judge as unknown as { openai: unknown }).openai = {
      chat: {
        completions: {
          create: async (req: { messages: Array<{ content: string }> }) => {
            captured = req.messages[0]!.content;
            return {
              choices: [{ message: { content: JSON.stringify({ semantics: 'append_only' }) } }],
            };
          },
        },
      },
    };
    await judge.classify('x', 'x: 1');
    return captured;
  };

  it('asks the plural question, not "does it retire the old value"', async () => {
    expect(await sys()).toContain('CAN ONE SUBJECT HOLD SEVERAL OF THESE AT THE SAME TIME');
  });

  it('says a narrated action does not make a setting multi-valued', async () => {
    const s = await sys();
    expect(s).toContain('phrased as something that HAPPENED');
    expect(s).toContain('does not make the deploy target multi-valued');
  });

  it('says the value being a thing decides nothing', async () => {
    expect(await sys()).toContain('being a thing rather than a number or a date');
  });

  it('keeps graph edges append_only without a value-shape rule', async () => {
    // The old prompt reached this with "the value is another entity";
    // that proxy is what misfired, so the edges are now named outright.
    const s = await sys();
    expect(s).toMatch(/append_only[\s\S]*calls, depends_on, owns, replaces, superseded_by/);
  });

  it('keeps the conservative tie-break — ambiguity is append_only', async () => {
    const s = await sys();
    expect(s).toContain('equally plausible, answer "append_only"');
    expect(s).toContain('silently retires facts that should coexist');
  });
});
