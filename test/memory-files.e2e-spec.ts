/**
 * File-shaped memory, against a real database.
 *
 * The path is the identity here, so the path rules ARE the access
 * control: the row fence is (path, userId), and a traversal that reached
 * the query would be a way to name someone else's key. Those cases get
 * as much attention as the happy path.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('POST/PUT /v1/memory-files', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({ companyId: `co_memfiles_${Date.now()}` });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const write = (body: Record<string, unknown>) =>
    f.http.put('/v1/memory-files').set(auth()).send(body);
  const post = (route: string, body: Record<string, unknown>) =>
    f.http.post(`/v1/memory-files/${route}`).set(auth()).send(body);

  it('writes a file and reads back exactly what was written', async () => {
    // Exactness matters more here than anywhere else in brain:
    // str_replace and insert are string operations against this text,
    // so any normalisation would corrupt the model's own notes.
    const content = '# Prefs\n\n- likes:  tabs\t(two)\n- dislikes: "smart" quotes\n\n\n';
    const put = await write({ path: '/memories/prefs.md', content });
    expect(put.status).toBe(200);
    expect(put.body.path).toBe('/memories/prefs.md');

    const read = await post('read', { path: '/memories/prefs.md' });
    expect(read.status).toBe(200);
    expect(read.body.content).toBe(content);
    expect(typeof read.body.updatedAt).toBe('string');
  });

  it('replaces on a second write rather than creating a duplicate', async () => {
    await write({ path: '/memories/notes.md', content: 'first' });
    await write({ path: '/memories/notes.md', content: 'second' });
    const read = await post('read', { path: '/memories/notes.md' });
    expect(read.body.content).toBe('second');
    const list = await post('list', { prefix: '/memories' });
    expect(list.body.paths.filter((p: string) => p === '/memories/notes.md')).toHaveLength(1);
  });

  it('lists a directory in path order', async () => {
    await write({ path: '/memories/projects/b.md', content: 'b' });
    await write({ path: '/memories/projects/a.md', content: 'a' });
    const list = await post('list', { prefix: '/memories/projects' });
    expect(list.status).toBe(200);
    expect(list.body.paths).toEqual(['/memories/projects/a.md', '/memories/projects/b.md']);
  });

  it('renames, and the old path stops existing', async () => {
    await write({ path: '/memories/old.md', content: 'moved' });
    const moved = await post('rename', { path: '/memories/old.md', newPath: '/memories/new.md' });
    expect(moved.status).toBe(200);
    expect(moved.body.path).toBe('/memories/new.md');
    expect(moved.body.content).toBe('moved');
    expect((await post('read', { path: '/memories/old.md' })).status).toBe(404);
    expect((await post('read', { path: '/memories/new.md' })).body.content).toBe('moved');
  });

  it('deletes a directory recursively, and reports how many', async () => {
    await write({ path: '/memories/tmp/one.md', content: '1' });
    await write({ path: '/memories/tmp/two.md', content: '2' });
    const gone = await post('delete', { path: '/memories/tmp' });
    expect(gone.status).toBe(200);
    expect(gone.body.deleted).toBe(2);
    expect((await post('list', { prefix: '/memories/tmp' })).body.paths).toEqual([]);
  });

  it('404s a file that was never written', async () => {
    expect((await post('read', { path: '/memories/nope.md' })).status).toBe(404);
    expect((await post('delete', { path: '/memories/nope.md' })).status).toBe(404);
  });

  describe('the path fence', () => {
    it.each([
      ['/etc/passwd', 'outside the root'],
      ['/memories/../../etc/passwd', 'traversal'],
      ['/memoriesevil.md', 'prefix that only looks like the root'],
      ['/memories//double.md', 'empty segment'],
      ['', 'empty'],
    ])('rejects %s (%s)', async (path) => {
      expect((await write({ path, content: 'x' })).status).toBe(400);
      expect((await post('read', { path })).status).toBe(400);
    });

    it('rejects a rename that escapes on the destination', async () => {
      await write({ path: '/memories/safe.md', content: 'x' });
      const res = await post('rename', { path: '/memories/safe.md', newPath: '/etc/cron' });
      expect(res.status).toBe(400);
      // And the source survived — a rejected move must not be a delete.
      expect((await post('read', { path: '/memories/safe.md' })).body.content).toBe('x');
    });
  });

  describe('the per-user fence', () => {
    it('keeps two users at the same path apart', async () => {
      // One workspace key, two people. The alternative to this fence is
      // one person's notes silently overwriting another's.
      await write({ path: '/memories/me.md', content: 'alice', userId: 'user_alice' });
      await write({ path: '/memories/me.md', content: 'bob', userId: 'user_bob' });

      expect(
        (await post('read', { path: '/memories/me.md', userId: 'user_alice' })).body.content,
      ).toBe('alice');
      expect(
        (await post('read', { path: '/memories/me.md', userId: 'user_bob' })).body.content,
      ).toBe('bob');
    });

    it('does not show a personal file to the workspace-wide scope', async () => {
      await write({ path: '/memories/private.md', content: 'secret', userId: 'user_alice' });
      expect((await post('read', { path: '/memories/private.md' })).status).toBe(404);
      expect((await post('list', { prefix: '/memories' })).body.paths).not.toContain(
        '/memories/private.md',
      );
    });

    it('deletes only the asking user’s copy', async () => {
      await write({ path: '/memories/shared-name.md', content: 'a', userId: 'user_alice' });
      await write({ path: '/memories/shared-name.md', content: 'b', userId: 'user_bob' });
      await post('delete', { path: '/memories/shared-name.md', userId: 'user_alice' });
      expect(
        (await post('read', { path: '/memories/shared-name.md', userId: 'user_bob' })).body.content,
      ).toBe('b');
    });
  });
});
