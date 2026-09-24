/**
 * The forge connector's pure parts (W4.8): an issue (or pull request)
 * and its comments as the turns of one conversation, and who each turn
 * speaks as.
 */
import { authorOf, turnsOf } from '../src/source-plane/connectors/github.connector';

const issue = {
  number: 12,
  title: 'Retries hammer the API on 429',
  body: 'We retry immediately, which makes the rate limit worse.\n\nProposal: honour Retry-After.',
  state: 'open',
  user: { login: 'gracehopper', name: 'Grace Hopper' },
  created_at: '2026-09-10T09:00:00Z',
  updated_at: '2026-09-15T10:00:00Z',
};

describe('github: an issue as a conversation', () => {
  it('the title rides on the first turn, the body follows, comments are turns in order', () => {
    const turns = turnsOf(issue, [
      {
        id: 1,
        user: { login: 'linus', name: 'Linus Berg' },
        body: 'Agreed — we decided to back off exponentially.',
        created_at: '2026-09-11T08:00:00Z',
      },
      {
        id: 2,
        user: { login: 'ci-bot', type: 'Bot' },
        body: 'Build passed.',
        created_at: '2026-09-12T08:00:00Z',
      },
    ]);
    expect(turns).toEqual([
      {
        text: 'Issue #12: Retries hammer the API on 429\n\nWe retry immediately, which makes the rate limit worse.\n\nProposal: honour Retry-After.',
        speaker: 'Grace Hopper',
        at: '2026-09-10T09:00:00Z',
        messageId: 'issue-12',
      },
      {
        text: 'Agreed — we decided to back off exponentially.',
        speaker: 'Linus Berg',
        at: '2026-09-11T08:00:00Z',
        messageId: 'comment-1',
      },
      {
        text: 'Build passed.',
        speaker: 'ci-bot (bot)',
        at: '2026-09-12T08:00:00Z',
        messageId: 'comment-2',
      },
    ]);
  });

  it('a pull request says so, a bodyless issue is still one turn, an empty comment is none', () => {
    const turns = turnsOf({ ...issue, body: null, pull_request: { url: 'x' } }, [
      { id: 3, user: { login: 'linus' }, body: '   ', created_at: '2026-09-11T08:00:00Z' },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe('PR #12: Retries hammer the API on 429');
  });

  it('authorOf: a name, else the login; nobody at all is named as such', () => {
    expect(authorOf({ login: 'linus', name: 'Linus Berg' })).toBe('Linus Berg');
    expect(authorOf({ login: 'linus', name: '  ' })).toBe('linus');
    expect(authorOf({ login: 'dependabot', type: 'Bot' })).toBe('dependabot (bot)');
    expect(authorOf(undefined)).toBe('unknown author');
  });
});
