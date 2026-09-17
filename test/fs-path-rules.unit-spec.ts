/**
 * Which paths under a root are the source's: include / exclude globs on
 * the connection and gitignore-style ignore files in the tree — the
 * same dialect on the brain and on the agent (the agent's module is a
 * copy; both are driven through one table here).
 */
import { readFileSync } from 'node:fs';
import { PathFilter as ServerFilter, compileRule } from '../src/source-plane/connectors/path-rules';
import { PathFilter as AgentFilter } from '../clients/brain-agent/src/connectors/path-rules';

type FilterLike = new (rules: {
  include?: string[] | undefined;
  exclude?: string[] | undefined;
}) => {
  addIgnoreFile(base: string, text: string): void;
  admitsDir(path: string): boolean;
  admitsFile(path: string): boolean;
};
const IMPLS: Array<[string, FilterLike]> = [
  ['server', ServerFilter],
  ['agent', AgentFilter],
];

describe('path rules', () => {
  it('the agent carries a byte-for-byte copy of the brain module', () => {
    expect(readFileSync('clients/brain-agent/src/connectors/path-rules.ts', 'utf8')).toBe(
      readFileSync('src/source-plane/connectors/path-rules.ts', 'utf8'),
    );
  });

  it('compiles the gitignore dialect', () => {
    expect(compileRule('')).toBeNull();
    expect(compileRule('# comment')).toBeNull();
    expect(compileRule('*.log')).toMatchObject({
      byName: true,
      dirOnly: false,
      negate: false,
      prefix: '',
    });
    expect(compileRule('docs/**')).toMatchObject({ byName: false, prefix: 'docs/' });
    expect(compileRule('/docs/archive/')).toMatchObject({
      byName: false,
      dirOnly: true,
      prefix: 'docs/archive/',
    });
    expect(compileRule('docs/*/readme.md')).toMatchObject({ prefix: 'docs/' });
    expect(compileRule('docs/a*/x')).toMatchObject({ prefix: 'docs/' });
    expect(compileRule('!keep.md')).toMatchObject({ negate: true, byName: true });
    expect(compileRule('build/', 'sub/dir')).toMatchObject({ byName: true, dirOnly: true }); // a name, at any depth beneath
    expect(compileRule('/build/', 'sub/dir')!.re.test('sub/dir/build')).toBe(true); // anchored to the file's directory
    expect(compileRule('/README.md')).toMatchObject({ byName: false, prefix: 'README.md/' });
    expect(compileRule('**/*.md')!.re.test('a.md')).toBe(true);
    expect(compileRule('**/*.md')!.re.test('x/y/a.md')).toBe(true);
    expect(compileRule('docs/*/readme.md')!.re.test('docs/a/readme.md')).toBe(true);
    expect(compileRule('docs/*/readme.md')!.re.test('docs/a/b/readme.md')).toBe(false);
    expect(compileRule('a.b')!.re.test('aXb')).toBe(false);
  });

  describe.each(IMPLS)('%s filter', (_name, Filter) => {
    it('no rules: everything is admitted', () => {
      const f = new Filter({});
      expect(f.admitsDir('any/where')).toBe(true);
      expect(f.admitsFile('any/where/x.md')).toBe(true);
    });

    it('include: only what matches, directories entered only where a match can live', () => {
      const f = new Filter({ include: ['docs/**', '/README.md', 'notes/2026'] });
      expect(f.admitsDir('docs')).toBe(true);
      expect(f.admitsDir('docs/deep')).toBe(true);
      expect(f.admitsDir('notes')).toBe(true); // on the way to notes/2026
      expect(f.admitsDir('notes/2025')).toBe(false);
      expect(f.admitsDir('src')).toBe(false); // nothing included can live there
      expect(f.admitsFile('docs/a.md')).toBe(true);
      expect(f.admitsFile('README.md')).toBe(true);
      expect(f.admitsFile('src/README.md')).toBe(false); // anchored: the root's only
      expect(f.admitsFile('notes/2026/w1.md')).toBe(true); // beneath an included literal path
      expect(f.admitsFile('src/a.md')).toBe(false);
      expect(f.admitsFile('CHANGELOG.md')).toBe(false);
      // A name pattern can match at any depth, so the walk goes everywhere.
      const named = new Filter({ include: ['adr'] });
      expect(named.admitsDir('src')).toBe(true);
      expect(named.admitsFile('x/adr/0001.md')).toBe(true);
      expect(named.admitsFile('x/other/0001.md')).toBe(false);
      const byName = new Filter({ include: ['*.md'] });
      expect(byName.admitsDir('anything/at/all')).toBe(true); // a name pattern can match anywhere
      expect(byName.admitsFile('deep/a.md')).toBe(true);
      expect(byName.admitsFile('deep/a.txt')).toBe(false);
      const dirOnly = new Filter({ include: ['notes/'] });
      expect(dirOnly.admitsFile('notes/a.md')).toBe(true);
      expect(dirOnly.admitsFile('other/a.md')).toBe(false);
    });

    it('exclude: prunes directories and drops files, by name or by path', () => {
      const f = new Filter({ exclude: ['*.log', 'docs/archive', 'tmp/', 'secret?.md'] });
      expect(f.admitsDir('docs/archive')).toBe(false);
      expect(f.admitsDir('docs/current')).toBe(true);
      expect(f.admitsDir('x/tmp')).toBe(false);
      expect(f.admitsFile('x/tmp')).toBe(true); // tmp/ is directories only
      expect(f.admitsFile('a/b/run.log')).toBe(false);
      expect(f.admitsFile('secret1.md')).toBe(false);
      expect(f.admitsFile('secret12.md')).toBe(true);
    });

    it('ignore files: root and nested, relative to their directory, last match wins with negation', () => {
      const f = new Filter({});
      f.addIgnoreFile('', '# top\n*.tmp\ndrafts/\n!keep.tmp\n');
      f.addIgnoreFile('team/alice', 'private/**\n*.pdf\n');
      expect(f.admitsFile('a.tmp')).toBe(false);
      expect(f.admitsFile('deep/keep.tmp')).toBe(true); // re-admitted by the later line
      expect(f.admitsDir('drafts')).toBe(false);
      expect(f.admitsDir('x/drafts')).toBe(false);
      expect(f.admitsFile('team/alice/private/x.md')).toBe(false);
      expect(f.admitsFile('team/alice/x.pdf')).toBe(false);
      expect(f.admitsFile('team/bob/x.pdf')).toBe(true); // alice's file does not reach bob
      expect(f.admitsFile('team/bob/private/x.md')).toBe(true);
    });

    it('include and ignore compose: an ignored path is out even when included', () => {
      const f = new Filter({ include: ['docs/**'] });
      f.addIgnoreFile('docs', 'wip/\n');
      expect(f.admitsDir('docs/wip')).toBe(false);
      expect(f.admitsFile('docs/final.md')).toBe(true);
    });
  });
});
