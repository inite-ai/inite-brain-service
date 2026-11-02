/**
 * Community-evidence battery (#876). Keyless: the real app against a real
 * SurrealDB, the production embedder (bge-m3, local ONNX) and the
 * production noise filter (local cross-encoder); no paid model.
 *
 * dataset.json is a multi-topic tenant: community summaries as the
 * dreams pass would persist them (written by the harness agent, as
 * harness mode does), their member entities and edges, and questions
 * labelled thematic (gold communities) or factoid (no community). Each
 * question goes through the production router and EvidenceCollector, so
 * what is scored is what the generator would see.
 *
 * Scores (rule fixed before measuring, see dataset.json `_doc`):
 *   - thematic served: routed to the summary lane AND a gold community
 *     among the insight lines ('*' = any community);
 *   - factoid cost: community lines (and their characters) a factoid
 *     question pulls into the prompt;
 *   - stale: a community whose members gained an edge after its build
 *     never serves.
 *
 * Run: SURREALDB_URL=ws://… pnpm eval:community-evidence [--json]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../../../src/app.module';
import { ExtractorService } from '../../../src/ai/extractor.service';
import { EmbedderService } from '../../../src/ai/embedder.service';
import { LocalCrossEncoderProvider } from '../../../src/ai/cross-encoder/local-cross-encoder.provider';
import { SurrealService } from '../../../src/db/surreal.service';
import { TenantRegistryService } from '../../../src/auth/tenant-registry.service';
import { resolveRetrievalProfile } from '../../../src/search/retrieval-profile';
import { resolveRoutedLane } from '../../../src/synthesize/synthesize.helpers';
import { EvidenceCollectorService } from '../../../src/synthesize/evidence-collector.service';
import { MultilingualLaneClassifierService } from '../../../src/synthesize/multilingual-lane-classifier.service';
import { StubExtractor } from '../../test-doubles';

interface Community {
  key: string;
  label: string;
  members: string[];
  summary: string;
  /** Two members joined by an edge created after the build. */
  staleEdge?: [string, string];
}
interface Question {
  q: string;
  lang: string;
  kind: 'thematic' | 'factoid';
  gold: string[];
  stale?: string;
}

const HEADER = 'Topic overview — ';

function stubEnvironment(): void {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
  process.env.EMBEDDER_PROVIDER = 'bge-m3';
  process.env.THROTTLE_DISABLED = '1';
  process.env.CAPABILITY_PROBE_ENABLED = '0';
  process.env.BRAIN_API_KEYS = '[]';
  process.env.DREAMS_ENABLED = '0';
  // ts-node cannot hand a .ts worker file to worker_threads; the battery
  // measures what the models return, not where they run.
  process.env.BGE_M3_WORKER = '0';
  process.env.SEARCH_CROSS_ENCODER_LOCAL_WORKER = '0';
  process.env.CHAT_ROUTE_NLI_WORKER = '0';
}

