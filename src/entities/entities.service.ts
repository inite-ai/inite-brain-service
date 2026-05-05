import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { Surreal } from 'surrealdb';
import { SurrealService, dbCreate } from '../db/surreal.service';
import { ForgetEntityDto } from './dto/forget.dto';
import { policyFor, PREDICATE_POLICIES } from '../ingest/conflict-resolver';
import { BrainScope } from '../auth/api-key.types';

export interface EntityProfile {
  entityId: string;
  type: string;
  canonicalName: string;
  externalRefs: Record<string, string>;
  facts: Array<{
    factId: string;
    predicate: string;
    object: string;
    confidence: number;
    validFrom: string;
    validUntil?: string;
    status: string;
  }>;
}

export interface ForgetResult {
  entityIdHash: string;
  factsDeleted: number;
  edgesDeleted: number;
  forgottenAt: string;
}

@Injectable()
export class EntitiesService {
  private readonly logger = new Logger(EntitiesService.name);
  private readonly forgetHmacKey: string;

  constructor(
    private readonly surreal: SurrealService,
    private readonly configService: ConfigService,
  ) {
    // Used to hash forgotten entity ids in the tombstone. If unset, derive
    // a per-process default — safe enough for 0.1.0 walking skeleton, but
    // production deployments MUST set this so tombstones survive restart.
    this.forgetHmacKey =
      this.configService.get<string>('FORGET_HMAC_KEY') ?? 'inite-brain-default';
  }

  async getProfile(
    companyId: string,
    entityIdRaw: string,
    asOfRaw: string | undefined,
    scopes: BrainScope[],
  ): Promise<EntityProfile> {
    const ref = this.normalizeEntityId(entityIdRaw);
    const asOf = asOfRaw ? new Date(asOfRaw) : null;

    return this.surreal.withCompany(companyId, async (db) => {
      const [entRows] = await db.query<any[][]>(
        `SELECT id, type, canonicalName, externalRefs FROM type::thing('knowledge_entity', $rid) LIMIT 1`,
        { rid: ref.id },
      );
      const entity = (entRows as any[])?.[0];
      if (!entity) {
        throw new NotFoundException(`Entity ${entityIdRaw} not found`);
      }

      const [factRows] = await db.query<any[][]>(
        `SELECT id, predicate, object, confidence, validFrom, validUntil,
                recordedAt, retractedAt, status
         FROM knowledge_fact
         WHERE entityId = type::thing('knowledge_entity', $rid)
           AND retractedAt IS NONE
         ORDER BY recordedAt DESC
         LIMIT 100`,
        { rid: ref.id },
      );
      const facts = ((factRows as any[]) ?? []).filter((f) => {
        if (asOf) {
          if (new Date(f.recordedAt) > asOf) return false;
          if (new Date(f.validFrom) > asOf) return false;
          if (f.validUntil && new Date(f.validUntil) <= asOf) return false;
        }
        const policy = policyFor(f.predicate);
        if (policy.requiresScope && !scopes.includes(policy.requiresScope)) {
          return false;
        }
        return true;
      });

      return {
        entityId: String(entity.id),
        type: entity.type,
        canonicalName: entity.canonicalName,
        externalRefs: entity.externalRefs ?? {},
        facts: facts.map((f) => ({
          factId: String(f.id),
          predicate: f.predicate,
          object: f.object,
          confidence: f.confidence,
          validFrom: new Date(f.validFrom).toISOString(),
          validUntil: f.validUntil ? new Date(f.validUntil).toISOString() : undefined,
          status: f.status,
        })),
      };
    });
  }

  async getTimeline(
    companyId: string,
    entityIdRaw: string,
    sinceRaw: string | undefined,
    untilRaw: string | undefined,
    scopes: BrainScope[],
  ): Promise<{ entityId: string; events: any[] }> {
    const ref = this.normalizeEntityId(entityIdRaw);
    const since = sinceRaw ? new Date(sinceRaw) : null;
    const until = untilRaw ? new Date(untilRaw) : null;

    return this.surreal.withCompany(companyId, async (db) => {
      const [factRows] = await db.query<any[][]>(
        `SELECT id, predicate, object, confidence, validFrom, validUntil,
                recordedAt, retractedAt, retractedBy, retractionReason,
                supersededBy, source, status
         FROM knowledge_fact
         WHERE entityId = type::thing('knowledge_entity', $rid)
         ORDER BY recordedAt ASC`,
        { rid: ref.id },
      );
      const rows = ((factRows as any[]) ?? []).filter((f) => {
        if (since && new Date(f.recordedAt) < since) return false;
        if (until && new Date(f.recordedAt) > until) return false;
        const policy = policyFor(f.predicate);
        if (policy.requiresScope && !scopes.includes(policy.requiresScope)) {
          return false;
        }
        return true;
      });

      const events: any[] = [];
      for (const f of rows) {
        events.push({
          type: 'fact.recorded',
          at: new Date(f.recordedAt).toISOString(),
          factId: String(f.id),
          predicate: f.predicate,
          object: f.object,
          source: f.source,
          confidence: f.confidence,
        });
        if (f.retractedAt) {
          events.push({
            type: 'fact.retracted',
            at: new Date(f.retractedAt).toISOString(),
            factId: String(f.id),
            retractedBy: f.retractedBy,
            reason: f.retractionReason,
            supersededBy: f.supersededBy ? String(f.supersededBy) : undefined,
          });
        }
      }
      events.sort((a, b) => a.at.localeCompare(b.at));

      return { entityId: ref.full, events };
    });
  }

