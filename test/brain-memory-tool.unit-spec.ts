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
      // brain's directory semantics: the path itself and what is inside it.
      const prefix = String(body.prefix ?? '').replace(/\/$/, '');
      const paths = [...files.keys()]
        .filter((p) => p === prefix || p.startsWith(`${prefix}/`))
        .sort();
      return ok({ paths, files: paths.map((p) => ({ path: p, size: files.get(p)!.length })) });
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
  it('creates a file and reads it back in the reference format', async () => {
    const stub = stubBrain();
    const m = memory(stub);
    expect(
      await m.handle({ command: 'create', path: '/memories/a.md', file_text: 'one\ntwo' }),
    ).toBe('File created successfully at: /memories/a.md');
    // `insert` addresses lines by the numbers `view` printed, so the
    // numbering is contract, not decoration: 6 wide, right-aligned, a tab.
    expect(await m.handle({ command: 'view', path: '/memories/a.md' })).toBe(
      "Here's the content of /memories/a.md with line numbers:\n     1\tone\n     2\ttwo",
    );
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
    it('lists a directory with sizes, two levels deep', async () => {
      const stub = stubBrain({
        '/memories/p/a.md': 'a',
        '/memories/p/b.md': 'bb',
        '/memories/p/x/y/deep.md': 'z',
      });
      expect(await memory(stub).handle({ command: 'view', path: '/memories/p' })).toBe(
        [
          "Here're the files and directories up to 2 levels deep in /memories/p, excluding hidden items and node_modules:",
          '4\t/memories/p',
          '1\t/memories/p/a.md',
          '2\t/memories/p/b.md',
        ].join('\n'),
      );
    });

    it('shows an empty root as an empty directory, not a missing file', async () => {
      const stub = stubBrain();
      expect(await memory(stub).handle({ command: 'view', path: '/memories' })).toBe(
        "Here're the files and directories up to 2 levels deep in /memories, excluding hidden items and node_modules:\n0\t/memories",
      );
    });

    it('reads a file whose name a sibling directory extends', async () => {
      const stub = stubBrain({ '/memories/notes': 'mine', '/memories/notes2/x.md': 'other' });
      expect(await memory(stub).handle({ command: 'view', path: '/memories/notes' })).toContain(
        '     1\tmine',
      );
    });

    it('honours view_range, including -1 for "to the end"', async () => {
      const stub = stubBrain({ '/memories/a.md': 'one\ntwo\nthree\nfour' });
      const m = memory(stub);
      expect(
        await m.handle({ command: 'view', path: '/memories/a.md', view_range: [2, 3] }),
      ).toContain('     2\ttwo\n     3\tthree');
      expect(
        await m.handle({ command: 'view', path: '/memories/a.md', view_range: [3, -1] }),
      ).toContain('     3\tthree\n     4\tfour');
    });

    it('a missing path is the reference error, flagged as one', async () => {
      const r = await memory(stubBrain()).run({ command: 'view', path: '/memories/missing.md' });
      expect(r).toEqual({
        content: 'The path /memories/missing.md does not exist. Please provide a valid path.',
        is_error: true,
      });
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
      expect(out).toBe('The memory file has been edited.');
      expect(stub.files.get('/memories/a.md')).toBe('likes spaces\ndislikes spaces');
    });

    it('writes a replacement holding $ patterns verbatim', async () => {
      // String.replace would read `$&` as "the match" and `$$` as "$".
      const stub = stubBrain({ '/memories/a.md': 'price: TBD' });
      await memory(stub).handle({
        command: 'str_replace',
        path: '/memories/a.md',
        old_str: 'TBD',
        new_str: '$$5 ($& off)',
      });
      expect(stub.files.get('/memories/a.md')).toBe('price: $$5 ($& off)');
    });

    it('deletes old_str when new_str is omitted', async () => {
      const stub = stubBrain({ '/memories/a.md': 'keep drop' });
      await memory(stub).handle({
        command: 'str_replace',
        path: '/memories/a.md',
        old_str: ' drop',
      });
      expect(stub.files.get('/memories/a.md')).toBe('keep');
    });

    it('refuses an ambiguous edit, naming the lines', async () => {
      // Guessing here silently corrupts the model's notes; refusing lets
      // it disambiguate, which it can.
      const stub = stubBrain({ '/memories/a.md': 'todo\ntodo' });
      const r = await memory(stub).run({
        command: 'str_replace',
        path: '/memories/a.md',
        old_str: 'todo',
        new_str: 'done',
      });
      expect(r.is_error).toBe(true);
      expect(r.content).toBe(
        'No replacement was performed. Multiple occurrences of old_str `todo` in lines: 1, 2. Please ensure it is unique',
      );
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
      expect(out).toBe(
        'No replacement was performed, old_str `goodbye` did not appear verbatim in /memories/a.md.',
      );
      expect(stub.files.get('/memories/a.md')).toBe('hello');
    });
  });

  describe('insert', () => {
    it('inserts at a line, 0 meaning the top', async () => {
      const stub = stubBrain({ '/memories/a.md': 'one\nthree' });
      const m = memory(stub);
      expect(
        await m.handle({
          command: 'insert',
          path: '/memories/a.md',
          insert_line: 1,
          insert_text: 'two\n',
        }),
      ).toBe('The file /memories/a.md has been edited.');
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
      expect(out).toBe(
        'Error: Invalid `insert_line` parameter: 9. It should be within the range of lines of the file: [0, 1]',
      );
      expect(stub.files.get('/memories/a.md')).toBe('one');
    });
  });

  describe('delete and rename', () => {
    it('deletes and renames', async () => {
      const stub = stubBrain({ '/memories/a.md': 'x', '/memories/b.md': 'y' });
      const m = memory(stub);
      expect(await m.handle({ command: 'delete', path: '/memories/a.md' })).toBe(
        'Successfully deleted /memories/a.md',
      );
      expect(stub.files.has('/memories/a.md')).toBe(false);
      expect(
        await m.handle({
          command: 'rename',
          old_path: '/memories/b.md',
          new_path: '/memories/c.md',
        }),
      ).toBe('Successfully renamed /memories/b.md to /memories/c.md');
      expect(stub.files.get('/memories/c.md')).toBe('y');
    });

    it('never renames onto an existing file', async () => {
      const stub = stubBrain({ '/memories/a.md': 'x', '/memories/b.md': 'y' });
      const r = await memory(stub).run({
        command: 'rename',
        old_path: '/memories/a.md',
        new_path: '/memories/b.md',
      });
      expect(r).toEqual({
        content: 'Error: The destination /memories/b.md already exists',
        is_error: true,
      });
      expect(stub.files.get('/memories/b.md')).toBe('y');
    });

    it('refuses to delete or rename the memory root', async () => {
      const m = memory(stubBrain({ '/memories/a.md': 'x' }));
      expect((await m.run({ command: 'delete', path: '/memories' })).is_error).toBe(true);
      expect(
        (await m.run({ command: 'rename', old_path: '/memories', new_path: '/memories2' }))
          .is_error,
      ).toBe(true);
    });

    it('a missing path is the reference error', async () => {
      const m = memory(stubBrain());
      expect(await m.handle({ command: 'delete', path: '/memories/x.md' })).toBe(
        'Error: The path /memories/x.md does not exist',
      );
    });
  });

  describe('failure', () => {
    it('returns an error rather than throwing into the agent loop', async () => {
      // A thrown error inside a tool dispatch ends the turn. A string the
      // model can read lets it recover.
      const broken = createBrainMemory({
        apiKey: 'brain_test',
        fetch: (async () => ({ ok: false, status: 503, text: async () => 'down' })) as never,
      });
      const r = await broken.run({ command: 'create', path: '/memories/a.md', file_text: 'x' });
      expect(r.is_error).toBe(true);
      expect(r.content).toContain('503');
    });

    it('rejects an unknown command by name', async () => {
      const out = await memory(stubBrain()).handle({ command: 'rm -rf' } as never);
      expect(out).toBe('Error: unknown command rm -rf');
    });

    it('refuses to construct without a key', () => {
      expect(() => createBrainMemory({ apiKey: '' })).toThrow(/apiKey is required/);
    });
  });
});
