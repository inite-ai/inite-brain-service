/**
 * The Anthropic memory-tool adapter.
 *
 * `str_replace` and `insert` are string operations the adapter performs
 * against the text brain returns — they are not routes, because brain
 * owning a merge policy would be brain guessing at the model's intent.
 * That makes this file the only place those semantics are checked, and
 * getting them wrong corrupts a model's own notes in a way that reads
 * as hallucination.
 */
import { BrainMemory, createBrainMemory } from '../clients/brain-memory-tool/src/index';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
  auth: string | undefined;
}

/** A brain that holds files in a map, so a sequence of edits is testable. */
function stubBrain(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const headers = init.headers as Record<string, string>;
    calls.push({ url, method: String(init.method), body, auth: headers.Authorization });
    const ok = (payload: unknown) => ({
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    });
    const path = String(body.path ?? '');
    if (url.endsWith('/v1/memory-files') && init.method === 'PUT') {
      files.set(path, String(body.content));
      return ok({ path, content: String(body.content), updatedAt: 'now' });
    }
    if (url.endsWith('/read')) {
      if (!files.has(path)) {
        return { ok: false, status: 404, text: async () => 'no such memory file' };
      }
      return ok({ path, content: files.get(path), updatedAt: 'now' });
    }
    if (url.endsWith('/list')) {
      const prefix = String(body.prefix ?? '');
      return ok({ paths: [...files.keys()].filter((p) => p.startsWith(prefix)).sort() });
    }
    if (url.endsWith('/delete')) {
      const existed = files.delete(path);
      return existed
        ? ok({ deleted: 1 })
        : { ok: false, status: 404, text: async () => 'no such memory file' };
    }
    if (url.endsWith('/rename')) {
      const to = String(body.newPath);
      files.set(to, files.get(path) ?? '');
      files.delete(path);
      return ok({ path: to, content: files.get(to), updatedAt: 'now' });
    }
    return { ok: false, status: 404, text: async () => 'unknown route' };
  }) as unknown as typeof globalThis.fetch;
  return { files, calls, fetchImpl };
}

const memory = (stub: ReturnType<typeof stubBrain>, extra: { userId?: string } = {}): BrainMemory =>
  createBrainMemory({ apiKey: 'brain_test', fetch: stub.fetchImpl, ...extra });

