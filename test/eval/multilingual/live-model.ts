import type {
  LanguageCode,
  MultilingualCase,
  MultilingualPrediction,
} from '../../../src/eval/types';
import type { HttpBrainClient } from '../http-brain-client';
import { detectLanguage } from './script-detect';
import {
  CODE_SWITCH_QUERIES,
  ROLE_QUERIES,
  ROLE_SENTENCES,
  SHORT_INPUTS,
  hasSurfaceFor,
  temporalCarrier,
} from './surface-corpus';
import type { MultilingualModel } from './model';

/**
 * The live half of the multilingual matrix: drive the REAL brain over
 * HTTP and hand the matrix runner a prediction per case.
 *
 * WHAT THIS REPLACES. `RealModel.predict` threw, with the comment "the
 * live wiring is intentionally unbuilt", so every number the matrix has
 * ever produced came from StubModel deriving predictions from the case's
 * own gold. The grid, the metrics and the report were real; the system
 * under test was not. The multilingual roadmap calls this Tier 0 — "the
 * measurable gate that must exist before any behaviour flip" — and the
 * eleven MULTILINGUAL_* lanes have been sitting behind it, unmeasured.
 *
 * THE INTERFACE IS SYNCHRONOUS (`predict(case): Prediction`) and a live
 * run is not, so the network happens FIRST: `collectLivePredictions`
 * walks the cases, does every ingest and query, and returns a map that
 * `PrefetchedModel` then serves synchronously. The matrix runner stays
 * exactly as pure as it was.
 *
 * TENANT ISOLATION IS PER-USER, not per-tenant. One eval tenant, one
 * `userId` per isolation group (0055/0093 per-user scoping), so the
 * Russian store does not answer the German case's query. Minting seven
 * tenants would work too and would cost seven schema migrations.
 *
 * REFS RESOLVE BY ID. Every ingest records which entity and fact ids it
 * produced; results map back through those. Nothing here matches a
 * result against a ref by text, which is the only way the mapping can be
 * genuinely script-independent — a Latin-string match would quietly turn
 * cross-lingual retrieval into a lexical baseline and report it as a
 * win.
 *
 * WHAT IT DOES NOT PREDICT, deliberately: the `conflict` and `lane`
 * labels. Producing those live needs a mapping from the resolver's own
 * outcome vocabulary onto the matrix's, and inventing that mapping to
 * fill a cell would manufacture a number nobody could trace. Those
 * blocks come back undefined and the runner reports them as no-data
 * (n=0), which is the truth.
 */

export interface LiveRunOptions {
  client: HttpBrainClient;
  /** Prefix for the per-case user scopes; keeps concurrent runs apart. */
  runId: string;
  /** Called once per case with a one-line progress note. */
  onProgress?: (line: string) => void;
}

/** A model that answers from a pre-computed map — the sync adapter. */
export class PrefetchedModel implements MultilingualModel {
  readonly kind = 'real' as const;
  constructor(private readonly byCase: ReadonlyMap<string, MultilingualPrediction>) {}
  predict(testCase: MultilingualCase): MultilingualPrediction {
    return this.byCase.get(testCase.id) ?? {};
  }
}

/** Cases this live path can actually drive, with a reason for the rest. */
export function liveCoverage(cases: readonly MultilingualCase[]): {
  covered: MultilingualCase[];
  skipped: Array<{ id: string; reason: string }>;
} {
  const covered: MultilingualCase[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const c of cases) {
    if (hasSurfaceFor(c.id, c.failureMode)) covered.push(c);
    else skipped.push({ id: c.id, reason: `no surface input for ${c.failureMode}` });
  }
  return { covered, skipped };
}

