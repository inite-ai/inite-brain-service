import { Injectable, Logger } from '@nestjs/common';
import { FactsService } from '../facts/facts.service';
import { EntitiesService } from '../entities/entities.service';
import { SurrealService } from '../db/surreal.service';
import type { SetupRetractStep, SetupForgetStep } from '../eval/types';
import { safe } from './scenario-runner-utils';

/**
 * Lifecycle phase of a scenario run: the destructive setup steps
 * (retract / forget), the externalRef→entityId lookup that forget needs, and
 * the ephemeral-tenant teardown. Grouped because all three are
 * mutation/cleanup concerns sharing the FactsService / EntitiesService /
 * SurrealService deps.
 */
@Injectable()
export class ScenarioLifecycleService {
  private readonly logger = new Logger(ScenarioLifecycleService.name);

  constructor(
    private readonly facts: FactsService,
    private readonly entities: EntitiesService,
    private readonly surreal: SurrealService,
  ) {}

  async applyRetract(
    companyId: string,
    p: { step: SetupRetractStep; factId: string | undefined },
  ): Promise<void> {
    if (!p.factId) {
      throw new Error(`Retract references unknown tag '${p.step.tag}'`);
    }
    await this.facts.retract({
      companyId,
      factId: p.factId,
      dto: {
        reason: p.step.reason,
        retractedBy: { source: 'system' },
      },
    });
  }

  async applyForget(companyId: string, step: SetupForgetStep): Promise<void> {
    // Resolve entityId via entity_external_ref (lightweight — sufficient at
    // the eval scale).
    const refKey = `${safe(step.entityRef.vertical)}__${safe(step.entityRef.id)}`;
    const hit = await this.findEntityByExternalRef(companyId, refKey);
    if (!hit) {
      throw new Error(`Forget could not resolve ${refKey}`);
    }
    await this.entities.forget({
      companyId,
      entityIdRaw: hit,
      dto: {
        reason: step.reason,
        requestId: step.requestId,
      },
    });
  }

  /**
   * Drop the ephemeral tenant DB after a run. Best-effort: a failure is logged
   * but never propagated, so a teardown hiccup can't mask the run outcome.
   */
  async dropTenant(companyId: string): Promise<void> {
    try {
      await this.surreal.dropCompanyDatabase(companyId);
    } catch (e) {
      this.logger.warn(
        `Could not drop ephemeral tenant ${companyId}: ${(e as Error).message}`,
      );
    }
  }

  private async findEntityByExternalRef(
    companyId: string,
    refKey: string,
  ): Promise<string | null> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT VALUE entity FROM entity_external_ref WHERE key = $key LIMIT 1`,
        { key: refKey },
      );
      const arr = (rows as any[]) ?? [];
      return arr[0] ? String(arr[0]) : null;
    });
  }
}
