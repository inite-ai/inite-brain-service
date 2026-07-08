import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { ExtractorService } from '../ai/extractor.service';
import {
  BUILTIN_PACKS,
  scoreFixture,
  type DomainPackManifest,
  type PackEvalReport,
} from '../ai/domain-packs';

/**
 * Runs a Domain Pack's eval fixtures against the LIVE extractor for a tenant
 * (docs/domain-packs.md). Consumes the manifest's `evalFixtures` — the same
 * manifest that's already stored per-tenant (installed packs) or shipped
 * (builtins). Each fixture's input text is run through the extractor (with the
 * pack's predicates + extractionProfile active for the tenant) and scored
 * against its expectations. Mirrors the extractionProfile wiring.
 */
/** Hard ceiling on fixtures run per eval request. Each fixture is one live
 *  extractor (LLM) call, so an installed pack shipping thousands of fixtures
 *  would turn a single request into thousands of paid calls. Cap + log the
 *  overflow (no silent truncation) — the route is also @Throttle({expensive}). */
const MAX_EVAL_FIXTURES = 50;

@Injectable()
export class PackEvalService {
  private readonly logger = new Logger(PackEvalService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly extractor: ExtractorService,
  ) {}

  async run(companyId: string, packId: string): Promise<PackEvalReport> {
    const manifest = await this.resolveManifest(companyId, packId);
    if (!manifest) {
      throw new NotFoundException(
        `pack "${packId}" is not a builtin and is not installed for this tenant`,
      );
    }
    const declared = manifest.evalFixtures ?? [];
    const fixtures = declared.slice(0, MAX_EVAL_FIXTURES);
    if (declared.length > fixtures.length) {
      this.logger.warn(
        `pack eval ${manifest.id}: ${declared.length} fixtures declared, running first ${fixtures.length} (MAX_EVAL_FIXTURES cap)`,
      );
    }
    const results = [];
    for (const fixture of fixtures) {
      const extraction = await this.extractor.extract(fixture.text, companyId);
      results.push(scoreFixture(manifest.id, fixture, extraction));
    }
    const passed = results.filter((r) => r.passed).length;
    this.logger.log(
      `pack eval ${manifest.id} v${manifest.version} for ${companyId}: ${passed}/${results.length} passed`,
    );
    return {
      packId: manifest.id,
      version: manifest.version,
      total: results.length,
      passed,
      results,
    };
  }

  /** Builtin packs ship their manifest in-process; installed packs store it in
   *  domain_pack. Prefer the builtin (globally seeded) then the tenant's row. */
  private async resolveManifest(
    companyId: string,
    packId: string,
  ): Promise<DomainPackManifest | null> {
    const builtin = BUILTIN_PACKS.find((p) => p.id === packId);
    if (builtin) return builtin;
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[Array<{ manifest?: DomainPackManifest }>]>(
        `SELECT manifest FROM domain_pack WHERE packId = $packId AND status = 'active' LIMIT 1`,
        { packId },
      );
      const row = ((rows as Array<{ manifest?: DomainPackManifest }>) ?? [])[0];
      return row?.manifest ?? null;
    });
  }
}
