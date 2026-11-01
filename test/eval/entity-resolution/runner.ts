/**
 * Entity-resolution battery. Mechanical and free: the real naming ladder
 * (EntityUpsertService.resolveOrCreateNamedEntity — hint, known, exact,
 * article-variant, translit, code-alias, judge, created) and the real fact
 * write path, against a real SurrealDB; no paid model.
 *
 * dataset.json is a labelled mention stream (README). Each mention is
 * resolved, then its facts are written to the entity it landed on, so later
 * mentions are judged against them, as on the live write path.
 *
 * Two judge modes, both explicit:
 *   - off     the judge is unavailable (harness mode / no key): what the
 *             deterministic ladder settles alone;
 *   - oracle  the judge answers from the gold labels for whatever
 *             candidate the ladder hands it: the ceiling a perfect judge
 *             reaches, i.e. how far candidate generation lets it go. It
 *             never sees a pair the ladder did not surface.
 *
 * Embeddings are the e2e StubEmbedder (deterministic, meaningless as
 * similarity), so the embedding scan finds nothing real; the transliterated
 * key scan, which is string-based, runs as in production.
 *
 * Run: SURREALDB_URL=ws://… pnpm eval:entity-resolution [--judge=off|oracle] [--json]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../../../src/app.module';
import { EmbedderService } from '../../../src/ai/embedder.service';
import { ExtractorService } from '../../../src/ai/extractor.service';
import { LocalCrossEncoderProvider } from '../../../src/ai/cross-encoder/local-cross-encoder.provider';
import {
  EntityJudgeService,
  type EntityVerdict,
  type JudgeContext,
} from '../../../src/ai/entity-judge.service';
import { SurrealService } from '../../../src/db/surreal.service';
import { TenantRegistryService } from '../../../src/auth/tenant-registry.service';
import { EntityUpsertService } from '../../../src/ingest/entity-upsert.service';
import { FactIngestService } from '../../../src/ingest/fact-ingest.service';
import { PredicateRegistryService } from '../../../src/ai/predicate-registry.service';
import type { FactCardinality } from '../../../src/ai/extractor-internals/types';
import { StubEmbedder, StubExtractor, StubLocalCrossEncoder } from '../../test-doubles';
import { score, type Assignment, type Score } from './score';

interface DatasetMention {
  id: string;
  cluster: string;
  category: string;
  name: string;
  canonical?: string;
  type: string;
  facts: string[];
}

type JudgeMode = 'off' | 'oracle';

/**
 * The judge for the battery: unavailable (`off`), or answering from the gold
 * labels (`oracle`). The ladder calls fetchTopFacts for a candidate and then
 * judge() for it, in that order, so the candidate in question is the last
 * one fetched.
 */
class BatteryJudge extends EntityJudgeService {
  current = '';
  readonly entityClusters = new Map<string, Set<string>>();
  private lastFetched = '';

  constructor(
    config: ConfigService,
    private readonly mode: JudgeMode,
  ) {
    super(config);
  }

  override isAvailable(): boolean {
    return this.mode === 'oracle';
  }

  override async fetchTopFacts(
    db: Surreal,
    entityId: string,
    fence?: { userId: string | undefined },
  ): Promise<string> {
    this.lastFetched = entityId;
    return super.fetchTopFacts(db, entityId, fence);
  }

  override judge(_left: string, _right: string, _ctx: JudgeContext = {}): Promise<EntityVerdict> {
    const holds = this.entityClusters.get(this.lastFetched);
    return Promise.resolve(holds?.has(this.current) ? 'same' : 'different');
  }
}

function stubEnvironment(): void {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
  process.env.THROTTLE_DISABLED = '1';
  process.env.CHAT_ROUTE_NLI_ENABLED = 'false';
  process.env.CAPABILITY_PROBE_ENABLED = '0';
  process.env.BRAIN_API_KEYS = '[]';
}

