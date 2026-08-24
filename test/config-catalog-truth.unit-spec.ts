import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_CATALOG } from '../src/admin/config-catalog.data';

/**
 * Audit W6 (engine-architecture-audit-2026-08.md #28-#31): the operator
 * catalogue was a set of ASSERTIONS nothing verified. `runtimeMutable:
 * true` was false for 15+ entries whose flag is captured in a service
 * constructor (the config UI told operators a live flip works when it
 * does nothing), several defaultValues contradicted the code, and one
 * catalogued flag is read nowhere at all.
 *
 * These gates derive the truth from the source instead: any new drift
 * fails here rather than in production.
 */
const SRC = join(__dirname, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const FILES = walk(SRC).filter(
  (f) => !f.endsWith('config-catalog.data.ts') && !f.endsWith('env-validation.ts'),
);
const SOURCES = new Map(FILES.map((f) => [f, readFileSync(f, 'utf8')]));

/**
 * Files mentioning this env key at all. Deliberately a plain substring
 * match: keys are read as `process.env.X`, `config.get('X')`, `env.X`
 * (destructured validators) and inside template helpers — a stricter
 * matcher produced false "dead flag" reports.
 */
function readersOf(key: string): string[] {
  const hits: string[] = [];
  for (const [file, text] of SOURCES) {
    if (text.includes(key)) hits.push(file);
  }
  return hits;
}

/**
 * A flag captured inside a `constructor(...) { … }` body (or a
 * module-scope / field initializer) is frozen at boot, so
 * `runtimeMutable: true` is a lie for it. Constructor bodies are found
 * by brace matching from the parameter list; field initializers are
 * caught by the `private readonly x = …KEY…` shape.
 */
function constructorBodies(text: string): string[] {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf('constructor(', from);
    if (start === -1) break;
    const parenEnd = text.indexOf(')', start);
    const bodyStart = text.indexOf('{', parenEnd);
    if (bodyStart === -1) break;
    let depth = 0;
    let i = bodyStart;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    bodies.push(text.slice(bodyStart, i));
    from = i + 1;
  }
  return bodies;
}

function capturedAtBoot(key: string, file: string): boolean {
  const text = SOURCES.get(file) ?? '';
  if (constructorBodies(text).some((b) => b.includes(key))) return true;
  // Boot-time initializers only: a CLASS FIELD (two-space indent, access
  // modifier or `readonly`) or a MODULE-SCOPE const. A `const` inside a
  // method body is per-call and stays genuinely runtime-mutable.
  return text.split('\n').some((line) => {
    if (!line.includes(key)) return false;
    const classField = /^ {2}(private |public |protected )?readonly /.test(line);
    const moduleConst = /^(export )?const /.test(line);
    return classField || moduleConst;
  });
}

describe('config catalogue truth gates (W6)', () => {
  it('every catalogued key is read somewhere in src/', () => {
    const dead = CONFIG_CATALOG.filter((e) => readersOf(e.key).length === 0).map((e) => e.key);
    // EPISODE_SUBSTRATE_ENABLED was the finding: catalogued, documented as
    // a dependency of INGEST_EPISODE_ONLY, and read by nothing.
    expect(dead).toEqual([]);
  });

  it('runtimeMutable:true is never claimed for a constructor-captured flag', () => {
    const liars: string[] = [];
    for (const entry of CONFIG_CATALOG) {
      if (!entry.runtimeMutable) continue;
      for (const file of readersOf(entry.key)) {
        if (capturedAtBoot(entry.key, file)) {
          liars.push(`${entry.key} (captured in ${file.replace(SRC, 'src')})`);
          break;
        }
      }
    }
    expect(liars).toEqual([]);
  });

  it('catalogue keys are unique', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of CONFIG_CATALOG) {
      if (seen.has(e.key)) dupes.push(e.key);
      seen.add(e.key);
    }
    expect(dupes).toEqual([]);
  });

  it('boolean entries declare a boolean-shaped default', () => {
    const bad = CONFIG_CATALOG.filter(
      (e) =>
        e.isBooleanFlag &&
        e.defaultValue !== null &&
        !['0', '1', 'true', 'false'].includes(e.defaultValue),
    ).map((e) => `${e.key}=${e.defaultValue}`);
    expect(bad).toEqual([]);
  });
});

describe('source hygiene', () => {
  it('no source file contains NUL bytes (they make grep skip the file)', () => {
    // A single stray NUL in episode-store.service.ts made grep treat it as
    // binary and skip it silently — which is how an architecture auditor
    // concluded EPISODE_SUBSTRATE_ENABLED was "read nowhere" while the
    // flag was in fact gating L0 capture. Cheap gate, expensive bug.
    const offenders = FILES.filter((f) => readFileSync(f).includes(0x00)).map((f) =>
      f.replace(SRC, 'src'),
    );
    expect(offenders).toEqual([]);
  });
});
