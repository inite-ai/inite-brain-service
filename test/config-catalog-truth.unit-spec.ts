import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_CATALOG } from '../src/admin/config-catalog.data';
import { resolveRetrievalProfile } from '../src/search/retrieval-profile';

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

  /**
   * The catalogue's `defaultValue` is what an operator reads to decide
   * whether a surface is open. It was hand-maintained against a reader
   * that decides the opposite, and the two drifted: entries claiming a
   * default the code did not implement are how a finished, tested API
   * ends up answering 404 with nobody able to see why.
   *
   * The reader itself says which default it implements — `envFlagEnabled`
   * is off-unless-set, `envFlagNotDisabled` is on-unless-cleared — so
   * derive it from the source rather than trusting the literal. Flags
   * read through neither helper (parsed by hand, defaulted with `??`,
   * validated only in env-validation.ts, which is excluded from SOURCES)
   * are skipped: this gate is for the two idioms, and a wrong guess here
   * would be worse than no gate. So is a reader that handles the unset
   * case before it reaches a helper — CALIBRATION_NIGHTLY_REFIT is
   * `env.X == null ? true : envFlagEnabled(env.X)`, default ON through a
   * helper that on its own means off.
   */
  it('every catalogued boolean default matches the helper its reader uses', () => {
    const drift: string[] = [];
    for (const entry of CONFIG_CATALOG) {
      if (!entry.isBooleanFlag || entry.defaultValue === null) continue;
      let offUnlessSet = false;
      let onUnlessCleared = false;
      let decidesUnsetItself = false;
      for (const text of SOURCES.values()) {
        if (text.includes(`envFlagEnabled(process.env.${entry.key})`)) offUnlessSet = true;
        if (text.includes(`envFlagNotDisabled(process.env.${entry.key})`)) onUnlessCleared = true;
        // Same two idioms reached through Nest's ConfigService instead of
        // process.env — the DREAMS_* family and the embedder read that way,
        // and matching only `process.env.` let EMBEDDING_SPACE_STRICT sit
        // catalogued `0` for a month after it was made default-on as a P1.
        for (const m of text.matchAll(
          new RegExp(
            `envFlag(Enabled|NotDisabled)\\(\\s*(?:this\\.)?configService\\.get(?:<[^>]*>)?\\(\\s*'${entry.key}'`,
            'g',
          ),
        )) {
          if (m[1] === 'Enabled') offUnlessSet = true;
          else onUnlessCleared = true;
        }
        if (
          text.includes(`process.env.${entry.key} ==`) ||
          text.includes(`process.env.${entry.key} ??`)
        ) {
          decidesUnsetItself = true;
        }
      }
      if (decidesUnsetItself) continue;
      // Neither idiom, or both (a flag whose two readers disagree is its
      // own bug, reported by the sibling gates) — nothing to assert here.
      if (offUnlessSet === onUnlessCleared) continue;
      const expected = onUnlessCleared ? ['1', 'true'] : ['0', 'false'];
      if (!expected.includes(entry.defaultValue)) {
        drift.push(
          `${entry.key}: catalogue says ${entry.defaultValue}, code reads it with ` +
            `${onUnlessCleared ? 'envFlagNotDisabled (default on)' : 'envFlagEnabled (default off)'}`,
        );
      }
    }
    expect(drift).toEqual([]);
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

describe('credential masking', () => {
  /**
   * GET /v1/admin/config returned EVIDENCE_SIGNED_URL_SECRET verbatim: the
   * entry simply omitted `secret: true`, so config-inspector handed the raw
   * HMAC key to every brain:admin caller. That one is fixed; this gate is
   * here so the NEXT credential cannot ship the same way, because the flag
   * is opt-in and forgetting it fails open.
   *
   * The rule is deliberately name-shaped rather than a hand-kept allowlist:
   * an allowlist has the same failure mode as the flag it guards. It is
   * therefore extended by SHAPE, never by key: `_SECRET_ACCESS_KEY` is the
   * AWS-family name for a secret and does not end in any suffix above, so
   * the anchored alternation alone would have let EVIDENCE_S3_SECRET_ACCESS_KEY
   * ship unmasked — the exact failure this gate exists to catch.
   */
  const CREDENTIAL_NAME = /(SECRET|_API_KEY|_TOKEN|PASSWORD|PRIVATE_KEY|_SECRET_ACCESS_KEY)$/;

  it('every credential-shaped catalogue key is masked', () => {
    const unmasked = CONFIG_CATALOG.filter(
      (e) => CREDENTIAL_NAME.test(e.key) && e.secret !== true,
    ).map((e) => e.key);
    expect(unmasked).toEqual([]);
  });

  it('nothing is masked that is not a credential (the regex still means something)', () => {
    // Guards the other direction: if `secret: true` ever spreads to ordinary
    // knobs, operators lose the ability to read their own configuration and
    // the masking stops carrying information.
    const surprising = CONFIG_CATALOG.filter(
      (e) => e.secret === true && !CREDENTIAL_NAME.test(e.key),
    ).map((e) => e.key);
    expect(surprising).toEqual([]);
  });
});

describe('retrieval-profile defaults the catalogue claims', () => {
  /**
   * The genre-preset trap. A retrieval-profile field resolves
   * `env key > genre preset > code default`, and the default genre is
   * assistant_chat — which presets two levers ON. The catalogue was
   * written against the CODE default, so GET /v1/admin/config told an
   * operator "RETRIEVAL_ABSTENTION_CALIBRATION: off" and
   * "RETRIEVAL_SCENE_TRACES: 0" on a stock install that in fact runs
   * verifier-abstention and scene traces. Found while tracing why the
   * decision plane recorded nothing: the stand reported the abstention
   * mode as 'off' and it was not off.
   *
   * The binding key → profile field is derived from the resolver itself,
   * so a new preset-backed lever is covered the day it is added.
   */
  const PROFILE_SRC = readFileSync(join(SRC, 'search', 'retrieval-profile.ts'), 'utf8');
  const bindings = new Map<string, string>();
  for (const m of PROFILE_SRC.matchAll(/(\w+):\s*presetFlag\(\s*env,\s*'([A-Z0-9_]+)'/g)) {
    bindings.set(m[2]!, m[1]!);
  }
  for (const m of PROFILE_SRC.matchAll(/(\w+):\s*enumEnv\(\s*env,\s*'([A-Z0-9_]+)'/g)) {
    bindings.set(m[2]!, m[1]!);
  }

  it('binds a non-trivial number of keys (the matcher still matches)', () => {
    expect(bindings.size).toBeGreaterThan(10);
  });

  it('every bound key documents the value a stock deployment resolves', () => {
    const stock = resolveRetrievalProfile({} as NodeJS.ProcessEnv) as unknown as Record<
      string,
      unknown
    >;
    const byKey = new Map(CONFIG_CATALOG.map((e) => [e.key, e]));
    const drift: string[] = [];
    for (const [key, field] of bindings) {
      const entry = byKey.get(key);
      if (!entry) continue; // catalogue coverage is a separate gate
      const v = stock[field];
      const resolved = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
      if (entry.defaultValue !== resolved) {
        drift.push(`${key}: catalogue '${entry.defaultValue}' vs resolved '${resolved}'`);
      }
    }
    expect(drift).toEqual([]);
  });
});