describe('brain memory tool adapter', () => {
  it('creates a file and reads it back with line numbers', async () => {
    const stub = stubBrain();
    const m = memory(stub);
    expect(
      await m.handle({ command: 'create', path: '/memories/a.md', file_text: 'one\ntwo' }),
    ).toBe('Created /memories/a.md');
    // `insert` addresses lines by the numbers `view` printed, so the
    // numbering is contract, not decoration.
    expect(await m.handle({ command: 'view', path: '/memories/a.md' })).toBe('1: one\n2: two');
  });

  it('carries the bearer key on every call', async () => {
    const stub = stubBrain({ '/memories/a.md': 'x' });
    await memory(stub).handle({ command: 'view', path: '/memories/a.md' });
    expect(stub.calls.every((c) => c.auth === 'Bearer brain_test')).toBe(true);
  });

  it('fences to a user when one is configured', async () => {
    const stub = stubBrain({ '/memories/a.md': 'x' });
    await memory(stub, { userId: 'user_42' }).handle({ command: 'view', path: '/memories/a.md' });
    expect(stub.calls[0]!.body.userId).toBe('user_42');
  });

  describe('view', () => {
    it('lists a directory when one exists at that path', async () => {
      const stub = stubBrain({ '/memories/p/a.md': 'a', '/memories/p/b.md': 'b' });
      const out = await memory(stub).handle({ command: 'view', path: '/memories/p' });
      expect(out).toContain('Directory: /memories/p');
      expect(out).toContain('- /memories/p/a.md');
      expect(out).toContain('- /memories/p/b.md');
    });

    it('honours view_range, including -1 for "to the end"', async () => {
      const stub = stubBrain({ '/memories/a.md': 'one\ntwo\nthree\nfour' });
      const m = memory(stub);
      expect(await m.handle({ command: 'view', path: '/memories/a.md', view_range: [2, 3] })).toBe(
        '2: two\n3: three',
      );
      expect(await m.handle({ command: 'view', path: '/memories/a.md', view_range: [3, -1] })).toBe(
        '3: three\n4: four',
      );
    });
  });

  describe('str_replace', () => {
    it('edits the one match', async () => {
      const stub = stubBrain({ '/memories/a.md': 'likes tabs\ndislikes spaces' });
      const out = await memory(stub).handle({
        command: 'str_replace',
        path: '/memories/a.md',
        old_str: 'likes tabs',
        new_str: 'likes spaces',
      });
      expect(out).toBe('Edited /memories/a.md');
      expect(stub.files.get('/memories/a.md')).toBe('likes spaces\ndislikes spaces');
    });

    it('refuses an ambiguous edit instead of guessing', async () => {
      // Guessing here silently corrupts the model's notes; refusing lets
      // it disambiguate, which it can.
      const stub = stubBrain({ '/memories/a.md': 'todo\ntodo' });
      const out = await memory(stub).handle({
        command: 'str_replace',
        path: '/memories/a.md',
        old_str: 'todo',
        new_str: 'done',
      });
      expect(out).toContain('Error:');
      expect(out).toContain('found 2 matches');
      expect(stub.files.get('/memories/a.md')).toBe('todo\ntodo');
    });

    it('reports a miss rather than writing nothing silently', async () => {
      const stub = stubBrain({ '/memories/a.md': 'hello' });
      const out = await memory(stub).handle({
        command: 'str_replace',
        path: '/memories/a.md',
        old_str: 'goodbye',
        new_str: 'hi',
      });
      expect(out).toContain('no match');
      expect(stub.files.get('/memories/a.md')).toBe('hello');
    });
  });

  describe('insert', () => {
    it('inserts at a line, 0 meaning the top', async () => {
      const stub = stubBrain({ '/memories/a.md': 'one\nthree' });
      const m = memory(stub);
      await m.handle({
        command: 'insert',
        path: '/memories/a.md',
        insert_line: 1,
        insert_text: 'two',
      });
      expect(stub.files.get('/memories/a.md')).toBe('one\ntwo\nthree');
      await m.handle({
        command: 'insert',
        path: '/memories/a.md',
        insert_line: 0,
        insert_text: 'zero',
      });
      expect(stub.files.get('/memories/a.md')).toBe('zero\none\ntwo\nthree');
    });

    it('refuses a line past the end of the file', async () => {
      const stub = stubBrain({ '/memories/a.md': 'one' });
      const out = await memory(stub).handle({
        command: 'insert',
        path: '/memories/a.md',
        insert_line: 9,
        insert_text: 'x',
      });
      expect(out).toContain('outside /memories/a.md');
      expect(stub.files.get('/memories/a.md')).toBe('one');
    });
  });

  it('deletes and renames', async () => {
    const stub = stubBrain({ '/memories/a.md': 'x', '/memories/b.md': 'y' });
    const m = memory(stub);
    expect(await m.handle({ command: 'delete', path: '/memories/a.md' })).toBe(
      'Deleted /memories/a.md',
    );
    expect(stub.files.has('/memories/a.md')).toBe(false);
    expect(
      await m.handle({ command: 'rename', old_path: '/memories/b.md', new_path: '/memories/c.md' }),
    ).toBe('Renamed /memories/b.md to /memories/c.md');
    expect(stub.files.get('/memories/c.md')).toBe('y');
  });

  describe('failure', () => {
    it('returns an error string rather than throwing into the agent loop', async () => {
      // A thrown error inside a tool dispatch ends the turn. A string the
      // model can read lets it recover, which is what a filesystem
      // backend's ENOENT does too.
      const stub = stubBrain();
      const out = await memory(stub).handle({ command: 'view', path: '/memories/missing.md' });
      expect(out.startsWith('Error:')).toBe(true);
      expect(out).toContain('404');
    });

    it('rejects an unknown command by name', async () => {
      const stub = stubBrain();
      const out = await memory(stub).handle({ command: 'rm -rf' } as never);
      expect(out).toContain('unknown command: rm -rf');
    });

    it('refuses to construct without a key', () => {
      expect(() => createBrainMemory({ apiKey: '' })).toThrow(/apiKey is required/);
    });
  });
});
