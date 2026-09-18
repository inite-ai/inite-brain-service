/**
 * The conveyor, end to end, with the debug trace open.
 *
 *   BRAIN_BASE_URL=http://localhost:3112 BRAIN_API_KEY=... BRAIN_COMPANY_ID=... \
 *     pnpm eval:conveyor
 *
 * One scenario walks every declared stage of `src/conveyor` — a Russian
 * turn, an English one, a correction, a Chinese one, then retrieval and
 * synthesis in both languages, a repeat for the answer cache, an
 * abstention, and the scheduled scene + belief passes — every request
 * under `X-Brain-Debug: 1`. The report grades each declared stage by the
 * trace FOOTPRINT it is expected to leave (a span or an artifact name),
 * so "the stage exists in the code" and "the stage ran on this request"
 * stop being the same claim. A stage whose gate is off is reported as
 * off, not as missing.
 *
 * Why a live runner and not a unit spec: the joins this found broken
 * (2026-09-16 — no L0 episode on the document path, event time never
 * resolved there, the judge blind to edges, DEBUG_TRACE_PERSIST writing
 * nothing on 3.x) were all invisible to specs that fake the store or run
 * one path. They surface only when the deployed assembly runs as one.
 * The key needs brain:admin (traces are admin-scoped), and the tenant
 * should be fresh: identity checks assume these names are new.
 */
import { CONVEYORS, type Conveyor, type ConveyorStage } from '../../../src/conveyor';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const BASE = env('BRAIN_BASE_URL', 'http://localhost:3112');
const KEY = env('BRAIN_API_KEY');
const COMPANY = env('BRAIN_COMPANY_ID');
const REPORT_DIR = process.env.CONVEYOR_REPORT_DIR;
const USER = 'u-conveyor';
const CONV = `conv-${Date.now().toString(36)}`;

interface Trace {
  requestId?: string;
  spans?: Array<{ name: string; attributes?: Record<string, unknown> }>;
  artifacts?: Array<{ name: string; value: unknown }>;
}
interface Call {
  name: string;
  status: number;
  ms: number;
  body: Record<string, unknown>;
  spans: Set<string>;
  artifacts: Map<string, unknown[]>;
}

const calls: Call[] = [];

async function call(name: string, method: string, path: string, body?: unknown): Promise<Call> {
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'X-Company-Id': COMPANY,
      'Content-Type': 'application/json',
      'X-Brain-Debug': '1',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  const trace = (json.__trace ?? {}) as Trace;
  const artifacts = new Map<string, unknown[]>();
  for (const a of trace.artifacts ?? []) {
    artifacts.set(a.name, [...(artifacts.get(a.name) ?? []), a.value]);
  }
  const c: Call = {
    name,
    status: res.status,
    ms: Date.now() - t0,
    body: json,
    spans: new Set((trace.spans ?? []).map((s) => s.name)),
    artifacts,
  };
  calls.push(c);
  if (REPORT_DIR) {
    writeFileSync(join(REPORT_DIR, `${String(calls.length).padStart(2, '0')}-${name}.json`), text);
  }
  console.log(`${name.padEnd(24)} ${res.status} ${String(c.ms).padStart(6)}ms`);
  return c;
}

const ctx = (msg: string) => ({ vertical: 'chat', conversationId: CONV, messageId: msg });
const at = (minute: number) => new Date(Date.UTC(2026, 8, 16, 10, minute)).toISOString();

/**
 * The trace names each declared stage leaves behind, on either ingest
 * path. A stage lands when ANY of its names appears in ANY call.
 */
