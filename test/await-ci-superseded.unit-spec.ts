import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * The deploy refuses to ship a commit whose CI is not green, and that
 * refusal must stay absolute. There is exactly one exception, and this
 * pins its shape.
 *
 * GitHub keeps at most ONE pending run per concurrency group, so when two
 * merges land within a few minutes the first commit's CI is cancelled
 * while still queued. Its deploy then reported a hard failure although the
 * code was neither red nor unshipped: the newer commit contains it and
 * deploys itself. Standing down quietly is right ONLY when the commit is
 * no longer the tip of the branch — a cancelled CI on the tip is still a
 * refusal, and so is an unreadable tip.
 */

const SCRIPT = join(__dirname, '..', 'scripts', 'ci', 'await-ci.mjs');
const SHA = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);

type Case = { conclusion: string; tip: string | null; tipStatus?: number };

/** Serve the two endpoints the script reads, then run it. Returns its exit code. */
async function runAwait(c: Case): Promise<{ code: number; out: string }> {
  const server: Server = createServer((req, res) => {
    if (req.url?.includes('/actions/workflows/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          workflow_runs: [
            {
              id: 1,
              event: 'push',
              status: 'completed',
              conclusion: c.conclusion,
              created_at: '2026-09-10T20:00:00Z',
              html_url: 'https://example.invalid/run/1',
            },
          ],
        }),
      );
      return;
    }
    if (req.url?.includes('/commits/')) {
      if (c.tipStatus && c.tipStatus !== 200) {
        res.writeHead(c.tipStatus).end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sha: c.tip }));
      return;
    }
    res.writeHead(404).end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    // spawn, never spawnSync: the script fetches from the server running in
    // THIS process, and a synchronous child would block the event loop that
    // has to answer it.
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'acme/brain',
        GITHUB_TOKEN: 'test-token',
        AWAIT_SHA: SHA,
        AWAIT_API_BASE: `http://127.0.0.1:${port}`,
        AWAIT_TIMEOUT_MINUTES: '1',
        AWAIT_POLL_SECONDS: '1',
        GITHUB_OUTPUT: '',
      },
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr.on('data', (b: Buffer) => (out += b.toString()));
    const code = await new Promise<number>((resolve) => {
      child.on('close', (c) => resolve(c ?? -1));
    });
    return { code, out };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('await-ci: a superseded commit stands down, everything else refuses', () => {
  it('passes a green CI', async () => {
    const { code } = await runAwait({ conclusion: 'success', tip: SHA });
    expect(code).toBe(0);
  });

  it('stands down when CI was cancelled and a newer commit owns the branch', async () => {
    const { code, out } = await runAwait({ conclusion: 'cancelled', tip: NEWER });
    expect(code).toBe(0);
    expect(out).toContain('Superseded');
  });

  it('still refuses when CI was cancelled on the tip commit', async () => {
    const { code, out } = await runAwait({ conclusion: 'cancelled', tip: SHA });
    expect(code).toBe(1);
    expect(out).toContain('Not deploying');
  });

  it('still refuses when the branch tip cannot be read', async () => {
    const { code } = await runAwait({ conclusion: 'cancelled', tip: null, tipStatus: 500 });
    expect(code).toBe(1);
  });

  it('never stands down for a red CI, tip or not', async () => {
    expect((await runAwait({ conclusion: 'failure', tip: NEWER })).code).toBe(1);
    expect((await runAwait({ conclusion: 'failure', tip: SHA })).code).toBe(1);
  });
});
