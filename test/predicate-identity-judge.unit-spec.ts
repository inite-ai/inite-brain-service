import { ConfigService } from '@nestjs/config';
import { PredicateIdentityJudgeService } from '../src/ai/predicate-identity-judge.service';

/**
 * The identity judge — "is this coinage a new attribute, or a new NAME
 * for one we already have?".
 *
 * The whole point of the service is its CONSERVATIVE asymmetry: a wrong
 * merge folds one attribute's values into another slot where they
 * supersede each other (data destroyed), while a missed merge leaves the
 * duplicate that exists today (a cost we already pay). So every failure
 * mode must answer null, and only an id that was actually offered may
 * ever win.
 */
function svc(overrides: Record<string, string> = {}): {
  judge: PredicateIdentityJudgeService;
  calls: Array<{ system: string; user: string }>;
  reply: (content: string | null) => void;
  fail: (err: Error) => void;
} {
  const config = {
    get: <T>(k: string, dflt?: T) => (overrides[k] as unknown as T) ?? (dflt as T),
  } as unknown as ConfigService;
  const calls: Array<{ system: string; user: string }> = [];
  let next: { content: string | null } | Error = { content: null };
  const judge = new PredicateIdentityJudgeService(config);
  (judge as unknown as { openai: unknown }).openai = {
    chat: {
      completions: {
        create: (req: { messages: Array<{ role: string; content: string }> }) => {
          calls.push({
            system: req.messages[0]!.content,
            user: req.messages[1]!.content,
          });
          if (next instanceof Error) return Promise.reject(next);
          return Promise.resolve({ choices: [{ message: { content: next.content } }] });
        },
      },
    },
  };
  return {
    judge,
    calls,
    reply: (content) => {
      next = { content };
    },
    fail: (err) => {
      next = err;
    },
  };
}

describe('PredicateIdentityJudgeService', () => {
  it('returns the picked id when the model names an offered candidate', async () => {
    const t = svc();
    t.reply(JSON.stringify({ sameAttributeAs: 'queue_backend' }));
    await expect(
      t.judge.sameAttributeAs('job_queue_backend', 'job_queue_backend: NATS JetStream', [
        'queue_backend',
        'superseded_by',
      ]),
    ).resolves.toBe('queue_backend');
  });

  it('passes the coinage context AND every candidate into the one call', async () => {
    const t = svc();
    t.reply(JSON.stringify({ sameAttributeAs: null }));
    await t.judge.sameAttributeAs('deploys_to', 'deploys_to: Fly.io', [
      'deploy_target',
      'replaces',
    ]);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.user).toContain('deploys_to: Fly.io');
    expect(t.calls[0]!.user).toContain('"deploy_target"');
    expect(t.calls[0]!.user).toContain('"replaces"');
  });

  it('answers null for a JSON null', async () => {
    const t = svc();
    t.reply(JSON.stringify({ sameAttributeAs: null }));
    await expect(
      t.judge.sameAttributeAs('retry_delay', 'retry_delay: 30s', ['retry_attempts']),
    ).resolves.toBeNull();
  });

  it('answers null for the LITERAL string "null"', async () => {
    // A nullable strict-JSON field comes back as the string "null"
    // often enough to matter — observed while calibrating the prompt.
    const t = svc();
    t.reply(JSON.stringify({ sameAttributeAs: 'null' }));
    await expect(
      t.judge.sameAttributeAs('retry_delay', 'retry_delay: 30s', ['retry_attempts']),
    ).resolves.toBeNull();
  });

  it('REFUSES an id that was never offered (a hallucinated canon)', async () => {
    // Aliasing onto a predicate that does not exist would orphan the
    // slot; the offered set is the fence, not the prompt's request.
    const t = svc();
    t.reply(JSON.stringify({ sameAttributeAs: 'deploy_target' }));
    await expect(
      t.judge.sameAttributeAs('deploys_to', 'deploys_to: Fly.io', ['replaces', 'deploys']),
    ).resolves.toBeNull();
  });

  it('answers null on a throw, an empty body and unparseable JSON', async () => {
    const t = svc();
    t.fail(new Error('rate limited'));
    await expect(t.judge.sameAttributeAs('a', 'a: 1', ['b'])).resolves.toBeNull();
    t.reply(null);
    await expect(t.judge.sameAttributeAs('a', 'a: 1', ['b'])).resolves.toBeNull();
    t.reply('not json at all');
    await expect(t.judge.sameAttributeAs('a', 'a: 1', ['b'])).resolves.toBeNull();
  });

  it('never calls the model with an empty shortlist', async () => {
    const t = svc();
    t.reply(JSON.stringify({ sameAttributeAs: 'x' }));
    await expect(t.judge.sameAttributeAs('a', 'a: 1', [])).resolves.toBeNull();
    expect(t.calls).toHaveLength(0);
  });

  it('without an API key it is unavailable and answers null without calling', async () => {
    const config = { get: <T>(_k: string, d?: T) => d as T } as unknown as ConfigService;
    const judge = new PredicateIdentityJudgeService(config);
    (judge as unknown as { openai: unknown }).openai = undefined;
    expect(judge.isAvailable()).toBe(false);
    await expect(judge.sameAttributeAs('a', 'a: 1', ['b'])).resolves.toBeNull();
  });
});