const FOOTPRINT: Record<string, string[]> = {
  // ingest
  'ingest.capture': ['ingest.episode.captured'],
  'ingest.extract': ['ingest.nlu.extract', 'indexer.run.extract'],
  'ingest.embed': ['gen_ai.embed'],
  'ingest.resolve-entities': ['ingest.entity.resolution'],
  'ingest.resolve-facts': ['ingest.fact.outcome', 'brain.commit.fact'],
  'ingest.persist-edges': ['brain.commit.edge', 'ingest.mention.result'],
  // scenes and beliefs run in the scheduled pass, not on a request; their
  // footprint is the pass's own result (checked below), so they are
  // graded from the maintenance calls' bodies rather than from a trace.
  'ingest.segment': ['maintenance.scenes'],
  'ingest.promote-beliefs': ['maintenance.beliefs'],
  // retrieval — the numbered stages of SearchService.runPipeline
  'retrieval.1': ['search.vector_leg', 'search.lexical_leg'],
  'retrieval.1c': ['search.entity_expansion'],
  'retrieval.2': ['search.query'],
  'retrieval.2a': ['search.query'],
  'retrieval.4': ['search.fact_centric'],
  'retrieval.5': ['search.edge_expansion'],
  'retrieval.6': ['search.ppr'],
  'retrieval.6b': ['search.segment_leg'],
  'retrieval.7': ['search.rerank', 'search.cross_encoder', 'search.fact_rerank'],
  'retrieval.8': ['search.fact_centric'],
  // synthesize
  'synthesize.cache': ['synthesize.answer_cache'],
  'synthesize.dispatch': ['synthesize.lane_probe', 'synthesize.instruction_probe'],
  'synthesize.guardrail': ['synthesize.guardrail'],
  'synthesize.abstain': ['synthesize.generator_prompt'],
  'synthesize.belief-lane': ['synthesize.strategy_notes'],
  'synthesize.sections': ['synthesize.facts', 'synthesize.generator_prompt'],
  'synthesize.damping': ['synthesize.generator_prompt'],
  'synthesize.generate': ['synthesize.generate', 'synthesize.generator_output'],
  'synthesize.verify': ['synthesize.verify', 'synthesize.verifier_output'],
};

/** Stages whose footprint is another stage's artifact — the report says
 *  "ran, by proxy" for these rather than claiming a trace of their own. */
const BY_PROXY = new Set([
  'retrieval.2',
  'retrieval.2a',
  'retrieval.4',
  'synthesize.abstain',
  'synthesize.damping',
  'synthesize.belief-lane',
]);

const seen = new Set<string>();
function footprintOf(stage: string): 'yes' | 'proxy' | 'no' {
  const names = FOOTPRINT[stage] ?? [];
  const hit = names.some((n) => seen.has(n));
  if (!hit) return 'no';
  return BY_PROXY.has(stage) ? 'proxy' : 'yes';
}

function gateLabel(st: ConveyorStage): string {
  return st.gate === 'always' ? 'always' : Object.values(st.gate)[0]!;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  checks.push({ name, ok, detail });
};