async function seed(db: Surreal, embedder: EmbedderService, communities: Community[]) {
  const builtAt = new Date(Date.now() - 86_400_000);
  const edgeAt = new Date(builtAt.getTime() - 3_600_000);
  const entityId = new Map<string, unknown>();
  for (const c of communities) {
    for (const name of c.members) {
      const [row] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE knowledge_entity CONTENT { type: 'topic', canonicalName: $name }`,
        { name },
      );
      entityId.set(name, row![0]!.id);
    }
    // A chain through the members: the shape label propagation clusters.
    for (let i = 1; i < c.members.length; i++) {
      await db.query(
        `RELATE $a->knowledge_edge->$b CONTENT { kind: 'related_to', weight: 1.0, createdAt: $at, source: {} }`,
        { a: entityId.get(c.members[i - 1]!), b: entityId.get(c.members[i]!), at: edgeAt },
      );
    }
    const summaryEmbedding = await embedder.embedForWrite(c.summary);
    const [node] = await db.query<[Array<{ id: unknown }>]>(
      `CREATE community_node CONTENT {
         label: $label, summary: $summary, summaryEmbedding: $emb,
         memberCount: $n, builtAt: $built, lastBuiltAt: $built, lastBuiltMaxEdgeAt: $edgeAt
       }`,
      {
        label: c.label,
        summary: c.summary,
        emb: summaryEmbedding,
        n: c.members.length,
        built: builtAt,
        edgeAt,
      },
    );
    for (const name of c.members) {
      await db.query(`RELATE $c->community_member->$e`, {
        c: node![0]!.id,
        e: entityId.get(name),
      });
    }
    if (c.staleEdge) {
      await db.query(
        `RELATE $a->knowledge_edge->$b CONTENT { kind: 'related_to', weight: 1.0, createdAt: time::now(), source: {} }`,
        { a: entityId.get(c.staleEdge[0]), b: entityId.get(c.staleEdge[1]) },
      );
    }
  }
}

async function main(): Promise<void> {
  stubEnvironment();
  const { communities, questions } = JSON.parse(
    readFileSync(join(__dirname, 'dataset.json'), 'utf8'),
  ) as { communities: Community[]; questions: Question[] };
  const labelOf = new Map(communities.map((c) => [c.label, c.key]));
  const companyId = `co_comm_battery_${randomUUID().slice(0, 8)}`;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ExtractorService)
    .useValue(new StubExtractor())
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  try {
    await app.get(TenantRegistryService).register(companyId);
    const surreal = app.get(SurrealService);
    const embedder = app.get(EmbedderService);
    // The local models warm in the background; the battery measures them warm.
    const crossEncoder = app.get(LocalCrossEncoderProvider);
    await crossEncoder.warmup();
    for (let i = 0; !embedder.warmupStatus().ready || !crossEncoder.isReady(); i++) {
      if (i > 900) throw new Error('local models never warmed');
      await new Promise((r) => setTimeout(r, 1000));
    }
    await surreal.withCompany(companyId, (db) => seed(db, embedder, communities));
    const collector = app.get(EvidenceCollectorService);
    const classifier = app.get(MultilingualLaneClassifierService);
    const profile = resolveRetrievalProfile(process.env);

    const rows: Array<Record<string, unknown>> = [];
    for (const item of questions) {
      const lane = await resolveRoutedLane(profile, item.q, classifier);
      const evidence = await collector.collect({
        profile,
        lane,
        companyId,
        query: item.q,
        callerScopes: [],
        factIds: [],
        evidence: [],
      });
      const served = evidence.insightLines
        .filter((l) => l.startsWith(HEADER))
        .map((l) => labelOf.get(l.slice(HEADER.length, l.indexOf(' (built'))) ?? '?');
      const chars = evidence.insightLines
        .filter((l) => l.startsWith(HEADER))
        .reduce((n, l) => n + l.length, 0);
      const hit = item.gold.includes('*')
        ? served.length > 0
        : served.some((k) => item.gold.includes(k));
      rows.push({
        q: item.q,
        lang: item.lang,
        kind: item.kind,
        lane,
        served,
        chars,
        ok:
          item.kind === 'factoid'
            ? served.length === 0
            : item.stale
              ? !served.includes(item.stale)
              : hit,
      });
    }

    const of = (kind: string) =>
      rows.filter((r) => r.kind === kind && !questions.find((q) => q.q === r.q)?.stale);
    const thematic = of('thematic');
    const factoid = of('factoid');
    const stale = rows.filter((r) => questions.find((q) => q.q === r.q)?.stale);
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      for (const r of rows) {
        console.log(
          `${r.ok ? '✓' : '✗'} [${String(r.lang)}/${String(r.kind)}] lane=${String(r.lane)} served=${JSON.stringify(r.served)} — ${String(r.q)}`,
        );
      }
      const routed = thematic.filter((r) => r.lane === 'summary').length;
      console.log(
        `thematic served ${thematic.filter((r) => r.ok).length}/${thematic.length} (routed to summary ${routed}/${thematic.length})`,
      );
      for (const lang of [...new Set(thematic.map((r) => String(r.lang)))].sort()) {
        const l = thematic.filter((r) => r.lang === lang);
        console.log(`  ${lang}: ${l.filter((r) => r.ok).length}/${l.length}`);
      }
      console.log(
        `factoid with community lines ${factoid.filter((r) => !r.ok).length}/${factoid.length}, ` +
          `${factoid.reduce((n, r) => n + Number(r.chars), 0)} chars added in total`,
      );
      console.log(`stale community skipped ${stale.filter((r) => r.ok).length}/${stale.length}`);
    }
  } finally {
    await app.close();
    await dropTenant(companyId);
  }
}

async function dropTenant(companyId: string): Promise<void> {
  const http = (process.env.SURREALDB_URL ?? '').replace(/^ws/, 'http').replace(/\/rpc$/, '');
  const auth = Buffer.from(
    `${process.env.SURREALDB_USERNAME ?? 'root'}:${process.env.SURREALDB_PASSWORD ?? 'root'}`,
  ).toString('base64');
  const sql = (db: string, statement: string) =>
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

void main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