export async function collectLivePredictions(
  cases: readonly MultilingualCase[],
  opts: LiveRunOptions,
): Promise<Map<string, MultilingualPrediction>> {
  const { client, runId } = opts;
  const note = opts.onProgress ?? ((): void => undefined);
  const out = new Map<string, MultilingualPrediction>();

  // ── Shared role corpus, one user scope per STORE language ───────────
  // entityId -> ref, built at ingest, used to map every later result.
  const roleRefByEntity = new Map<string, Map<string, string>>();
  const roleStoreLangs = new Set<LanguageCode>(
    cases.filter((c) => c.gold.retrieval !== undefined).map((c) => c.storeLang),
  );
  for (const lang of roleStoreLangs) {
    const scope = `${runId}-role-${lang}`;
    const byEntity = new Map<string, string>();
    for (const [ref, byLang] of Object.entries(ROLE_SENTENCES)) {
      const text = byLang[lang];
      if (!text) continue;
      const res = await client.ingest.mention({
        text,
        userId: scope,
        conversationId: `${scope}-conv`,
        occurredAt: new Date().toISOString(),
      });
      for (const id of res.extractedEntityIds ?? []) byEntity.set(String(id), ref);
    }
    roleRefByEntity.set(lang, byEntity);
    note(`[live] role corpus stored in ${lang}: ${byEntity.size} entity id(s)`);
  }

  for (const c of cases) {
    if (!hasSurfaceFor(c.id, c.failureMode)) continue;
    const p: MultilingualPrediction = {};

    // ── retrieval + answer language + abstention ─────────────────────
    if (c.gold.retrieval !== undefined || c.gold.answerLang !== undefined) {
      const scope = `${runId}-role-${c.storeLang}`;
      const query =
        c.failureMode === 'code_switching'
          ? (CODE_SWITCH_QUERIES[c.id] ?? ROLE_QUERIES[c.queryLang])
          : ROLE_QUERIES[c.queryLang];
      const synth = await client.synthesize({ query, limit: 10, userId: scope });

      if (c.gold.retrieval !== undefined) {
        const byEntity = roleRefByEntity.get(c.storeLang) ?? new Map<string, string>();
        // Result order IS the ranking; first occurrence of each ref wins,
        // so a ref cited twice does not outrank one cited once.
        const ranked: string[] = [];
        for (const hit of synth.results ?? []) {
          const ref = byEntity.get(String(hit.entityId));
          if (ref !== undefined && !ranked.includes(ref)) ranked.push(ref);
        }
        p.retrieval = { rankedRefs: ranked };
      }
      if (c.gold.answerLang !== undefined) {
        const text = typeof synth.answer === 'string' ? synth.answer : null;
        p.answer = { text, langDetected: text ? detectLanguage(text).lang : null };
      }
      if (c.gold.abstention !== undefined) {
        // An abstention is a null answer OR an answer with no citation to
        // stand on — the serving contract's own two shapes of refusal.
        const answered =
          typeof synth.answer === 'string' &&
          synth.answer.trim() !== '' &&
          (synth.citations ?? []).length > 0;
        p.abstention = { abstained: !answered, confidence: answered ? 1 : 0 };
      }
      note(`[live] ${c.id}: ${(p.retrieval?.rankedRefs ?? []).join(' > ') || 'no ranked refs'}`);
    }

    // ── temporal: the expression must resolve to the gold calendar day ─
    if (c.gold.temporal !== undefined) {
      const scope = `${runId}-temp-${c.id}`;
      const text = temporalCarrier(c.gold.temporal.expression, c.gold.temporal.lang);
      await client.ingest.mention({
        text,
        userId: scope,
        conversationId: `${scope}-conv`,
        occurredAt: new Date().toISOString(),
      });
      const hits = await client.search({
        query: c.gold.temporal.expression,
        limit: 10,
        userId: scope,
      });
      p.temporal = { predictedDate: firstEventDay(hits.results ?? []) };
      note(
        `[live] ${c.id}: ${c.gold.temporal.expression} -> ${p.temporal.predictedDate ?? 'none'}`,
      );
    }

    // ── entity fragmentation: how many nodes did one person land in ───
    if (c.gold.linking !== undefined) {
      const scope = `${runId}-frag-${c.id}`;
      const nodeIds: string[] = [];
      for (const s of c.gold.linking.surfaces) {
        const res = await client.ingest.mention({
          text: fragmentationSentence(s.surface, s.lang),
          userId: scope,
          conversationId: `${scope}-conv`,
          occurredAt: new Date().toISOString(),
        });
        nodeIds.push(String((res.extractedEntityIds ?? [])[0] ?? `unlinked:${s.surface}`));
      }
      // The modal node is the one the system treated as this entity;
      // every surface that reached it counts as linked to the gold, and
      // the rest are fragments. Accuracy and fragmentation therefore read
      // the same event from two sides, which is what the two metrics are.
      const modal = modalValue(nodeIds);
      p.linking = {
        nodeIds,
        linkedRefs: nodeIds.map((n) => (n === modal ? c.gold.linking!.goldEntity : null)),
      };
      note(`[live] ${c.id}: ${new Set(nodeIds).size} node(s) for ${nodeIds.length} surface(s)`);
    }

    // ── short strings: did the value survive extraction at all ────────
    if (c.gold.extraction !== undefined) {
      const input = SHORT_INPUTS[c.id];
      if (input !== undefined) {
        const scope = `${runId}-short-${c.id}`;
        await client.ingest.mention({
          text: input.text,
          userId: scope,
          conversationId: `${scope}-conv`,
          occurredAt: new Date().toISOString(),
        });
        const hits = await client.search({ query: input.text, limit: 10, userId: scope });
        p.extraction = { facts: matchedGoldKeys(c.gold.extraction.goldFacts, hits.results ?? []) };
        note(
          `[live] ${c.id}: ${p.extraction.facts.length}/${c.gold.extraction.goldFacts.length} gold key(s)`,
        );
      }
    }

    out.set(c.id, p);
  }
  return out;
}

