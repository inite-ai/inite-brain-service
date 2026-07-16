import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { retryOnUniqueViolation } from '../db/surreal-retry';
import type { PackMarketplaceMeta } from './marketplace-meta';

interface MetaRow {
  id: unknown;
  packId: string;
  featured?: boolean;
  featuredAt?: string | null;
  paid?: boolean;
  priceCode?: string | null;
  displayPriceAmount?: number | null;
  displayPriceCurrency?: string | null;
}

/**
 * Instance-local marketplace metadata over the GLOBAL pack registry —
 * one registry_pack_meta row per packId (migration 0066) carrying
 * curation (featured) and pricing state. Same store as registry_pack
 * (the shared `system` DB via withAdminDb); NEVER mirrored — the
 * pull-only registry mirror only writes registry_pack, so a downstream
 * instance curates and prices its own catalogue.
 *
 * Absence of a row (or paid=false) means "free" — the common case pays
 * no extra read: getMetaForPacks resolves a whole catalogue page in one
 * SELECT against the packId index.
 */
@Injectable()
export class RegistryMetaService {
  private readonly logger = new Logger(RegistryMetaService.name);

  constructor(private readonly surreal: SurrealService) {}

  async getMeta(packId: string): Promise<PackMarketplaceMeta | null> {
    const map = await this.getMetaForPacks([packId]);
    return map.get(packId) ?? null;
  }

  /** Batch read for catalogue enrichment — one indexed SELECT. */
  async getMetaForPacks(
    packIds: string[],
  ): Promise<Map<string, PackMarketplaceMeta>> {
    const out = new Map<string, PackMarketplaceMeta>();
    if (packIds.length === 0) return out;
    const rows = await this.surreal.withAdminDb(async (db) => {
      const [r] = await db.query<[MetaRow[]]>(
        `SELECT packId, featured, featuredAt, paid, priceCode,
                displayPriceAmount, displayPriceCurrency
           FROM registry_pack_meta WHERE packId IN $ids`,
        { ids: packIds },
      );
      return (r as MetaRow[]) ?? [];
    });
    for (const row of rows) out.set(row.packId, this.toMeta(row));
    return out;
  }

  /** Mark a pack paid — stores the freshly minted billing priceCode and
   *  the denormalized display price. Caller (the controller) asserts
   *  publisher ownership first. */
  async setPricing(args: {
    packId: string;
    companyId: string;
    priceCode: string;
    amount: number;
    currency: string;
  }): Promise<void> {
    await this.upsert(args.packId, {
      set: `paid = true, priceCode = $priceCode,
            displayPriceAmount = $amount, displayPriceCurrency = $currency,
            pricingSetBy = $setBy`,
      params: {
        priceCode: args.priceCode,
        amount: args.amount,
        currency: args.currency,
        setBy: args.companyId,
      },
    });
    this.logger.log(
      `Pack ${args.packId} priced at ${args.amount} ${args.currency} ` +
        `(price ${args.priceCode}, by ${args.companyId})`,
    );
  }

  /** Back to free. The billing product/prices stay (immutable there) —
   *  only the registry stops gating installs on them. */
  async clearPricing(args: {
    packId: string;
    companyId: string;
  }): Promise<void> {
    await this.upsert(args.packId, {
      set: `paid = false, priceCode = NONE,
            displayPriceAmount = NONE, displayPriceCurrency = NONE,
            pricingSetBy = NONE`,
      params: {},
    });
    this.logger.log(`Pack ${args.packId} pricing cleared (by ${args.companyId})`);
  }

  /** Hosting-operator curation (registry:curate). 404s on a pack the
   *  registry has never seen — featuring nothing is a caller mistake. */
  async setFeatured(args: {
    packId: string;
    featured: boolean;
  }): Promise<void> {
    if (!(await this.packExists(args.packId))) {
      throw new NotFoundException(
        `pack "${args.packId}" not found in the registry`,
      );
    }
    await this.upsert(args.packId, {
      set: args.featured
        ? `featured = true, featuredAt = time::now()`
        : `featured = false, featuredAt = NONE`,
      params: {},
    });
    this.logger.log(
      `Pack ${args.packId} ${args.featured ? 'featured' : 'unfeatured'}`,
    );
  }

  /** Pricing is a publisher-owned surface: only the company whose key
   *  published (any version of) the pack may set/clear it. 404 when the
   *  pack is unknown, 403 when it belongs to someone else. */
  async assertPublisherOwnsPack(args: {
    packId: string;
    companyId: string;
  }): Promise<void> {
    const owned = await this.surreal.withAdminDb(async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM registry_pack
           WHERE packId = $packId AND publishedBy = $companyId LIMIT 1`,
        { packId: args.packId, companyId: args.companyId },
      );
      return ((rows as Array<{ id: unknown }>) ?? []).length > 0;
    });
    if (owned) return;
    if (!(await this.packExists(args.packId))) {
      throw new NotFoundException(
        `pack "${args.packId}" not found in the registry`,
      );
    }
    throw new ForbiddenException(
      `pack "${args.packId}" was not published by this company`,
    );
  }

  async packExists(packId: string): Promise<boolean> {
    return this.surreal.withAdminDb(async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM registry_pack WHERE packId = $packId LIMIT 1`,
        { packId },
      );
      return ((rows as Array<{ id: unknown }>) ?? []).length > 0;
    });
  }

  // ── internals ─────────────────────────────────────────────────────────

  /** Select-then-create-then-update keyed on the UNIQUE packId index;
   *  racing creators collapse via retryOnUniqueViolation (publish()
   *  mold). The bare CREATE + point-read UPDATE split keeps time::now()
   *  server-side and every option<...> field NONE until set. */
  private async upsert(
    packId: string,
    change: {
      set: string;
      params: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.surreal.withAdminDb((db) =>
      retryOnUniqueViolation(async () => {
        const [rows] = await db.query<[Array<{ id: unknown }>]>(
          `SELECT id FROM registry_pack_meta WHERE packId = $packId LIMIT 1`,
          { packId },
        );
        let id = ((rows as Array<{ id: unknown }>) ?? [])[0]?.id;
        if (!id) {
          const [created] = await db.query<[Array<{ id: unknown }>]>(
            `CREATE registry_pack_meta CONTENT { packId: $packId }`,
            { packId },
          );
          id = ((created as Array<{ id: unknown }>) ?? [])[0]?.id;
        }
        await db.query(
          `UPDATE $row SET ${change.set}, updatedAt = time::now()`,
          { row: id, ...change.params },
        );
      }),
    );
  }

  private toMeta(row: MetaRow): PackMarketplaceMeta {
    const amount = row.displayPriceAmount;
    const currency = row.displayPriceCurrency;
    return {
      packId: row.packId,
      featured: Boolean(row.featured),
      featuredAt: row.featuredAt
        ? new Date(row.featuredAt as string).toISOString()
        : null,
      paid: Boolean(row.paid),
      priceCode: row.priceCode ?? null,
      displayPrice:
        typeof amount === 'number' && currency
          ? { amount, currency }
          : null,
    };
  }
}
