import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { join, resolve, sep } from 'node:path';
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

@Injectable()
export class BaselineService {
  private readonly logger = new Logger(BaselineService.name);
  private readonly dir = resolve(process.env.BRAIN_BASELINES_DIR ?? './var/admin/baselines');

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async list(): Promise<BaselineEntry[]> {
    await this.ensureDir();
    const names = (await fs.readdir(this.dir)).filter((n) => n.endsWith('.json'));
    const out: BaselineEntry[] = [];
    for (const file of names) {
      try {
        const raw = await fs.readFile(join(this.dir, file), 'utf-8');
        const data = JSON.parse(raw) as SavedBaseline;
        const r1 = data.outcomes.length
          ? data.outcomes.reduce((a, o) => a + (o.metrics?.recallAt1 ?? 0), 0) /
            data.outcomes.length
          : 0;
        out.push({
          name: data.name ?? file.replace(/\.json$/, ''),
          savedAt: data.savedAt,
          scenarios: data.outcomes.length,
          meanRecallAt1: r1,
        });
      } catch (e) {
        this.logger.warn(`Skipping baseline ${file}: ${(e as Error).message}`);
      }
    }
    return out.sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''));
  }

  /**
   * Resolve a baseline name to an absolute path *inside* {@link dir}.
   * `name` is caller-supplied (admin HTTP query), so besides the char
   * sanitiser we assert the resolved path can't escape the baselines dir —
   * a recognised path-traversal barrier and defence-in-depth if the
   * sanitiser ever regresses.
   */
  private pathFor(name: string): string {
    const safe = sanitize(name);
    const full = resolve(this.dir, `${safe}.json`);
    if (full !== join(this.dir, `${safe}.json`) || !full.startsWith(this.dir + sep)) {
      throw new BadRequestException(`Invalid baseline name`);
    }
    return full;
  }

  async save(name: string, outcomes: ScenarioRunOutcome[]): Promise<BaselineEntry> {
    await this.ensureDir();
    const safe = sanitize(name);
    const target = this.pathFor(name);
    const payload: SavedBaseline = {
      name: safe,
      savedAt: new Date().toISOString(),
      outcomes,
    };
    await fs.writeFile(target, JSON.stringify(payload, null, 2), 'utf-8');
    return {
      name: safe,
      savedAt: payload.savedAt,
      scenarios: outcomes.length,
      meanRecallAt1: outcomes.length
        ? outcomes.reduce((a, o) => a + (o.metrics?.recallAt1 ?? 0), 0) / outcomes.length
        : 0,
    };
  }

  async load(name: string): Promise<SavedBaseline> {
    await this.ensureDir();
    const path = this.pathFor(name);
    try {
      const raw = await fs.readFile(path, 'utf-8');
      return JSON.parse(raw) as SavedBaseline;
    } catch {
      throw new NotFoundException(`Baseline ${sanitize(name)} not found`);
    }
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

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}