/** A neutral carrier so the surface reaches the extractor as a mention. */
function fragmentationSentence(surface: string, lang: LanguageCode): string {
  const frames: Partial<Record<LanguageCode, string>> = {
    en: `${surface} joined the project.`,
    ru: `${surface} присоединился к проекту.`,
    de: `${surface} ist dem Projekt beigetreten.`,
    es: `${surface} se unió al proyecto.`,
    zh: `${surface} 加入了这个项目。`,
    ar: `${surface} انضم إلى المشروع.`,
    hi: `${surface} परियोजना में शामिल हुए।`,
  };
  return frames[lang] ?? `${surface} joined the project.`;
}

/** Earliest event day any returned fact carries, as YYYY-MM-DD. */
function firstEventDay(
  results: ReadonlyArray<{ facts?: ReadonlyArray<Record<string, unknown>> }>,
): string | null {
  const days: string[] = [];
  for (const r of results) {
    for (const f of r.facts ?? []) {
      for (const key of ['validFrom', 'mentionedAt']) {
        const v = f[key];
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) days.push(v.slice(0, 10));
      }
    }
  }
  if (days.length === 0) return null;
  days.sort();
  return days[0]!;
}

/** The value that occurs most often; ties break on first appearance. */
function modalValue(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let bestN = 0;
  for (const v of values) {
    const n = counts.get(v) ?? 0;
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/**
 * Which gold `key=value` pairs the system actually surfaced.
 *
 * The gold is language-neutral (`role=cto`, `name=Li Wei`), the brain
 * emits its own predicates, and inventing a predicate-by-predicate
 * translation table would be exactly the kind of hand-mapping this wave
 * has been deleting. So the test is deliberately weak and stated: the
 * pair counts as produced when its VALUE appears, case-insensitively, in
 * some returned fact's object, predicate or entity name. That measures
 * "did the value survive extraction at all", which is the failure mode
 * the short-string cases are about — not "was it filed under the right
 * predicate", which this corpus cannot judge.
 */
function matchedGoldKeys(
  goldFacts: readonly string[],
  results: ReadonlyArray<{
    canonicalName?: string;
    entityType?: string;
    facts?: ReadonlyArray<Record<string, unknown>>;
  }>,
): string[] {
  const haystack: string[] = [];
  for (const r of results) {
    if (typeof r.canonicalName === 'string') haystack.push(r.canonicalName.toLowerCase());
    if (typeof r.entityType === 'string') haystack.push(r.entityType.toLowerCase());
    for (const f of r.facts ?? []) {
      for (const key of ['predicate', 'object']) {
        const v = f[key];
        if (typeof v === 'string') haystack.push(v.toLowerCase());
      }
    }
  }
  const blob = haystack.join(' | ');
  return goldFacts.filter((g) => {
    const value = (g.split('=')[1] ?? '').trim().toLowerCase();
    return value !== '' && blob.includes(value);
  });
}
