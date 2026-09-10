import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SurrealService, queryFirst, queryRows } from '../db/surreal.service';
import type { ScenarioRunOutcome } from './scenario-runner.service';

export interface BaselineEntry {
  name: string;
  savedAt: string;
  scenarios: number;
  meanRecallAt1: number;
}

export interface SavedBaseline {
  name: string;
  savedAt: string;
  outcomes: ScenarioRunOutcome[];
}

export interface BaselineDiffMetric {
  scenarioId: string;
  metric: 'recallAt1' | 'recallAt5';
  baseline: number;
  current: number;
  delta: number;
  /** 'regression' when current dropped beyond tolerance, 'improved' when better, 'stable' otherwise. */
  verdict: 'regression' | 'improved' | 'stable';
}

const TOLERANCE = 0.03; // 3 percentage points — matches scripts/eval-baseline-diff.ts

/** admin_baseline row as SELECTed; `outcomes` is the JSON-encoded payload. */
interface BaselineRow {
  name: string;
  savedAt: string | Date;
  scenarios?: number;
  meanRecallAt1?: number;
  outcomes?: string;
}

/**
 * Eval baselines, kept in the system database (`admin_baseline`, 0140)
 * so every replica saves, lists and diffs the same set. A baseline is
 * an operator artifact, not tenant data: any brain:admin sees all of
 * them, as before. Nothing is migrated from the pre-0140 `var/`
 * files — they were runtime artifacts of one process.
 */
@Injectable()
export class BaselineService {
  constructor(private readonly surreal: SurrealService) {}

  async list(): Promise<BaselineEntry[]> {
    const rows = await this.surreal.withAdminDb((db) =>
      queryRows<BaselineRow>(
        db,
        `SELECT name, savedAt, scenarios, meanRecallAt1
           FROM admin_baseline ORDER BY savedAt DESC`,
      ),
    );
    return rows.map((r) => ({
      name: r.name,
      savedAt: iso(r.savedAt),
      scenarios: r.scenarios ?? 0,
      meanRecallAt1: r.meanRecallAt1 ?? 0,
    }));
  }

  /** Upsert by name — saving the same name again replaces the baseline. */
  async save(name: string, outcomes: ScenarioRunOutcome[]): Promise<BaselineEntry> {
    const safe = safeName(name);
    const savedAt = new Date();
    const entry: BaselineEntry = {
      name: safe,
      savedAt: savedAt.toISOString(),
      scenarios: outcomes.length,
      meanRecallAt1: meanRecallAt1(outcomes),
    };
    await this.surreal.withAdminDb((db) =>
      db.query(
        `UPSERT type::record('admin_baseline', $name) CONTENT {
           name: $name,
           savedAt: $savedAt,
           scenarios: $scenarios,
           meanRecallAt1: $meanRecallAt1,
           outcomes: $outcomes
         }`,
        {
          name: safe,
          savedAt,
          scenarios: entry.scenarios,
          meanRecallAt1: entry.meanRecallAt1,
          outcomes: JSON.stringify(outcomes),
        },
      ),
    );
    return entry;
  }

  async load(name: string): Promise<SavedBaseline> {
    const safe = safeName(name);
    const row = await this.surreal.withAdminDb((db) =>
      queryFirst<BaselineRow>(
        db,
        `SELECT name, savedAt, outcomes FROM admin_baseline WHERE name = $name LIMIT 1`,
        { name: safe },
      ),
    );
    if (!row?.outcomes) throw new NotFoundException(`Baseline ${safe} not found`);
    return {
      name: row.name,
      savedAt: iso(row.savedAt),
      outcomes: JSON.parse(row.outcomes) as ScenarioRunOutcome[],
    };
  }

  async diff(
    name: string,
    current: ScenarioRunOutcome[],
  ): Promise<{ baseline: string; entries: BaselineDiffMetric[] }> {
    const baseline = await this.load(name);
    const byId = new Map<string, ScenarioRunOutcome>();
    for (const o of baseline.outcomes) byId.set(o.scenarioId, o);

    const entries: BaselineDiffMetric[] = [];
    for (const cur of current) {
      const base = byId.get(cur.scenarioId);
      if (!base) continue;
      for (const metric of ['recallAt1', 'recallAt5'] as const) {
        const baseVal = base.metrics?.[metric] ?? 0;
        const curVal = cur.metrics?.[metric] ?? 0;
        const delta = curVal - baseVal;
        let verdict: BaselineDiffMetric['verdict'] = 'stable';
        if (delta < -TOLERANCE) verdict = 'regression';
        else if (delta > TOLERANCE) verdict = 'improved';
        entries.push({
          scenarioId: cur.scenarioId,
          metric,
          baseline: baseVal,
          current: curVal,
          delta,
          verdict,
        });
      }
    }
    return { baseline: baseline.name, entries };
  }
}

/** Caller-supplied (admin HTTP param): restrict to a plain identifier. */
function safeName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  // A name that survives sanitising as separators alone identifies nothing.
  if (!/[a-zA-Z0-9]/.test(safe)) throw new BadRequestException('Invalid baseline name');
  return safe;
}

function meanRecallAt1(outcomes: ScenarioRunOutcome[]): number {
  if (!outcomes.length) return 0;
  return outcomes.reduce((a, o) => a + (o.metrics?.recallAt1 ?? 0), 0) / outcomes.length;
}

function iso(v: string | Date): string {
  return typeof v === 'string' ? v : new Date(v).toISOString();
}
