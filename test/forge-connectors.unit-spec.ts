/**
 * The forge connectors' pure parts: an issue (or pull request / merge
 * request) and its comments as the turns of one conversation, and who
 * each turn speaks as — on GitHub (W4.8) and on GitLab (W4.9), where
 * issues and merge requests are numbered separately and the activity
 * feed arrives as notes.
 */
import { authorOf, turnsOf } from '../src/source-plane/connectors/github.connector';
import {
  authorOf as gitlabAuthorOf,
  conversationId,
  turnsOf as gitlabTurnsOf,
} from '../src/source-plane/connectors/gitlab.connector';

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

const glIssue = {
  iid: 12,
  title: 'Retries hammer the API on 429',
  description: 'We retry immediately, which makes the rate limit worse.',
  state: 'opened',
  author: { username: 'gracehopper', name: 'Grace Hopper' },
  created_at: '2026-09-10T09:00:00Z',
  updated_at: '2026-09-15T10:00:00Z',
};

describe('gitlab: an issue or merge request as a conversation', () => {
  it('the title rides on the first turn and notes follow — but never the activity feed', () => {
    const turns = gitlabTurnsOf('issue', glIssue, [
      {
        id: 91,
        author: { username: 'linus', name: 'Linus Berg' },
        body: 'Agreed — we decided to back off exponentially.',
        created_at: '2026-09-11T08:00:00Z',
      },
      {
        id: 92,
        author: { username: 'linus', name: 'Linus Berg' },
        body: 'changed the description',
        system: true,
        created_at: '2026-09-11T08:05:00Z',
      },
      {
        id: 93,
        author: { username: 'release_bot', bot: true },
        body: 'Pipeline #4 passed.',
        created_at: '2026-09-12T08:00:00Z',
      },
    ]);
    expect(turns).toEqual([
      {
        text: 'Issue #12: Retries hammer the API on 429\n\nWe retry immediately, which makes the rate limit worse.',
        speaker: 'Grace Hopper',
        at: '2026-09-10T09:00:00Z',
        messageId: 'issue-12',
      },
      {
        text: 'Agreed — we decided to back off exponentially.',
        speaker: 'Linus Berg',
        at: '2026-09-11T08:00:00Z',
        messageId: 'note-91',
      },
      {
        text: 'Pipeline #4 passed.',
        speaker: 'release_bot (bot)',
        at: '2026-09-12T08:00:00Z',
        messageId: 'note-93',
      },
    ]);
  });

  it("a merge request carries GitLab's own sigil, and an issue #5 is not the merge request !5", () => {
    const turns = gitlabTurnsOf('mr', { ...glIssue, iid: 5, description: null }, []);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe('MR !5: Retries hammer the API on 429');
    expect(turns[0]!.messageId).toBe('mr-5');
    const cfg = { project: 'acme/handbook' };
    expect(conversationId(cfg, 'issue', 5)).toBe('gl:acme/handbook#5');
    expect(conversationId(cfg, 'mr', 5)).toBe('gl:acme/handbook!5');
  });

  it('authorOf: a name, else the username; a service account says so', () => {
    expect(gitlabAuthorOf({ username: 'linus', name: 'Linus Berg' })).toBe('Linus Berg');
    expect(gitlabAuthorOf({ username: 'linus', name: '  ' })).toBe('linus');
    expect(gitlabAuthorOf({ username: 'project_7_bot', bot: true })).toBe('project_7_bot (bot)');
    expect(gitlabAuthorOf(undefined)).toBe('unknown author');
  });
});
