/**
 * @inite/brain-agent — the connector's other host, without a brain:
 *  - redaction replaces credentials and keeps the prose;
 *  - the fs connector walks like the brain's (hidden / excluded /
 *    symlinked / oversized skipped, mtime:size revisions, binary shape by
 *    modality) and refuses an escape from the root;
 *  - the git connector reads the committed docs with blob shas as
 *    revisions and cat-files the exact blob (skipped when git is absent);
 *  - the runner drives the protocol in batches, fetches only what the
 *    brain named, redacts, finishes with the checkpoint, and reports a
 *    failed run as such;
 *  - the protocol client surfaces the brain's error text.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsAgentConnector, containedPath } from '../clients/brain-agent/src/connectors/fs';
import {
  GitAgentConnector,
  includeMatcher,
  normaliseRemote,
} from '../clients/brain-agent/src/connectors/git';
import { BrainAgentClient, BrainApiError } from '../clients/brain-agent/src/protocol';
import { redactSecrets } from '../clients/brain-agent/src/redact';
import { connectorFor, runConnection } from '../clients/brain-agent/src/runner';
import type {
  AgentConnection,
  AgentConnector,
  ConnectorCtx,
  FetchedItem,
  ItemDelta,
  ItemDescriptor,
  SourceEntry,
} from '../clients/brain-agent/src/types';

function connection(over: Partial<AgentConnection> = {}): AgentConnection {
  return {
    id: 'source_connection:a1',
    packId: 'file_memory',
    sourceId: 'folder',
    kind: 'native',
    connector: 'fs',
    shape: 'document',
    host: 'agent:laptop',
    label: null,
    config: {},
    contentPolicy: 'text',
    schedule: 'manual',
    status: 'active',
    ...over,
  };
}

function ctx(conn: AgentConnection, source: SourceEntry | null = null): ConnectorCtx {
  return { connection: conn, source, signal: new AbortController().signal, log: () => undefined };
}

async function walk(c: AgentConnector, x: ConnectorCtx): Promise<ItemDelta[]> {
  const out: ItemDelta[] = [];
  for await (const d of c.enumerate(x, { checkpoint: null, full: true })) out.push(d);
  return out;
}
const ids = (deltas: ItemDelta[]) =>
  deltas
    .filter((d): d is Extract<ItemDelta, { type: 'upsert' }> => d.type === 'upsert')
    .map((d) => d.item.externalId)
    .sort();

describe('redactSecrets', () => {
  it('replaces credentials by kind and keeps everything else', () => {
    const { text, hits } = redactSecrets(
      [
        'Deploy with AKIAIOSFODNN7EXAMPLE and token ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD.',
        'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop',
        'api_key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"',
        'password: hunter2hunter2',
        '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----',
        'The CTO is Maria Lind.',
      ].join('\n'),
    );
    expect(text).not.toMatch(/AKIA|ghp_|eyJ|sk-proj|hunter2|MIIB/);
    expect(text).toContain('The CTO is Maria Lind.');
    expect(text).toContain('api_key = "[redacted:');
    expect(text).toContain('password: [redacted:secret_assignment]');
    expect(hits.private_key).toBe(1);
    expect(hits.aws_access_key).toBe(1);
    expect(hits.github_token).toBe(1);
    expect(redactSecrets('nothing secret here').hits).toEqual({});
  });
});

describe('FsAgentConnector', () => {
  let base = '';
  let root = '';
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'brain-agent-fs-'));
    root = join(base, 'vault');
    await mkdir(join(root, 'docs'), { recursive: true });
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await mkdir(join(base, 'outside'), { recursive: true });
    await writeFile(join(root, 'README.md'), '# Vault');
    await writeFile(join(root, 'docs', 'plan.md'), 'plan');
    await writeFile(join(root, 'docs', 'scan.pdf'), '%PDF-1.4');
    await writeFile(join(root, 'docs', 'bin.md'), Buffer.from([0x41, 0x00]));
    await writeFile(join(root, '.hidden.md'), 'h');
    await writeFile(join(root, 'node_modules', 'x.md'), 'dep');
    await writeFile(join(root, 'big.md'), 'x'.repeat(5000));
    await writeFile(join(base, 'outside', 'leak.md'), 'leak');
    await symlink(join(base, 'outside', 'leak.md'), join(root, 'link.md'));
    await utimes(
      join(root, 'README.md'),
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-01T00:00:00Z'),
    );
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('walks the brain’s way and fetches by shape', async () => {
    const c = new FsAgentConnector();
    const x = ctx(connection({ config: { root, maxFileBytes: 4000 } }));
    const deltas = await walk(c, x);
    expect(ids(deltas)).toEqual(['README.md', 'docs/bin.md', 'docs/plan.md']);
    const readme = deltas.find(
      (d) => d.type === 'upsert' && d.item.externalId === 'README.md',
    ) as Extract<ItemDelta, { type: 'upsert' }>;
    expect(readme.item).toMatchObject({
      mediaType: 'text/markdown',
      revision: `${Date.UTC(2026, 8, 1)}:7`,
      originUri: `file://${join(root, 'README.md')}`,
    });
    expect(deltas.at(-1)).toMatchObject({ type: 'checkpoint', checkpoint: { files: 3 } });
    expect(await c.fetch(x, { externalId: 'docs/plan.md' })).toMatchObject({
      shape: 'document',
      text: 'plan',
      title: 'plan.md',
      kind: 'file',
    });
    await expect(c.fetch(x, { externalId: 'docs/bin.md' })).rejects.toThrow('binary content');
    await expect(c.fetch(x, { externalId: '../outside/leak.md' })).rejects.toThrow(
      'escapes the root',
    );
    await expect(c.fetch(x, { externalId: 'link.md' })).rejects.toThrow('not a regular file');

    const bin = ctx(connection({ shape: 'binary', config: { root } }));
    expect(ids(await walk(c, bin))).toEqual(['docs/scan.pdf']);
    const pdf = await c.fetch(bin, { externalId: 'docs/scan.pdf' });
    expect(pdf).toMatchObject({
      shape: 'binary',
      mediaType: 'application/pdf',
      modality: 'document',
    });
    expect(Buffer.from((pdf as { bytesBase64: string }).bytesBase64, 'base64').toString()).toBe(
      '%PDF-1.4',
    );
  });

  it('include / exclude and a .brainignore in the tree narrow the walk the brain’s way', async () => {
    const c = new FsAgentConnector();
    await writeFile(join(root, 'docs', '.brainignore'), 'plan.md\n');
    const x = ctx(connection({ config: { root, include: ['docs/**'], maxFileBytes: 4000 } }));
    expect(ids(await walk(c, x))).toEqual(['docs/bin.md']);
    const y = ctx(connection({ config: { root, exclude: ['docs/'], maxFileBytes: 4000 } }));
    expect(ids(await walk(c, y))).toEqual(['README.md']);
    await rm(join(root, 'docs', '.brainignore'), { force: true });
  });

  it('BRAIN_AGENT_ROOTS fences the root when set', async () => {
    const fenced = new FsAgentConnector([join(base, 'outside')]);
    await expect(walk(fenced, ctx(connection({ config: { root } })))).rejects.toThrow(
      'outside BRAIN_AGENT_ROOTS',
    );
    const open = new FsAgentConnector([base]);
    expect(ids(await walk(open, ctx(connection({ config: { root } }))))).toHaveLength(4);
    expect(() => containedPath('/r', '../x')).toThrow('escapes');
  });
});

describe('GitAgentConnector', () => {
  let repo = '';
  let hasGit = true;
  beforeAll(async () => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
    } catch {
      hasGit = false;
      return;
    }
    repo = await mkdtemp(join(tmpdir(), 'brain-agent-git-'));
    const g = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], {
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'a',
          GIT_AUTHOR_EMAIL: 'a@x',
          GIT_COMMITTER_NAME: 'a',
          GIT_COMMITTER_EMAIL: 'a@x',
          GIT_AUTHOR_DATE: '2026-03-01T10:00:00Z',
          GIT_COMMITTER_DATE: '2026-03-01T10:00:00Z',
        },
      });
    g('init', '-q', '-b', 'main');
    await mkdir(join(repo, 'docs', 'adr'), { recursive: true });
    await writeFile(join(repo, 'README.md'), '# Repo\nAcme was founded in 2019.');
    await writeFile(join(repo, 'docs', 'adr', '0001-surreal.md'), 'We chose SurrealDB.');
    await writeFile(join(repo, 'index.ts'), 'code');
    await writeFile(join(repo, 'untracked.md'), 'not committed');
    g('add', 'README.md', 'docs', 'index.ts');
    g('commit', '-q', '-m', 'init');
    g('remote', 'add', 'origin', 'https://user:pw@github.com/acme/repo.git');
  });
  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it('lists committed docs with blob shas and reads the exact blob', async () => {
    if (!hasGit) return;
    const c = new GitAgentConnector();
    const x = ctx(connection({ connector: 'git', config: { repo } }));
    const deltas = await walk(c, x);
    expect(ids(deltas)).toEqual(['README.md', 'docs/adr/0001-surreal.md']);
    const readme = deltas.find(
      (d) => d.type === 'upsert' && d.item.externalId === 'README.md',
    ) as Extract<ItemDelta, { type: 'upsert' }>;
    expect(readme.item.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(readme.item.originUri).toBe('https://github.com/acme/repo#README.md');
    expect(deltas.at(-1)).toMatchObject({ type: 'checkpoint', checkpoint: { files: 2 } });
    const doc = await c.fetch(x, { externalId: 'README.md', revision: readme.item.revision ?? '' });
    expect(doc).toMatchObject({
      shape: 'document',
      text: '# Repo\nAcme was founded in 2019.',
      title: 'README.md',
      kind: 'repo_doc',
      occurredAt: '2026-03-01T10:00:00.000Z',
    });
    await expect(c.fetch(x, { externalId: 'README.md' })).rejects.toThrow('no blob sha');
    // include narrows by prefix.
    const narrowed = ctx(connection({ connector: 'git', config: { repo, include: ['docs/'] } }));
    expect(ids(await walk(c, narrowed))).toEqual(['docs/adr/0001-surreal.md']);
  });

  it('include takes prefixes and globs', () => {
    const m = (p: string, path: string) => includeMatcher(p)(path);
    expect(m('docs/', 'docs/a.md')).toBe(true);
    expect(m('docs/', 'src/docs/a.md')).toBe(false);
    expect(m('docs/**', 'docs/roadmap/x.md')).toBe(true);
    expect(m('docs/**', 'doc/x.md')).toBe(false);
    expect(m('*.md', 'README.md')).toBe(true);
    expect(m('*.md', 'docs/a.md')).toBe(true); // a bare name pattern matches at any depth (gitignore's rule)
    expect(m('/*.md', 'docs/a.md')).toBe(false); // anchored: the root only
    expect(m('adr/????-*.md', 'adr/0001-surreal.md')).toBe(true);
    expect(m('a.b/**', 'aXb/c')).toBe(false);
  });

  it('normalises remotes without leaking credentials', () => {
    expect(normaliseRemote('git@github.com:acme/repo.git')).toBe('git://github.com/acme/repo');
    expect(normaliseRemote('https://user:pw@gitlab.example/g/r.git')).toBe(
      'https://gitlab.example/g/r',
    );
    expect(normaliseRemote('ssh://git@host:2222/x/y.git')).toBe('ssh://host:2222/x/y');
  });
});

/** An in-memory brain speaking the protocol, and the connector it drives. */
class FakeBrain {
  calls: string[] = [];
  changed = new Set<string>();
  finished: unknown = null;
  items = new Map<string, FetchedItem>();
  begun = {
    full: true,
    checkpoint: null as Record<string, unknown> | null,
    contentPolicy: 'text' as 'text' | 'manifest' | 'bytes',
    fetchBudget: null as number | null,
  };
  client(): BrainAgentClient {
    return new BrainAgentClient({
      baseUrl: 'http://brain.test',
      apiKey: 'k',
      fetch: async (url, init) => {
        this.calls.push(`${init.method} ${url.replace('http://brain.test', '')}`);
        const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        const json = (v: unknown, status = 201) =>
          new Response(JSON.stringify(v), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        if (url.endsWith('/agent-runs')) return json({ runId: 'run-1', ...this.begun });
        if (url.endsWith('/deltas')) {
          const ds = body.deltas as ItemDelta[];
          const fetch = ds
            .filter(
              (d): d is Extract<ItemDelta, { type: 'upsert' }> =>
                d.type === 'upsert' && this.changed.has(d.item.externalId),
            )
            .map((d) => d.item.externalId);
          return json({
            fetch,
            seen: ds.length,
            new: 0,
            changed: fetch.length,
            unchanged: 0,
            gone: 0,
          });
        }
        if (url.endsWith('/items')) {
          this.items.set(body.externalId as string, body.item as FetchedItem);
          return json({ status: 'ingested' });
        }
        if (url.endsWith('/finish')) {
          this.finished = body;
          return json({
            connectionId: 'source_connection:a1',
            mode: 'full',
            status: body.status,
            seen: 0,
            new: 0,
            changed: 0,
            unchanged: 0,
            gone: 0,
            fetched: this.items.size,
            ingested: this.items.size,
            deduplicated: 0,
            failed: 0,
            closed: 0,
            durationMs: 1,
            ...(body.error ? { error: body.error } : {}),
          });
        }
        return json({ message: 'nope' }, 404);
      },
    });
  }
}

class MemoryConnector implements AgentConnector {
  readonly kind = 'fs';
  ended = 0;
  constructor(
    private readonly docs: Record<string, string>,
    private readonly failOn: string[] = [],
  ) {}
  async *enumerate(
    _ctx: ConnectorCtx,
    _opts: { checkpoint: Record<string, unknown> | null; full: boolean },
  ): AsyncIterable<ItemDelta> {
    for (const id of Object.keys(this.docs))
      yield { type: 'upsert', item: { externalId: id, revision: 'r1' } };
    yield { type: 'checkpoint', checkpoint: { files: Object.keys(this.docs).length } };
  }
  /** The descriptors fetch was called with — the runner must hand back what enumerate said. */
  fetched: ItemDescriptor[] = [];
  async fetch(_ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    this.fetched.push(item);
    if (this.failOn.includes(item.externalId)) throw new Error('unreadable');
    return { shape: 'document', text: this.docs[item.externalId]!, title: item.externalId };
  }
  async endRun(): Promise<void> {
    this.ended++;
  }
}

describe('runConnection', () => {
  const target = { connection: connection(), source: null };

  it('batches deltas, fetches only what the brain named, redacts, finishes with the checkpoint, ends the run', async () => {
    const brain = new FakeBrain();
    brain.changed.add('a.md').add('c.md');
    const docs = {
      'a.md': 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD here',
      'b.md': 'b',
      'c.md': 'c',
      'd.md': 'd',
    };
    const connector = new MemoryConnector(docs, ['c.md']);
    const summary = await runConnection(brain.client(), connector, target, {
      agentId: 'laptop',
      batchSize: 2,
    });
    expect(summary.status).toBe('succeeded');
    // 4 upserts + 1 checkpoint in batches of 2 ⇒ 3 delta calls.
    expect(brain.calls.filter((c) => c.endsWith('/deltas'))).toHaveLength(3);
    expect([...brain.items.keys()]).toEqual(['a.md']); // c.md failed locally — never posted
    expect((brain.items.get('a.md') as { text: string }).text).toBe(
      'token [redacted:github_token] here',
    );
    expect(brain.finished).toEqual({ status: 'succeeded', checkpoint: { files: 4 } });
    expect(connector.ended).toBe(1);
    // Fetch gets the enumerated descriptor, not a bare id — git reads by
    // the blob sha the descriptor carries as its revision.
    expect(connector.fetched.map((d) => d.revision)).toEqual(['r1', 'r1']);
  });

  it('a manifest policy posts nothing; --no-redact sends the text as read; a walk failure finishes the run as failed', async () => {
    const brain = new FakeBrain();
    brain.begun = { ...brain.begun, contentPolicy: 'manifest' };
    brain.changed.add('a.md');
    await runConnection(brain.client(), new MemoryConnector({ 'a.md': 'x' }), target, {
      agentId: 'laptop',
    });
    expect(brain.items.size).toBe(0);

    const raw = new FakeBrain();
    raw.changed.add('a.md');
    await runConnection(
      raw.client(),
      new MemoryConnector({ 'a.md': 'password: hunter2hunter2' }),
      target,
      { agentId: 'laptop', redact: false },
    );
    expect((raw.items.get('a.md') as { text: string }).text).toBe('password: hunter2hunter2');

    const broken = new FakeBrain();
    const boom: AgentConnector = {
      kind: 'fs',
      async *enumerate() {
        throw new Error('disk unplugged');
      },
      fetch: () => Promise.reject(new Error('never')),
    };
    const failed = await runConnection(broken.client(), boom, target, { agentId: 'laptop' });
    expect(failed.status).toBe('failed');
    expect(broken.finished).toEqual({ status: 'failed', error: 'disk unplugged' });
  });

  it('connectorFor maps by pack entry and refuses what the agent cannot run', () => {
    const registry: AgentConnector[] = [
      new MemoryConnector({}),
      {
        kind: 'git',
        enumerate: async function* () {},
        fetch: () => Promise.reject(new Error('x')),
      },
    ];
    expect(connectorFor(registry, { connection: connection(), source: null }).kind).toBe('fs');
    expect(
      connectorFor(registry, { connection: connection({ connector: 'git' }), source: null }).kind,
    ).toBe('git');
    expect(() =>
      connectorFor(registry, {
        connection: connection({ kind: 'mcp', connector: 'mcp' }),
        source: { id: 's', kind: 'mcp', shape: 'document', transport: 'http' },
      }),
    ).toThrow('runs on the brain');
    expect(() =>
      connectorFor(registry, {
        connection: connection({ kind: 'external', connector: 'external' }),
        source: null,
      }),
    ).toThrow('pushed by its publisher');
    expect(() =>
      connectorFor(registry, { connection: connection({ connector: 's3' }), source: null }),
    ).toThrow('no "s3" connector');
  });

  it('the protocol client surfaces the brain’s message on errors', async () => {
    const client = new BrainAgentClient({
      baseUrl: 'http://brain.test/',
      apiKey: 'k',
      fetch: async () =>
        new Response(
          JSON.stringify({
            message: 'a run of this connection is already in progress',
            statusCode: 409,
          }),
          { status: 409 },
        ),
    });
    await expect(client.begin('source_connection:a1', { agentId: 'x' })).rejects.toThrow(
      BrainApiError,
    );
    await expect(client.begin('source_connection:a1', { agentId: 'x' })).rejects.toThrow(
      '409: a run of this connection is already in progress',
    );
  });
});
