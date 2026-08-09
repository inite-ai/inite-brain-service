import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_CATALOG } from '../src/admin/config-catalog.data';

/**
 * Flag-budget gate (owner directive 2026-08-03, S5.1 of
 * docs/roadmap/next-session-platform-2026-08.md): every engine-behavior
 * boolean env flag must appear in the golden file. The budget may go
 * DOWN silently — deleting a flag needs no golden edit — but ADDING one
 * fails here, forcing a deliberate decision instead of a quiet fork.
 *
 * A fork that wants to exist should live on a git branch: win → become
 * the code, lose → die with the branch. A flag whose only purpose is to
 * let one measurement see a different code path is a second engine we
 * then maintain forever.
 *
 * Detection is two-pronged so an uncatalogued fork can't slip past:
 *   1. any key parsed via envFlagEnabled()/envFlagNotDisabled() in src/
 *      (the one-boolean-idiom gate forces new boolean reads through
 *      those parsers, so this prong is closed under that gate), and
 *   2. any CONFIG_CATALOG entry with isBooleanFlag: true,
 * filtered to the engine prefixes (synthesis / extraction / substrate).
 * Ops/infra flags (DREAMS_, ABAC_, THROTTLE_, …) are out of scope —
 * they gate deployments, not engine behavior.
 *
 * RETRIEVAL_ is a DELIBERATE carve-out (owner decision 2026-08-09):
 * those keys are typed RetrievalProfile fields — per-tenant
 * configuration, not forks — so they sit outside ENGINE_PREFIX. The
 * carve-out is BOUNDED by its own golden below
 * (retrieval-profile-keys.golden.json): adding a RETRIEVAL_ key fails
 * the second gate, so profile-field status is a reviewed decision, not
 * a free pass around the budget.
 */
const ENGINE_PREFIX =
  /^(SEARCH|SYNTHESIZE|MULTI_HOP|EXTRACTOR|EXTRACTION|INGEST|EPISODE|EPISODES|DERIVER|AGENT_QA)_/;

const SRC = join(__dirname, '..', 'src');
const GOLDEN_PATH = join(__dirname, 'golden', 'engine-behavior-flags.golden.json');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function currentEngineFlags(): Set<string> {
  const keys = new Set<string>();
  const files = walk(SRC).filter(
    (f) =>
      !f.endsWith('config-catalog.data.ts') && !f.endsWith('env-validation.ts'),
  );
  const parserRead =
    /envFlag(?:Enabled|NotDisabled)\(\s*(?:process\.env\.|this\.configService\.get<string>\(.)([A-Z][A-Z0-9_]+)/g;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(parserRead)) keys.add(m[1]);
  }
  for (const entry of CONFIG_CATALOG) {
    if (entry.isBooleanFlag) keys.add(entry.key);
  }
  return new Set([...keys].filter((k) => ENGINE_PREFIX.test(k)));
}

describe('flag budget (engine-behavior boolean flags)', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as string[];

  it('golden file is sorted and unique', () => {
    expect(golden).toEqual([...new Set(golden)].sort());
  });

  it('no engine-behavior flag exists outside the golden budget', () => {
    const current = currentEngineFlags();
    const additions = [...current].filter((k) => !golden.includes(k)).sort();
    if (additions.length > 0) {
      throw new Error(
        `New engine-behavior flag(s) detected: ${additions.join(', ')}.\n` +
          'The flag budget only goes down. If this is an eval fork, put it ' +
          'on a git branch instead (winner becomes the code, loser dies ' +
          'with the branch). If it is genuinely per-tenant configuration, ' +
          'model it as a RetrievalProfile / extraction-profile field. Only ' +
          'a deliberate owner decision adds a key to ' +
          'test/golden/engine-behavior-flags.golden.json.',
      );
    }
  });

  it('the RETRIEVAL_ carve-out is bounded by its own golden', () => {
    const goldenKeys = JSON.parse(
      readFileSync(
        join(__dirname, 'golden', 'retrieval-profile-keys.golden.json'),
        'utf8',
      ),
    ) as string[];
    expect(goldenKeys).toEqual([...new Set(goldenKeys)].sort());
    const current = CONFIG_CATALOG.filter((e) =>
      e.key.startsWith('RETRIEVAL_'),
    )
      .map((e) => e.key)
      .sort();
    const additions = current.filter((k) => !goldenKeys.includes(k));
    if (additions.length > 0) {
      throw new Error(
        `New RETRIEVAL_ profile key(s): ${additions.join(', ')}.\n` +
          'The RETRIEVAL_ prefix sits outside the flag budget as ' +
          'per-tenant profile configuration — but the carve-out is ' +
          'bounded. A new key is a deliberate decision: bump ' +
          'test/golden/retrieval-profile-keys.golden.json with the ' +
          'rationale in the commit message, or model the behavior ' +
          'inside an existing profile dimension instead.',
      );
    }
    // Removal is the free direction, same as the main budget.
    const stale = goldenKeys.filter((k) => !current.includes(k));
    expect(Array.isArray(stale)).toBe(true);
  });

  it('reports (but allows) golden entries whose flag is already deleted', () => {
    const current = currentEngineFlags();
    const stale = golden.filter((k) => !current.has(k));
    if (stale.length > 0) {
      // Deletion is the desired direction — never a failure. The note
      // keeps the golden prunable without making removal a two-step.
      console.info(
        `flag-budget: ${stale.length} golden entr(y/ies) no longer in src ` +
          `(prune when convenient): ${stale.join(', ')}`,
      );
    }
    expect(Array.isArray(stale)).toBe(true);
  });
});
