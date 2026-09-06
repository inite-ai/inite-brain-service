/**
 * Run-scoped module identity for the code-memory battery corpus
 * (test/eval/code-memory/corpus.ts moduleIdentity / buildTurns /
 * buildChecks) — the k10 hermeticity fix.
 *
 * Measured failure being pinned: knowledge entities are tenant-GLOBAL
 * while battery facts are per-run user-scoped, so with a STATIC module
 * name every rerun re-resolved the path/symbol phrasings onto whatever
 * entities the FIRST run minted. On the dogfood stand, runs
 * cm-dogfood-1..3 executed on pre-#453 code and minted the
 * `src/gateway/webhook-dispatcher.ts` / `WebhookDispatcher` twin pair;
 * run cm-dogfood-4 (INGEST_CODE_ALIAS_RESOLUTION=1) then reused BOTH
 * twins via the step-2 exact-name match and re-measured the stale
 * split — while a fresh-tenant repro of the same two phrasings
 * resolved to ONE entity. Run-scoping the module name makes each run
 * measure its own resolution.
 *
 * The spec pins three contracts:
 *  1. back-compat: no runId ⇒ the historical static corpus,
 *     byte-identical (ALL_TURNS / CHECKS keep meaning what they meant);
 *  2. round-trip: the run-scoped path and symbol stay derivable from
 *     each other through the REAL product helpers (code-alias.ts), in
 *     BOTH directions the resolver uses;
 *  3. lockstep: turns and the k10 check agree on the names.
 */
import { pathNeedlesForSymbol, symbolAliasForPath } from '../src/ingest/code-alias';
import {
  ALL_TURNS,
  buildChecks,
  buildTurns,
  CHECKS,
  moduleIdentity,
  moduleRunSlug,
} from './eval/code-memory/corpus';

describe('moduleRunSlug', () => {
  it('lowercases and strips non-alphanumerics', () => {
    expect(moduleRunSlug('cmmtpzlspw')).toBe('cmmtpzlspw');
    expect(moduleRunSlug('Run_7-KQ')).toBe('run7kq');
  });

  it('prefixes a digit-leading slug so it stays a valid symbol hump', () => {
    expect(moduleRunSlug('42ab')).toBe('r42ab');
  });

  it('empty in, empty out (the unscoped legacy identity)', () => {
    expect(moduleRunSlug('')).toBe('');
    expect(moduleRunSlug('__--__')).toBe('');
  });
});

describe('moduleIdentity', () => {
  it('unscoped identity is the historical static one, byte-identical', () => {
    const m = moduleIdentity('');
    expect(m.path).toBe('src/gateway/webhook-dispatcher.ts');
    expect(m.symbol).toBe('WebhookDispatcher');
    expect(m.nameTokens).toEqual(['webhook-dispatcher', 'webhookdispatcher', 'webhook dispatcher']);
  });

  it('run-scoped path derives the run-scoped symbol via the REAL product helper', () => {
    const m = moduleIdentity('cmmtpzlspw');
    expect(m.path).toBe('src/gateway/webhook-dispatcher-cmmtpzlspw.ts');
    expect(m.symbol).toBe('WebhookDispatcherCmmtpzlspw');
    // Forward direction (path → symbol): what creation-time alias
    // seeding and reuseSymbolEntityForPath derive.
    expect(symbolAliasForPath(m.path)).toBe(m.symbol);
    // Reverse direction (symbol → path): reusePathEntityForSymbol scans
    // needles with string::contains(canonicalNameLc, needle) — the
    // kebab needle must be a substring of the run-scoped path.
    const needles = pathNeedlesForSymbol(m.symbol);
    expect(needles).toContain(m.basename);
    expect(m.path.includes(m.basename)).toBe(true);
  });

  it('run-scoped nameTokens name THIS run only (no generic natural-language token)', () => {
    const m = moduleIdentity('cmmtpzlspw');
    expect(m.nameTokens).toEqual(['webhook-dispatcher-cmmtpzlspw', 'webhookdispatchercmmtpzlspw']);
  });
});

describe('buildTurns / buildChecks lockstep', () => {
  it('no runId ⇒ the exported static corpus, deep-equal', () => {
    expect(buildTurns()).toEqual(ALL_TURNS);
    expect(buildChecks()).toEqual(CHECKS);
  });

  it('run-scoped turns carry the module by PATH (decision#1) and SYMBOL (flags#4)', () => {
    const m = moduleIdentity('cmmtpzlspw');
    const turns = buildTurns('cmmtpzlspw');
    const decision1 = turns.find((t) => t.conversation === 'decision' && t.turn === 1);
    const flags4 = turns.find((t) => t.conversation === 'flags' && t.turn === 4);
    expect(decision1?.text).toContain(m.path);
    expect(flags4?.text.startsWith(m.symbol)).toBe(true);
    // The static names must NOT leak into a scoped corpus — that would
    // resolve onto the legacy twins again.
    expect(decision1?.text).not.toContain('webhook-dispatcher.ts');
    expect(flags4?.text).not.toContain('WebhookDispatcher ');
  });

  it('the k10 check names the same run-scoped module as the turns', () => {
    const m = moduleIdentity('cmmtpzlspw');
    const k10 = buildChecks('cmmtpzlspw').find((c) => c.id === 'k10-cross-entity');
    expect(k10?.kind).toBe('cross-entity');
    if (k10?.kind !== 'cross-entity') throw new Error('k10 shape changed');
    expect(k10.nameTokens).toEqual(m.nameTokens);
    expect(k10.intent).toContain(m.path);
    expect(k10.intent).toContain(m.symbol);
    // The phrasing groups stay the corpus invariants, untouched.
    expect(k10.mustCarryGroups).toEqual([
      ['dispatch path', 'outbound webhook'],
      ['cents', 'line-item'],
    ]);
  });

  it('only the module-bearing turns differ from the static corpus', () => {
    const scoped = buildTurns('cmmtpzlspw');
    const differing = scoped.filter((t, i) => t.text !== ALL_TURNS[i]?.text);
    expect(differing.map((t) => `${t.conversation}#${t.turn}`)).toEqual(['decision#1', 'flags#4']);
  });
});
