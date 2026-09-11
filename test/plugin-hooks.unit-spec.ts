/**
 * The lifecycle hooks, end to end against a stub brain.
 *
 * These scripts run on a user's machine, outside any test the service
 * has, and their failure mode is silence by design — so the only way to
 * know they work is to run them: real stdin payloads, a real HTTP
 * round-trip, real transcript JSONL.
 */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOOK = join(__dirname, '../plugins/inite-brain/hooks/brain-hook.sh');

interface Captured {
  path: string;
  body: Record<string, unknown>;
  auth: string | undefined;
}

/** A brain that records what it was asked and answers with `reply`. */
async function stubBrain(
  reply: unknown,
  status = 200,
): Promise<{
  url: string;
  calls: Captured[];
  close: () => Promise<void>;
  server: Server;
}> {
  const calls: Captured[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      calls.push({
        path: req.url ?? '',
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        auth: req.headers.authorization,
      });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function run(
  mode: string,
  stdin: unknown,
  env: Record<string, string>,
): Promise<{ stdout: string }> {
  const child = execFileAsync('sh', [HOOK, mode], {
    env: { ...process.env, ...env },
    timeout: 20_000,
  });
  child.child.stdin?.end(JSON.stringify(stdin));
  return child;
}

const SEARCH_REPLY = {
  results: [
    {
      entityId: 'e1',
      entityType: 'project',
      canonicalName: 'inite-brain-service',
      externalRefs: {},
      score: 0.9,
      facts: [
        {
          factId: 'f1',
          predicate: 'uses',
          object: 'SurrealDB',
          confidence: 1,
          validFrom: 'x',
          status: 'active',
          score: 1,
        },
        {
          factId: 'f2',
          predicate: 'deploys_to',
          object: 'a single droplet',
          confidence: 1,
          validFrom: 'x',
          status: 'active',
          score: 1,
        },
      ],
    },
  ],
};

describe('brain-hook: recall (SessionStart)', () => {
  it('asks brain about the project and returns additionalContext', async () => {
    const brain = await stubBrain(SEARCH_REPLY);
    try {
      const { stdout } = await run(
        'recall',
        { session_id: 's1', cwd: process.cwd(), source: 'startup' },
        { CLAUDE_PLUGIN_OPTION_API_KEY: 'brain_test', CLAUDE_PLUGIN_OPTION_BASE_URL: brain.url },
      );
      expect(brain.calls).toHaveLength(1);
      expect(brain.calls[0]?.path).toBe('/v1/search');
      expect(brain.calls[0]?.auth).toBe('Bearer brain_test');
      const out = JSON.parse(stdout) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(out.hookSpecificOutput.additionalContext).toContain('uses SurrealDB');
    } finally {
      await brain.close();
    }
  });

  it('prints nothing when brain has nothing to say', async () => {
    const brain = await stubBrain({ results: [] });
    try {
      const { stdout } = await run(
        'recall',
        { session_id: 's1', cwd: process.cwd() },
        { CLAUDE_PLUGIN_OPTION_API_KEY: 'brain_test', CLAUDE_PLUGIN_OPTION_BASE_URL: brain.url },
      );
      expect(stdout).toBe('');
    } finally {
      await brain.close();
    }
  });

  it('stays silent and exits 0 when brain is down', async () => {
    // Port 1 is reliably closed; the hook must not turn that into a
    // failed session start.
    const { stdout } = await run(
      'recall',
      { session_id: 's1', cwd: process.cwd() },
      {
        CLAUDE_PLUGIN_OPTION_API_KEY: 'brain_test',
        CLAUDE_PLUGIN_OPTION_BASE_URL: 'http://127.0.0.1:1',
      },
    );
    expect(stdout).toBe('');
  });

  it('does nothing at all without a key', async () => {
    const brain = await stubBrain(SEARCH_REPLY);
    try {
      const { stdout } = await run(
        'recall',
        { session_id: 's1' },
        { CLAUDE_PLUGIN_OPTION_API_KEY: '', CLAUDE_PLUGIN_OPTION_BASE_URL: brain.url },
      );
      expect(stdout).toBe('');
      expect(brain.calls).toHaveLength(0);
    } finally {
      await brain.close();
    }
  });

  it('honours the recall switch', async () => {
    const brain = await stubBrain(SEARCH_REPLY);
    try {
      await run(
        'recall',
        { session_id: 's1', cwd: process.cwd() },
        {
          CLAUDE_PLUGIN_OPTION_API_KEY: 'brain_test',
          CLAUDE_PLUGIN_OPTION_BASE_URL: brain.url,
          CLAUDE_PLUGIN_OPTION_RECALL_ON_START: 'false',
        },
      );
      expect(brain.calls).toHaveLength(0);
    } finally {
      await brain.close();
    }
  });
});

describe('brain-hook: capture (PreCompact / SessionEnd)', () => {
  const transcript = (lines: unknown[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-hook-'));
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
    return path;
  };

  const humanTurn = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });

  it('sends the human turns, not the model output', async () => {
    const brain = await stubBrain({ ok: true });
    const path = transcript([
      humanTurn('Move the retry loop out of the request path and cap it at three attempts.'),
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I refactored it into a helper.' }],
        },
      },
      humanTurn('Also make the timeout configurable per tenant, default 30 seconds.'),
    ]);
    try {
      await run(
        'capture',
        { session_id: 'cap1', transcript_path: path, cwd: process.cwd(), trigger: 'auto' },
        {
          CLAUDE_PLUGIN_OPTION_API_KEY: 'brain_test',
          CLAUDE_PLUGIN_OPTION_BASE_URL: brain.url,
          CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'brain-data-')),
        },
      );
      expect(brain.calls).toHaveLength(1);
      expect(brain.calls[0]?.path).toBe('/v1/ingest/mention');
      const body = brain.calls[0]?.body as { text: string; contextRef: { recorder: string } };
      expect(body.text).toContain('cap it at three attempts');
      expect(body.text).toContain('configurable per tenant');
      expect(body.text).not.toContain('I refactored it into a helper');
      expect(body.contextRef.recorder).toBe('claude-code');
    } finally {
      await brain.close();
    }
  });

  it('sends each turn once across PreCompact and SessionEnd', async () => {
    const brain = await stubBrain({ ok: true });
    const dataDir = mkdtempSync(join(tmpdir(), 'brain-data-'));
    const first = [humanTurn('Rename the column and backfill it in a single migration, please.')];
    const path = transcript(first);
    const env = {
      CLAUDE_PLUGIN_OPTION_API_KEY: 'brain_test',
      CLAUDE_PLUGIN_OPTION_BASE_URL: brain.url,
      CLAUDE_PLUGIN_DATA: dataDir,
    };
    try {
      const payload = { session_id: 'cap2', transcript_path: path, cwd: process.cwd() };
      await run('capture', payload, env);
      // Same transcript, second hook: the watermark must suppress it.
      await run('capture', payload, env);
      expect(brain.calls).toHaveLength(1);

      // A new turn arrives before session end — that one does go.
      writeFileSync(
        path,
        [...first, humanTurn('Now add an index on the new column, it is in every WHERE clause.')]
          .map((l) => JSON.stringify(l))
          .join('\n'),
      );
      await run('capture', payload, env);
      expect(brain.calls).toHaveLength(2);
      const body = brain.calls[1]?.body as { text: string };
      expect(body.text).toContain('add an index');
      expect(body.text).not.toContain('Rename the column');
    } finally {
      await brain.close();
    }
  });

  it('retries next time when the write failed', async () => {
    const down = await stubBrain({ error: 'nope' }, 503);
    const dataDir = mkdtempSync(join(tmpdir(), 'brain-data-'));
    const path = transcript([
      humanTurn('Split the deploy workflow so the image is built once and reused.'),
    ]);
    const payload = { session_id: 'cap3', transcript_path: path, cwd: process.cwd() };
    try {
      await run('capture', payload, {
        CLAUDE_PLUGIN_OPTION_API_KEY: 'brain_test',
        CLAUDE_PLUGIN_OPTION_BASE_URL: down.url,
        CLAUDE_PLUGIN_DATA: dataDir,
      });
      expect(down.calls).toHaveLength(1);
    } finally {
      await down.close();
    }
    // Watermark must NOT have advanced past a rejected write.
    const up = await stubBrain({ ok: true });
    try {
      await run('capture', payload, {
        CLAUDE_PLUGIN_OPTION_API_KEY: 'brain_test',
        CLAUDE_PLUGIN_OPTION_BASE_URL: up.url,
        CLAUDE_PLUGIN_DATA: dataDir,
      });
      expect(up.calls).toHaveLength(1);
      expect((up.calls[0]?.body as { text: string }).text).toContain('Split the deploy workflow');
    } finally {
      await up.close();
    }
  });

  it('ignores a session too short to be worth remembering', async () => {
    const brain = await stubBrain({ ok: true });
    const path = transcript([humanTurn('hi')]);
    try {
      await run(
        'capture',
        { session_id: 'cap4', transcript_path: path, cwd: process.cwd() },
        {
          CLAUDE_PLUGIN_OPTION_API_KEY: 'brain_test',
          CLAUDE_PLUGIN_OPTION_BASE_URL: brain.url,
          CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'brain-data-')),
        },
      );
      expect(brain.calls).toHaveLength(0);
    } finally {
      await brain.close();
    }
  });

  it('honours the capture switch', async () => {
    const brain = await stubBrain({ ok: true });
    const path = transcript([
      humanTurn('Cache the embedder warm-up so the first request is not slow.'),
    ]);
    try {
      await run(
        'capture',
        { session_id: 'cap5', transcript_path: path, cwd: process.cwd() },
        {
          CLAUDE_PLUGIN_OPTION_API_KEY: 'brain_test',
          CLAUDE_PLUGIN_OPTION_BASE_URL: brain.url,
          CLAUDE_PLUGIN_OPTION_CAPTURE_SESSIONS: 'false',
          CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'brain-data-')),
        },
      );
      expect(brain.calls).toHaveLength(0);
    } finally {
      await brain.close();
    }
  });
});