  async getConnections(
    companyId: string,
    entityIdRaw: string,
    kind: string | undefined,
  ): Promise<{ entityId: string; edges: any[] }> {
    const ref = this.normalizeEntityId(entityIdRaw);

    return this.surreal.withCompany(companyId, async (db) => {
      const sql = kind
        ? `SELECT id, in, out, kind, weight, source, createdAt, invalidatedAt
           FROM knowledge_edge
           WHERE (in = type::thing('knowledge_entity', $rid) OR out = type::thing('knowledge_entity', $rid))
             AND kind = $kind
             AND invalidatedAt IS NONE`
        : `SELECT id, in, out, kind, weight, source, createdAt, invalidatedAt
           FROM knowledge_edge
           WHERE (in = type::thing('knowledge_entity', $rid) OR out = type::thing('knowledge_entity', $rid))
             AND invalidatedAt IS NONE`;
      const [rows] = await db.query<any[][]>(sql, { rid: ref.id, kind });
      const edges = ((rows as any[]) ?? []).map((e) => ({
        edgeId: String(e.id),
        from: String(e.in),
        to: String(e.out),
        kind: e.kind,
        weight: e.weight,
        source: e.source,
        createdAt: new Date(e.createdAt).toISOString(),
      }));
      return { entityId: ref.full, edges };
    });
  }

  async forget(
    companyId: string,
    entityIdRaw: string,
    dto: ForgetEntityDto,
  ): Promise<ForgetResult> {
    const ref = this.normalizeEntityId(entityIdRaw);

    return this.surreal.withCompany(companyId, async (db) => {
      // Verify exists
      const [entRows] = await db.query<any[][]>(
        `SELECT id FROM type::thing('knowledge_entity', $rid) LIMIT 1`,
        { rid: ref.id },
      );
      const entity = (entRows as any[])?.[0];
      if (!entity) {
        throw new NotFoundException(`Entity ${entityIdRaw} not found`);
      }

      // Count facts + edges before deletion (for the audit tombstone).
      const [[factCount]] = await db.query<any[]>(
        `SELECT count() AS c FROM knowledge_fact
         WHERE entityId = type::thing('knowledge_entity', $rid) GROUP ALL`,
        { rid: ref.id },
      );
      const [[edgeCount]] = await db.query<any[]>(
        `SELECT count() AS c FROM knowledge_edge
         WHERE in = type::thing('knowledge_entity', $rid) OR out = type::thing('knowledge_entity', $rid)
         GROUP ALL`,
        { rid: ref.id },
      );
      const factsDeleted = (factCount as any)?.c ?? 0;
      const edgesDeleted = (edgeCount as any)?.c ?? 0;

      // Cascade hard-delete. Embedding columns die with the rows.
      await db.query(
        `DELETE knowledge_fact
         WHERE entityId = type::thing('knowledge_entity', $rid)`,
        { rid: ref.id },
      );
      await db.query(
        `DELETE knowledge_edge
         WHERE in = type::thing('knowledge_entity', $rid) OR out = type::thing('knowledge_entity', $rid)`,
        { rid: ref.id },
      );
      await db.query(
        `DELETE type::thing('knowledge_entity', $rid)`,
        { rid: ref.id },
      );

      const entityIdHash =
        'hmac:' +
        createHmac('sha256', this.forgetHmacKey)
          .update(`${companyId}/${ref.full}`)
          .digest('hex');

      const forgottenAt = new Date();
      await dbCreate(db, 'forgotten_entity', {
        entityIdHash,
        reason: dto.reason,
        requestId: dto.requestId,
        factsDeleted,
        edgesDeleted,
        forgottenAt,
      });

      this.logger.warn(
        `[knowledge.entity.forgotten] companyId=${companyId} hash=${entityIdHash} ` +
        `factsDeleted=${factsDeleted} edgesDeleted=${edgesDeleted} reason=${dto.reason}`,
      );

      return {
        entityIdHash,
        factsDeleted,
        edgesDeleted,
        forgottenAt: forgottenAt.toISOString(),
      };
    });
  }

  private normalizeEntityId(raw: string): { id: string; full: string } {
    const id = raw.startsWith('knowledge_entity:')
      ? raw.slice('knowledge_entity:'.length)
      : raw;
    return { id, full: `knowledge_entity:${id}` };
  }
}

// Keep import-side alive: re-export to avoid tree-shake stripping the policies
// when search/forget paths are the only call sites.
export { PREDICATE_POLICIES };
