import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ALL_LANES } from '../src/search/retrieval-profile';
import { LANE_REGISTRY } from '../src/synthesize/answer-router';

/**
 * Engine modularity gates (owner directive 2026-08-03, S5.2-S5.6 of
 * docs/roadmap/next-session-platform-2026-08.md). New forks are blocked
 * by gates, not by discipline:
 *
 *  2. No process.env below the profile boundary — the engine dirs take
 *     the resolved RetrievalProfile / extraction profile; direct env
 *     reads are allowed only in the locked bootstrap files below. The
 *     allowlist only shrinks.
 *  3. One boolean idiom — envFlagEnabled / envFlagNotDisabled are the
 *     only boolean-env parsers; bespoke === '1' / !== 'false' string
 *     comparisons on env-shaped reads fail (W6 fixed the instances,
 *     this keeps them fixed).
 *  4. Layering — dependency direction is enforced:
 *     episodes/substrate ← derive ← search ← synthesize.
 *  5. Dead exports — an exported symbol nothing consumes fails;
 *     test-only seams are a locked golden that only shrinks.
 *  6. Lane registry completeness — every LaneId has exactly one
 *     registry entry; no second lane type union exists.
 */
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const rel = (f: string) => relative(ROOT, f).replace(/\\/g, '/');
const ALL_SRC = walk(SRC);
const SOURCES = new Map(ALL_SRC.map((f) => [rel(f), readFileSync(f, 'utf8')]));

/**
 * Any mention of process.env counts: reads happen as member access,
 * index access, and `env: NodeJS.ProcessEnv = process.env` default
 * params handed to pure resolvers — all are env dependence.
 */
const ENV_READ_RE = /process\.env/;

