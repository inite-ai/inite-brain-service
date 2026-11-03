/**
 * Lexical-stems battery (#892). Mechanical and free: MIRACL dev queries
 * with their human relevance judgements, run through the real episode
 * lexical leg (EpisodeReadStoreService.searchText with buildLexMatchLeg,
 * the L3 anchor shape) against a real SurrealDB with every migration
 * applied, twice per query: unstemmed (the leg before 0184) and with the
 * stemmed field (`textStem`, the query stemmed in its detected language).
 *
 * Each language is its own tenant, so BM25 statistics are a monolingual
 * corpus's. A passage's language is stamped by the production detector
 * (language-detector.ts), not taken from MIRACL, so detector misses count.
 *
 * Corpus: per language, 50 sampled dev queries that have a relevant
 * passage, and every candidate MTEB lists for them (~5k passages) as one
 * pool; each query retrieves from the whole pool. Prepare it with
 * prepare.py (README). No model, no key.
 *
 * Run: SURREALDB_URL=ws://… MIRACL_SAMPLE_DIR=… pnpm eval:lexical-stems [--langs=ru,es]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module';
import { EmbedderService } from '../../../src/ai/embedder.service';
import { ExtractorService } from '../../../src/ai/extractor.service';
import { LocalCrossEncoderProvider } from '../../../src/ai/cross-encoder/local-cross-encoder.provider';
import { detectLanguage } from '../../../src/ai/locale/language-detector';
import { SurrealService } from '../../../src/db/surreal.service';
import { TenantRegistryService } from '../../../src/auth/tenant-registry.service';
import { EpisodeReadStoreService } from '../../../src/episodes/episode-read-store.service';
import { buildLexMatchLeg } from '../../../src/search/internals/lex-leg';
import { stemLangOf } from '../../../src/search/internals/stem-lang';
import { StubEmbedder, StubExtractor, StubLocalCrossEncoder } from '../../test-doubles';

interface Sample {
  lang: string;
  queries: Array<{ id: string; text: string; relevant: string[] }>;
  corpus: Array<{ id: string; text: string }>;
}

const K = 100;
const BATCH = 500;

/** nDCG@10 with binary gains, the MIRACL headline metric. */
function ndcg10(ranked: string[], relevant: Set<string>): number {
  let dcg = 0;
  ranked.slice(0, 10).forEach((id, i) => {
    if (relevant.has(id)) dcg += 1 / Math.log2(i + 2);
  });
  let ideal = 0;
  for (let i = 0; i < Math.min(10, relevant.size); i++) ideal += 1 / Math.log2(i + 2);
  return ideal === 0 ? 0 : dcg / ideal;
}

function recall(ranked: string[], relevant: Set<string>): number {
  return ranked.filter((id) => relevant.has(id)).length / relevant.size;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

async function main(): Promise<void> {
  const dir = process.env.MIRACL_SAMPLE_DIR;
  if (!dir) throw new Error('MIRACL_SAMPLE_DIR is required (see README)');
  const langsArg = process.argv.find((a) => a.startsWith('--langs='));
  const langs = (langsArg?.slice(8) ?? 'ru,es,fr,de,en,zh,ja,ko,ar,hi').split(',');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EmbedderService)
    .useValue(new StubEmbedder())
    .overrideProvider(ExtractorService)
    .useValue(new StubExtractor())
    .overrideProvider(LocalCrossEncoderProvider)
    .useValue(new StubLocalCrossEncoder())
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  const rows: string[] = [];
  try {
    for (const lang of langs) {
      const sample = JSON.parse(readFileSync(join(dir, `${lang}.json`), 'utf8')) as Sample;
      const companyId = `co_stems_${lang}_${randomUUID().slice(0, 8)}`;
      await app.get(TenantRegistryService).register(companyId);
      const surreal = app.get(SurrealService);
      const detected = new Map<string, number>();
      const at = new Date('2026-01-01T00:00:00Z');
      for (let i = 0; i < sample.corpus.length; i += BATCH) {
        const batch = sample.corpus.slice(i, i + BATCH).map((p) => {
          const d = detectLanguage(p.text).language;
          detected.set(d, (detected.get(d) ?? 0) + 1);
          return {
            id: p.id,
            kind: 'turn',
            conversationId: 'miracl',
            messageId: p.id,
            text: p.text,
            lang: d === 'und' ? undefined : d,
            occurredAt: at,
            source: {},
          };
        });
        await surreal.withCompany(companyId, (db) =>
          db.query('INSERT INTO episode $rows RETURN NONE', { rows: batch }),
        );
      }
      const store = app.get(EpisodeReadStoreService);
      const scores = { plain: [] as number[], stem: [] as number[] };
      const recalls = { plain: [] as number[], stem: [] as number[] };
      let stemmedQueries = 0;
      for (const q of sample.queries) {
        const relevant = new Set(q.relevant);
        const qLang = stemLangOf(q.text);
        if (qLang) stemmedQueries++;
        for (const arm of ['plain', 'stem'] as const) {
          const hits = await store.searchText({
            companyId,
            query: q.text,
            limit: K,
            includePii: true,
            lex: buildLexMatchLeg({
              fields: ['text'],
              topic: q.text,
              mode: 'or_terms',
              ...(arm === 'stem' ? { stem: { field: 'textStem', lang: qLang } } : {}),
            }),
          });
          const ranked = hits.map((h) => String(h.id).replace(/^episode:⟨?|⟩$/g, ''));
          scores[arm].push(ndcg10(ranked, relevant));
          recalls[arm].push(recall(ranked, relevant));
        }
      }
      const dominant = [...detected.entries()].sort((a, b) => b[1] - a[1])[0];
      const line =
        `${lang}\tq=${sample.queries.length}\tpassages=${sample.corpus.length}` +
        `\tdetected=${dominant?.[0]}:${((dominant?.[1] ?? 0) / sample.corpus.length).toFixed(2)}` +
        `\tqueryLang=${stemmedQueries}/${sample.queries.length}` +
        `\tnDCG@10 ${mean(scores.plain).toFixed(3)} → ${mean(scores.stem).toFixed(3)}` +
        `\tR@100 ${mean(recalls.plain).toFixed(3)} → ${mean(recalls.stem).toFixed(3)}`;
      rows.push(line);
      console.log(line);
    }
  } finally {
    await app.close();
  }
  console.log(['', 'lang\tsummary', ...rows].join('\n'));
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
