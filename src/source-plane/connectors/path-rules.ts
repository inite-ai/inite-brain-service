/**
 * Which paths under a root are the source's — the rules an operator sets
 * on the connection (`include` / `exclude` globs) and the ones the
 * machine's owner leaves in the tree (`.brainignore`, gitignore-style),
 * compiled once per walk and asked twice per entry: may this directory
 * be entered, is this file an item.
 *
 * Glob dialect (gitignore's, the one people already know):
 *   - `*` within a path segment, `**` across segments, `?` one character;
 *   - a pattern with no `/` matches the entry NAME at any depth
 *     (`*.log`, `archive`); one with a `/` matches the path relative to
 *     the root, or to the directory of the ignore file that holds it
 *     (`docs/**`, `notes/2019/`); a leading `/` anchors it there — also
 *     a bare name (`/README.md` is the root's README only);
 *   - a trailing `/` matches directories only;
 *   - in an ignore file: `#` comments, blank lines, `!pattern` re-admits
 *     what an earlier line excluded (last match wins).
 *
 * Pure: no I/O, no env. The agent carries a byte-for-byte copy
 * (clients/brain-agent/src/connectors/path-rules.ts) so both hosts walk
 * a folder the same way; test/fs-path-rules.unit-spec.ts pins them equal.
 */

export interface CompiledRule {
  re: RegExp;
  /** Matches the entry name (no `/` in the pattern) rather than the path. */
  byName: boolean;
  dirOnly: boolean;
  negate: boolean;
  /** Static leading path (before any wildcard) — where an include could match; '' = anywhere. */
  prefix: string;
}

const RE_SPECIAL = /[.+^${}()|[\]\\]/g;

/** One pattern → one rule; `base` is the directory (relative to the root) a nested ignore file lives in. */
export function compileRule(raw: string, base = ''): CompiledRule | null {
  let pattern = raw.trim();
  if (pattern.length === 0 || pattern.startsWith('#')) return null;
  let negate = false;
  if (pattern.startsWith('!')) {
    negate = true;
    pattern = pattern.slice(1);
  }
  let dirOnly = false;
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  // A leading `/` anchors the pattern to its directory even when it is
  // a bare name (`/README.md` = the root's README, not every README).
  const anchored = pattern.startsWith('/');
  if (anchored) pattern = pattern.slice(1);
  if (pattern.length === 0) return null;
  const byName = !anchored && !pattern.includes('/');
  const full = byName || base === '' ? pattern : `${base}/${pattern}`;
  // A leading `**/` means "at any depth, the root included" — the
  // slash it carries must not demand a directory above.
  const anywhere = full.startsWith('**/');
  const tail = anywhere ? full.slice(3) : full;
  const body =
    (anywhere ? '(?:.*/)?' : '') +
    tail
      .split('**')
      .map((part) =>
        part.replace(RE_SPECIAL, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'),
      )
      .join('.*');
  // Where a match can live: a literal path is its own prefix (the walk
  // must reach it), a wildcarded one is the static directory before it.
  const prefixEnd = full.search(/[*?]/);
  const prefix = byName
    ? ''
    : prefixEnd === -1
      ? `${full}/`
      : full.slice(0, full.lastIndexOf('/', prefixEnd) + 1);
  return { re: new RegExp(`^${body}$`), byName, dirOnly, negate, prefix };
}

function nameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function hits(rule: CompiledRule, path: string, isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false;
  return rule.re.test(rule.byName ? nameOf(path) : path);
}

/**
 * The filter for one walk. `include` / `exclude` come from the
 * connection; ignore files are added as the walk enters the directories
 * that hold them and apply to everything beneath.
 */
export class PathFilter {
  private readonly include: CompiledRule[];
  private readonly exclude: CompiledRule[];
  private readonly ignore: Array<{ base: string; rules: CompiledRule[] }> = [];

  constructor(rules: { include?: string[] | undefined; exclude?: string[] | undefined }) {
    this.include = (rules.include ?? []).map((p) => compileRule(p)).filter(isRule);
    this.exclude = (rules.exclude ?? []).map((p) => compileRule(p)).filter(isRule);
  }

  /** A `.brainignore`-style file found at `base` (relative dir, '' = root). */
  addIgnoreFile(base: string, text: string): void {
    const rules = text
      .split(/\r?\n/)
      .map((line) => compileRule(line, base))
      .filter(isRule);
    if (rules.length > 0) this.ignore.push({ base, rules });
  }

  /** May the walk enter this directory? (excludes and ignores prune; includes must be reachable beneath) */
  admitsDir(path: string): boolean {
    if (this.excluded(path, true) || this.ignored(path, true)) return false;
    if (this.include.length === 0) return true;
    const lineage = [...ancestorsOf(path), path];
    return this.include.some(
      (r) =>
        r.byName ||
        r.prefix === '' ||
        r.prefix.startsWith(`${path}/`) ||
        `${path}/`.startsWith(r.prefix) ||
        lineage.some((a) => hits(r, a, true)),
    );
  }

  /** Is this file an item? An include that names a directory admits everything beneath it. */
  admitsFile(path: string): boolean {
    if (this.excluded(path, false) || this.ignored(path, false)) return false;
    if (this.include.length === 0) return true;
    const lineage = ancestorsOf(path);
    return this.include.some((r) => hits(r, path, false) || lineage.some((a) => hits(r, a, true)));
  }

  private excluded(path: string, isDir: boolean): boolean {
    return this.exclude.some((r) => hits(r, path, isDir));
  }

  /** gitignore semantics: rules of every ignore file above the path, in order, last match wins. */
  private ignored(path: string, isDir: boolean): boolean {
    let verdict = false;
    for (const file of this.ignore) {
      if (file.base !== '' && !path.startsWith(`${file.base}/`)) continue;
      for (const rule of file.rules) {
        if (hits(rule, path, isDir)) verdict = !rule.negate;
      }
    }
    return verdict;
  }
}

/** `a/b/c.md` → `['a', 'a/b']`. */
function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1))
    out.push(path.slice(0, i));
  return out;
}

function isRule(r: CompiledRule | null): r is CompiledRule {
  return r !== null;
}

/** The ignore-file names a walk honours by default. */
export const DEFAULT_IGNORE_FILES = ['.brainignore'];