describe('S5.2 — no process.env below the profile boundary', () => {
  // The ONE file inside the engine boundary allowed to read env: the
  // retrieval-profile bootstrap (RetrievalProfile for genre semantics +
  // resolveSearchTuning for deployment knobs). Every other boundary
  // module takes typed config as an argument. The V4 carried shrink
  // (2026-08) folded the nine infra-knob readers here; the derived-
  // version fallbacks route through ReadPinService.bootstrapDefault()
  // in the episodes layer. Adding a file — or re-adding a removed one —
  // fails.
  const ALLOWLIST = new Set(['src/search/retrieval-profile.ts']);
  const BOUNDARY_PREFIXES = [
    'src/search/',
    'src/synthesize/',
    'src/ai/extractor-',
    'src/ai/extractor-internals/',
    'src/admin/window-deriver',
  ];

  it('engine files read the resolved profile, not process.env', () => {
    const offenders: string[] = [];
    for (const [file, text] of SOURCES) {
      if (!BOUNDARY_PREFIXES.some((p) => file.startsWith(p))) continue;
      if (ALLOWLIST.has(file)) continue;
      if (ENV_READ_RE.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('the allowlist only shrinks (stale entries are pruned)', () => {
    const stale = [...ALLOWLIST].filter((f) => {
      const text = SOURCES.get(f);
      return text === undefined || !ENV_READ_RE.test(text);
    });
    expect(stale).toEqual([]);
  });
});

describe('S5.3 — one boolean idiom for env flags', () => {
  it("no bespoke === '1' / !== 'false' env comparisons outside env-validation", () => {
    const BESPOKE_RE =
      /(process\.env\s*[.[]\s*['"A-Za-z_][^;\n]*?|config(?:Service)?\.get<string>\((?:[^)]*)\))\s*(===|!==)\s*'(?:1|0|true|false)'/;
    const offenders: string[] = [];
    for (const [file, text] of SOURCES) {
      if (file.endsWith('common/env-validation.ts')) continue;
      for (const [i, line] of text.split('\n').entries()) {
        if (BESPOKE_RE.test(line)) offenders.push(`${file}:${i + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('S5.4 — layering: episodes ← derive ← search ← synthesize', () => {
  // Rank = position in the dependency chain; a module may import from
  // its own layer or LOWER ranks only.
  const LAYER_OF = (file: string): number | null => {
    if (file.startsWith('src/episodes/')) return 0;
    if (file.startsWith('src/admin/window-deriver')) return 1;
    if (file.startsWith('src/search/')) return 2;
    if (file.startsWith('src/synthesize/')) return 3;
    return null;
  };
  const layerOfImport = (fromFile: string, spec: string): number | null => {
    if (!spec.startsWith('.')) return null;
    const base = fromFile.split('/').slice(0, -1);
    for (const part of spec.split('/')) {
      if (part === '.') continue;
      else if (part === '..') base.pop();
      else base.push(part);
    }
    return LAYER_OF(base.join('/'));
  };

  it('no reverse imports across the engine layers', () => {
    const offenders: string[] = [];
    for (const [file, text] of SOURCES) {
      const from = LAYER_OF(file);
      if (from === null) continue;
      for (const m of text.matchAll(/from '([^']+)'/g)) {
        const to = layerOfImport(file, m[1]!);
        if (to !== null && to > from) {
          offenders.push(`${file} → ${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('S5.5 — dead exports in the engine dirs', () => {
  const SCOPE_PREFIXES = ['src/search/', 'src/synthesize/'];
  // Pure-logic seams exported ONLY so unit tests can pin them. Locked:
  // removing one is free, adding one is a deliberate decision here.
  const TEST_SEAMS = new Set([
    'selectEdgeExpansionSeeds',
    'mergeExpandedNeighbours',
    'tokenCountWorkerModulePath',
    'ALL_LANES',
    'resolveRetrievalProfile',
    'ENUMERATION_LANE_INSTRUCTION',
    'buildWideProbeQuery',
    'LANE_REGISTRY',
    'detectLane',
    'mergeExtraHits',
    'rrfFuse',
    // Fovea optics (Optics-1) documented constants — the per-class fit
    // threshold and the shared/fallback class key. Pinned by the
    // focus-signal unit spec; no serving consumer yet (Optics-2/3).
    'MIN_CLASS_SAMPLES',
    'DEFAULT_CLASS',
    // Multilingual Tier 5 — the pure cross-script output-language check.
    // Consumed inside synthesize.helpers (enforceAnswerLanguage) but pinned
    // DIRECTLY by the answer-lang-guard unit spec for its precision cases
    // (within-script not adjudicated, proper-noun/numeric-safe, floor).
    'answerLanguageMismatch',
    // V11 §2 arm (b) low-level NLI call. Consumed inside minicheck-client
    // (miniCheckVerdict — the orchestrator's seam since the 0119 file-budget
    // extraction) but pinned DIRECTLY by the minicheck unit spec for its
    // fetch-level cases (prompt shape, Yes/No parse, error surface).
    'miniCheckConsistent',
    // MM-zoom PR3 (FOVEA_FRAGMENT_ZOOM) pure decision seams. Consumed
    // inside fragment-zoom.ts (runFragmentZoom) but pinned DIRECTLY by the
    // fragment-zoom unit spec for their precision cases (cited-first /
    // truncated-only / cap selection; the substitution prefix fence).
    'selectZoomFragments',
    'buildZoomedLines',
  ]);
  const TESTS = walk(join(ROOT, 'test'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  it('every exported value has a non-test consumer (or is a locked seam)', () => {
    const offenders: string[] = [];
    for (const [file, text] of SOURCES) {
      if (!SCOPE_PREFIXES.some((p) => file.startsWith(p))) continue;
      for (const m of text.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)) {
        const name = m[1]!;
        const re = new RegExp(`\\b${name}\\b`);
        const usedInSrc = [...SOURCES].some(([g, gt]) => g !== file && re.test(gt));
        if (usedInSrc) continue;
        if (TEST_SEAMS.has(name) && re.test(TESTS)) continue;
        offenders.push(`${file} :: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the test-seam golden only shrinks', () => {
    const allText = [...SOURCES.values()].join('\n');
    const stale = [...TEST_SEAMS].filter((name) => !new RegExp(`\\b${name}\\b`).test(allText));
    expect(stale).toEqual([]);
  });
});

describe('S5.6 — lane registry completeness', () => {
  it('every LaneId has exactly one registry entry', () => {
    const ids = LANE_REGISTRY.map((l) => l.id);
    expect([...ids].sort()).toEqual([...ALL_LANES].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('no second lane type union exists outside the profile', () => {
    // The LaneId union lives in retrieval-profile.ts; any other file
    // spelling a union containing the evidence-conditional lanes is a
    // parallel lane type system growing back (audit #27). The former
    // AnswerLane union is gone (W5 carried) — the router returns LaneId
    // narrowed at runtime by which registry entries carry `detect`.
    const UNION_RE = /'temporal'[^;]{0,200}\|\s*'(?:contradiction|recency|instruction)'/s;
    const offenders = [...SOURCES]
      .filter(([file]) => !file.endsWith('src/search/retrieval-profile.ts'))
      .filter(([, text]) => UNION_RE.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