async function main(): Promise<void> {
  if (REPORT_DIR) mkdirSync(REPORT_DIR, { recursive: true });

  // ── ingest: four turns, three scripts, one correction ──
  const ru = await call('mention.ru', 'POST', '/v1/ingest/mention', {
    text: 'Артём Соколов — ведущий инженер в Helio Robotics. Пилотный запуск запланирован на 3 марта 2026.',
    userId: USER,
    emittedAt: at(0),
    contextRef: ctx('m1'),
  });
  const en = await call('mention.en', 'POST', '/v1/ingest/mention', {
    text: 'Artem Sokolov, lead engineer at Helio Robotics, is relocating his team to Porto.',
    userId: USER,
    emittedAt: at(1),
    contextRef: ctx('m2'),
  });
  await call('mention.en.update', 'POST', '/v1/ingest/mention', {
    text: 'Update from Artem Sokolov: the pilot launch moved to 9 April 2026.',
    userId: USER,
    emittedAt: at(2),
    contextRef: ctx('m3'),
  });
  const zh = await call('mention.zh', 'POST', '/v1/ingest/mention', {
    text: '阿尔乔姆·索科洛夫现在负责 Helio Robotics 在波尔图的团队。',
    userId: USER,
    emittedAt: at(3),
    contextRef: ctx('m4'),
  });

  // ── the scheduled passes: scenes, then beliefs ──
  const scenes = await call('maintenance.scenes', 'POST', '/v1/admin/maintenance/scenes', {
    conversationId: CONV,
  });
  const beliefs = await call(
    'maintenance.beliefs',
    'POST',
    '/v1/admin/maintenance/scenes/beliefs',
    {
      conversationId: CONV,
    },
  );

  // ── retrieval ──
  const search = await call('search.en', 'POST', '/v1/search', {
    query: 'Where does Artem Sokolov work?',
    userId: USER,
    limit: 5,
  });

  // ── synthesize: the date in Russian, twice (the second is the cache's), a place, an abstention ──
  const date1 = await call('synth.ru.date', 'POST', '/v1/synthesize', {
    query: 'Когда запланирован пилотный запуск?',
    userId: USER,
  });
  const date2 = await call('synth.ru.date.again', 'POST', '/v1/synthesize', {
    query: 'Когда запланирован пилотный запуск?',
    userId: USER,
  });
  const place = await call('synth.en.place', 'POST', '/v1/synthesize', {
    query: "Where is Artem Sokolov's team based now?",
    userId: USER,
  });
  const none = await call('synth.en.abstain', 'POST', '/v1/synthesize', {
    query: "What is Artem Sokolov's salary?",
    userId: USER,
  });

  // ── the trace plane itself ──
  const traces = await call('admin.traces', 'GET', '/v1/admin/traces');

  for (const c of calls) {
    for (const s of c.spans) seen.add(s);
    for (const a of c.artifacts.keys()) seen.add(a);
  }
  if (scenes.status < 300 && Number((scenes.body as { scenes?: number }).scenes) > 0) {
    seen.add('maintenance.scenes');
  }
  if (beliefs.status < 300) {
    const b = beliefs.body as {
      promoted?: number;
      beliefsCreated?: number;
      beliefsRevised?: number;
    };
    const n = (b.promoted ?? 0) + (b.beliefsCreated ?? 0) + (b.beliefsRevised ?? 0);
    if (n > 0) seen.add('maintenance.beliefs');
  }

  // ── joins, graded from the responses ──
  const ids = (c: Call) => (c.body.extractedEntityIds as string[] | undefined) ?? [];
  const shared = ids(ru).filter((id) => ids(en).includes(id) && ids(zh).includes(id));
  check(
    'identity: one node across Cyrillic, Latin and Han',
    shared.length >= 1,
    `shared entity ids: ${shared.join(', ') || 'none'}`,
  );
  const steps = calls.flatMap((c) =>
    (c.artifacts.get('ingest.entity.resolution') ?? []).map(
      (v) => `${(v as { name: string }).name}→${(v as { step: string }).step}`,
    ),
  );
  check('resolution ladder on the trace', steps.length > 0, steps.join(' | ') || 'no artifact');
  const judged = calls.flatMap((c) => c.artifacts.get('ingest.entity.judge') ?? []);
  check(
    'judge question and verdict on the trace',
    judged.length > 0,
    judged
      .map((v) => {
        const j = v as { name: string; verdict: string; candidate: { canonicalName?: string } };
        return `${j.name} vs ${j.candidate.canonicalName ?? '?'} → ${j.verdict}`;
      })
      .join(' | ') || 'no judge call',
  );
  const eventTimes = calls.flatMap((c) => c.artifacts.get('ingest.fact.event_time') ?? []);
  const march = eventTimes.some((v) => (v as { resolved: string }).resolved === '2026-03-03');
  check(
    'event time: "3 марта 2026" stamps 2026-03-03',
    march,
    eventTimes
      .map(
        (v) => `${(v as { predicate: string }).predicate}=${(v as { resolved: string }).resolved}`,
      )
      .join(', ') || 'no event_time artifact',
  );
  const episodes = calls.flatMap((c) => c.artifacts.get('ingest.episode.captured') ?? []);
  check(
    'capture: every turn is an episode',
    episodes.length === 4,
    `${episodes.length}/4 captured`,
  );

  const hits = (search.body.hits ?? search.body.results ?? []) as Array<{
    relations?: unknown[];
  }>;
  check(
    'retrieval: relations ride on the hit',
    hits.some((h) => (h.relations?.length ?? 0) > 0),
    `${hits.filter((h) => (h.relations?.length ?? 0) > 0).length}/${hits.length} hits carry relations`,
  );

  const answer = (c: Call) => String(c.body.answer ?? '');
  check(
    'synthesize: the correction wins (9 апреля / 9 April)',
    /9 апреля|9 April|2026-04-09/u.test(answer(date1)),
    answer(date1).slice(0, 120),
  );
  check(
    "synthesize: answer in the question's language (ru)",
    /[а-яё]/iu.test(answer(date1)),
    answer(date1).slice(0, 80),
  );
  check(
    'synthesize: Porto',
    /Porto|Порту|波尔图/u.test(answer(place)),
    answer(place).slice(0, 120),
  );
  check(
    'synthesize: abstains without evidence',
    none.body.answer === null ||
      /don't have|нет|no grounded/iu.test(answer(none)) ||
      none.body.reason !== undefined,
    `reason=${String(none.body.reason)} answer=${answer(none).slice(0, 60)}`,
  );
  const verdicts = calls.flatMap((c) =>
    (c.artifacts.get('synthesize.verifier_output') ?? []).map(
      (v) => (v as { verdict: string }).verdict,
    ),
  );
  check('verify: supported', verdicts.includes('supported'), verdicts.join(', ') || 'no verifier');
  const cacheDecisions = (date2.artifacts.get('synthesize.answer_cache') ?? []).map(
    (v) => (v as { decision: string }).decision,
  );
  check(
    'cache: the repeat is served from the answer cache',
    cacheDecisions.includes('hit'),
    `second ask: ${cacheDecisions.join(',') || 'no cache artifact'}; first ask: ${(
      date1.artifacts.get('synthesize.answer_cache') ?? []
    )
      .map((v) => (v as { decision: string }).decision)
      .join(',')}`,
  );
  const listed = (traces.body.traces as Array<{ requestId: string }> | undefined) ?? [];
  check(
    'traces: every debug request is listed for the tenant',
    listed.length >= calls.length - 1,
    `${listed.length} listed of ${calls.length - 1}`,
  );

  // ── report ──
  const lines: string[] = [];
  lines.push('# Conveyor trace report', '', `tenant ${COMPANY} · conversation ${CONV}`, '');
  for (const conv of CONVEYORS as readonly Conveyor[]) {
    lines.push(
      `## ${conv.id}`,
      '',
      '| stage | gate | trace footprint | seen |',
      '|---|---|---|---|',
    );
    for (const st of conv.stages) {
      const key = `${conv.id}.${st.step}`;
      const f = footprintOf(key);
      const mark = f === 'yes' ? '✓' : f === 'proxy' ? '~ (by proxy)' : '✗';
      lines.push(
        `| ${st.step} — ${st.title} | ${gateLabel(st)} | ${(FOOTPRINT[key] ?? []).join(', ')} | ${mark} |`,
      );
    }
    lines.push('');
  }
  lines.push('## joins', '', '| check | ok | detail |', '|---|---|---|');
  for (const c of checks)
    lines.push(`| ${c.name} | ${c.ok ? '✓' : '✗'} | ${c.detail.replace(/\|/g, '/')} |`);
  lines.push(
    '',
    '## calls',
    '',
    '| call | status | ms | spans | artifacts |',
    '|---|---|---|---|---|',
  );
  for (const c of calls) {
    lines.push(
      `| ${c.name} | ${c.status} | ${c.ms} | ${[...c.spans].join(', ')} | ${[...c.artifacts.keys()].join(', ')} |`,
    );
  }
  const report = lines.join('\n');
  console.log('\n' + report);
  if (REPORT_DIR) writeFileSync(join(REPORT_DIR, 'report.md'), report);

  const failed = checks.filter((c) => !c.ok);
  const silent = (CONVEYORS as readonly Conveyor[]).flatMap((conv) =>
    conv.stages
      .filter((st) => st.gate === 'always' && footprintOf(`${conv.id}.${st.step}`) === 'no')
      .map((st) => `${conv.id}.${st.step}`),
  );
  if (silent.length) console.log(`\nalways-on stages with no footprint: ${silent.join(', ')}`);
  if (failed.length) console.log(`\n${failed.length} join check(s) failed`);
  process.exitCode = failed.length || silent.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