async function dropTenant(companyId: string): Promise<void> {
  const ws = process.env.SURREALDB_URL ?? '';
  const http = ws.replace(/^ws/, 'http').replace(/\/rpc$/, '');
  const auth = Buffer.from(
    `${process.env.SURREALDB_USERNAME ?? 'root'}:${process.env.SURREALDB_PASSWORD ?? 'root'}`,
  ).toString('base64');
  const sql = async (db: string, statement: string) =>
    fetch(`${http}/sql`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${auth}`,
        'surreal-ns': process.env.SURREALDB_NAMESPACE ?? 'brain',
        'surreal-db': db,
      },
      body: statement,
    }).catch(() => undefined);
  await sql('system', `DELETE tenant_registry WHERE companyId = '${companyId}';`);
  await sql('system', `REMOVE DATABASE IF EXISTS co_${companyId};`);
}

/** The extractor's per-predicate cardinality reading (dataset.json `cardinality`). */
type CardinalityReading = Record<string, FactCardinality>;

async function runMode(
  mode: JudgeMode,
  mentions: DatasetMention[],
  cardinality: CardinalityReading,
): Promise<Score> {
  const companyId = `co_er_battery_${mode}_${randomUUID().slice(0, 8)}`;
  let judge: BatteryJudge | undefined;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EmbedderService)
    .useValue(new StubEmbedder())
    .overrideProvider(ExtractorService)
    .useValue(new StubExtractor())
    .overrideProvider(LocalCrossEncoderProvider)
    .useValue(new StubLocalCrossEncoder())
    .overrideProvider(EntityJudgeService)
    .useFactory({
      factory: (config: ConfigService) => (judge = new BatteryJudge(config, mode)),
      inject: [ConfigService],
    })
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  try {
    await app.get(TenantRegistryService).register(companyId);
    const surreal = app.get(SurrealService);
    const upsert = app.get(EntityUpsertService);
    const facts = app.get(FactIngestService);
    const registry = app.get(PredicateRegistryService);
    const assignments: Assignment[] = [];
    for (const m of mentions) {
      if (judge) judge.current = m.cluster;
      // The real write path canonicalizes each coinage with the extractor's
      // cardinality reading BEFORE entity resolution runs; so does the battery.
      for (const line of m.facts) {
        const predicate = line.slice(0, line.indexOf(':')).trim();
        await registry.canonicalize(companyId, predicate, {
          text: line,
          cardinality: cardinality[predicate],
        });
      }
      let rung = 'unknown';
      const entityId = await surreal.withCompany(companyId, (db) =>
        upsert.resolveOrCreateNamedEntity({
          db,
          e: { name: m.name, type: m.type, ...(m.canonical ? { canonical: m.canonical } : {}) },
          hint: undefined,
          _contextRef: { vertical: 'eval' },
          incomingFacts: m.facts,
          onStep: (step) => (rung = step),
        }),
      );
      assignments.push({ mentionId: m.id, entityId, rung });
      process.stderr.write(
        `[er] ${mode} ${assignments.length}/${mentions.length} ${m.id} ${rung}\n`,
      );
      if (judge) {
        const held = judge.entityClusters.get(entityId) ?? new Set<string>();
        judge.entityClusters.set(entityId, held.add(m.cluster));
      }
      for (const line of m.facts) {
        const at = line.indexOf(':');
        await facts.ingestFact(companyId, {
          entityRef: { entityId },
          predicate: line.slice(0, at).trim(),
          object: line.slice(at + 1).trim(),
          validFrom: new Date().toISOString(),
          confidence: 0.9,
          source: { vertical: 'eval', messageId: m.id },
        } as Parameters<FactIngestService['ingestFact']>[1]);
      }
    }
    return score(mentions, assignments);
  } finally {
    await app.close();
    await dropTenant(companyId);
  }
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

function render(mode: JudgeMode, s: Score): string {
  const lines = [
    `judge=${mode}`,
    `  pairwise   P ${pct(s.pairwise.precision)}  R ${pct(s.pairwise.recall)}  F1 ${pct(s.pairwise.f1)}` +
      `  (${s.pairwise.correctPairs}/${s.pairwise.predictedPairs} predicted, ${s.pairwise.truePairs} true)`,
    `  B³         P ${pct(s.bcubed.precision)}  R ${pct(s.bcubed.recall)}  F1 ${pct(s.bcubed.f1)}`,
    `  auto-merge precision ${pct(s.autoMerge.precision)} (${s.autoMerge.correct}/${s.autoMerge.attached})`,
    `  links ${s.escalation.links}: ladder ${s.escalation.settledByLadder}, judge ${s.escalation.byJudge}, missed ${s.escalation.missed}`,
    `  rungs ${Object.entries(s.rungs)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
    '  category              links joined falseMerges',
    ...s.categories.map(
      (c) =>
        `  ${c.category.padEnd(21)} ${String(c.links).padStart(5)} ${String(c.joined).padStart(6)} ${String(c.falseMerges).padStart(11)}`,
    ),
    ...s.falseMerges.map(
      (f) => `  FALSE MERGE ${f.mentionId} onto [${f.entityHolds.join(', ')}] via ${f.rung}`,
    ),
    ...s.missedLinks.map((f) => `  missed ${f.mentionId} (${f.category}) → ${f.rung}`),
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  if (!process.env.SURREALDB_URL) throw new Error('SURREALDB_URL is required');
  stubEnvironment();
  const data = JSON.parse(readFileSync(join(__dirname, 'dataset.json'), 'utf8')) as {
    mentions: DatasetMention[];
    cardinality: CardinalityReading & { _doc?: string };
  };
  const { _doc, ...cardinality } = data.cardinality;
  const arg = process.argv.find((a) => a.startsWith('--judge='))?.slice('--judge='.length);
  const modes: JudgeMode[] = arg === 'off' || arg === 'oracle' ? [arg] : ['off', 'oracle'];
  const results: Record<string, Score> = {};
  for (const mode of modes) results[mode] = await runMode(mode, data.mentions, cardinality);
  if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
  else for (const mode of modes) console.log(render(mode, results[mode]!));
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
