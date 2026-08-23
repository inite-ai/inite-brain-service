import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { envFlagEnabled } from '../common/env-validation';
import { sanitizeIngestText } from '../common/text-sanitizer';
import { MetricsService } from '../metrics/metrics.service';
import { sanitizeSourceMeta } from '../policy/source-meta';
import { IngestFactDto } from './dto/ingest-fact.dto';
import { IngestOutcome, IngestResult } from './ingest-result';
import {
  buildConflictExplanation,
  type ResolverConflictPayload,
} from './conflict-explainer';
import { EntityUpsertService } from './entity-upsert.service';
import { FactResolverService } from './fact-resolver.service';
import { evidenceValidationError } from './ingest-utils';
import { pinUserScope } from '../auth/user-scope';
import { getRequestContext } from '../common/request-context';

/**
 * The typed direct-ingest path (`ingestFact`): a single fully-specified fact
 * with an explicit entity reference, run through the full conflict-resolution
 * pipeline. Resolves the entity, then defers the embed + fn::resolve_fact +
 * HyPE to FactResolverService, and shapes the IngestResult (+ optional
 * conflict explanation).
 */
@Injectable()
export class FactIngestService {
  private readonly logger = new Logger(FactIngestService.name);

  // Fourth dep is the optional write-anomaly counter (G9); @Optional so
  // positionally-constructed unit tests stay three-argument.
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly entities: EntityUpsertService,
    private readonly factResolver: FactResolverService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async ingestFact(companyId: string, dto: IngestFactDto): Promise<IngestResult> {
    // A user-bound token writes into its own user scope only — the
    // caller-asserted userId is pinned to the token's end-user (403 on
    // mismatch, default when omitted). M2M credentials pass through.
    dto = { ...dto, userId: pinUserScope(dto.userId) };
    // G9 write-anomaly signal (fired once per direct fact write).
    this.metrics?.countIngestWrite('fact');
    // G9 ingest sanitization (INGEST_SANITIZE_UNICODE, default off):
    // strip bidi/zero-width/control chars from the free-text fields a
    // direct fact carries (predicate + string object). Flag off →
    // byte-identical (dto untouched). Grounding for direct ingest is
    // caller-asserted, so this only de-obfuscates what gets stored and
    // embedded, never changes acceptance.
    if (envFlagEnabled(process.env.INGEST_SANITIZE_UNICODE)) {
      dto = {
        ...dto,
        predicate: sanitizeIngestText(dto.predicate),
        object: sanitizeIngestText(dto.object),
      };
    }
    // Reject an inverted or zero-width validity interval up front. Both are
    // nonsensical bitemporally — a fact valid until before (or exactly at)
    // it became valid covers no instant — and would otherwise corrupt
    // asOf-query selection inside fn::resolve_fact. class-validator can't
    // express this cross-field constraint, so it lives here.
    if (dto.validUntil !== undefined) {
      const from = Date.parse(dto.validFrom);
      const until = Date.parse(dto.validUntil);
      if (Number.isFinite(from) && Number.isFinite(until) && until <= from) {
        throw new BadRequestException(
          'validUntil must be strictly after validFrom',
        );
      }
    }
    // source is an opaque @IsObject (union shape) — nested evidence[] must
    // be shape-checked here, not by class-validator.
    const evidenceError = evidenceValidationError(dto.source?.evidence);
    if (evidenceError) {
      throw new BadRequestException(evidenceError);
    }
    // `originKey` is content-addressed ORIGIN identity for corroboration
    // (migration 0050), stamped ONLY by the document/commit path where it
    // derives from the document's contentHash. A raw fact-ingest caller must
    // not assert it: a client could otherwise fabricate independent origins
    // to farm cross-source corroboration (reputation inflation), or crash
    // the resolver with `originKey: null` → <string>NULL. Strip it so
    // fn::origin_key_of falls back to fn::source_key_of (0047 behaviour).
    const source = { ...(dto.source as unknown as Record<string, unknown>) };
    delete source.originKey;
    // Direct-path metadata projection: dto.metadata (historically
    // accepted-and-dropped) lands on `source.meta` so ABAC
    // `source.meta.*` rules match direct facts like document-derived
    // ones. Sanitized to operator vocabulary; SOURCE_META_STRICT=1
    // turns drops into a 400 instead of a warn.
    //
    // A caller can also put meta directly on `dto.source.meta` — that copy
    // above carries it verbatim, so it MUST go through the same sanitizer,
    // else it is an unfiltered write to the ABAC match surface (and to the
    // read responses that echo `source`). dto.metadata is the documented
    // channel and wins; a raw source.meta is sanitized as a fallback.
    const rawSourceMeta = source.meta;
    delete source.meta;
    const metaInput = dto.metadata ?? rawSourceMeta;
    if (metaInput !== undefined) {
      const { meta, dropped } = sanitizeSourceMeta(metaInput);
      if (dropped.length > 0) {
        if (envFlagEnabled(process.env.SOURCE_META_STRICT)) {
          throw new BadRequestException({
            error: 'invalid_metadata',
            issues: dropped,
          });
        }
        this.logger.warn(
          `ingest fact metadata partially dropped (${dropped.length} issue(s)): ${dropped[0]}`,
        );
      }
      if (meta) source.meta = meta;
    }
    // Agent attribution: the verified acting-client identity (token act/
    // client_id, stamped into ALS by the guard) lands on source.meta.actor
    // — auth-derived, so it OVERRIDES any caller-asserted `actor` meta.
    // Gives ABAC source rules and audits a per-agent handle on every fact.
    const actorId = getRequestContext()?.authActorId;
    if (actorId) {
      source.meta = { ...((source.meta as Record<string, unknown>) ?? {}), actor: actorId };
    }
    return this.surreal.withCompany(companyId, async (db) => {
      // 1. Resolve entity (own atomic step — own tx with unique-retry).
      //    dto.userId scopes both the entity dedup key and the fact.
      const entityId = await this.entities.resolveOrCreateEntity(
        db,
        dto,
        dto.userId,
      );

      // 2. Object preservation. Schema stores `object` as string for
      //    indexing; for non-string DTO objects we additionally keep
      //    the structured form in `objectMeta`.
      const objectIsString = typeof dto.object === 'string';
      const objectStr = objectIsString
        ? (dto.object as string)
        : JSON.stringify(dto.object);
      // SurrealDB option<...> rejects NULL. JS `null` serialises as NULL,
      // `undefined` is dropped from the payload and treated as NONE — which
      // is what we want for an optional field.
      const objectMeta = objectIsString ? undefined : (dto.object as unknown as object);

      // 3. One-RTT server-side resolve (embed + policy + fn::resolve_fact +
      //    HyPE alt-embedding) behind FactResolverService. Direct ingest
      //    carries no extraction entropy. The embedding text preserves the
      //    historical `${predicate}: ${dto.object}` form (not objectStr).
      const { result } = await this.factResolver.resolve(db, {
        companyId,
        entityId,
        predicate: dto.predicate,
        object: objectStr,
        objectMeta,
        embeddingText: `${dto.predicate}: ${dto.object}`,
        confidence: dto.confidence ?? 0.7,
        validFrom: new Date(dto.validFrom),
        validUntil: dto.validUntil ? new Date(dto.validUntil) : undefined,
        source: source as unknown as typeof dto.source,
        entropy: undefined,
        userId: dto.userId,
        recordOutcomeMetric: true,
      });

      const factId = result?.factId ? String(result.factId) : null;
      const outcome = result?.outcome as IngestOutcome;

      const out: IngestResult = { factId, outcome };
      if (result?.reason) out.reason = String(result.reason);
      if (result?.supersededFactIds) {
        out.supersededFactIds = (result.supersededFactIds as unknown[]).map(String);
      }
      if (result?.competingFactIds) {
        out.competingFactIds = (result.competingFactIds as unknown[]).map(String);
      }
      if (result?.supersededByFactId) {
        out.supersededByFactId = String(result.supersededByFactId);
      }
      if (result?.corroboratedFactId) {
        out.corroboratedFactId = String(result.corroboratedFactId);
      }
      if (dto.explain === true && factId && result?.bestOpponentId) {
        out.conflictExplanation = buildConflictExplanation({
          outcome: outcome as 'SUPERSEDED' | 'COMPETING',
          factId,
          bestOpponentId: String(result.bestOpponentId),
          supersededFactIds: out.supersededFactIds,
          competingFactIds: out.competingFactIds,
          scoreBreakdown: result.scoreBreakdown as ResolverConflictPayload['scoreBreakdown'],
          dominantDimension: result.dominantDimension as ResolverConflictPayload['dominantDimension'],
          slotDelta: result.slotDelta as ResolverConflictPayload['slotDelta'],
        });
      }
      return out;
    });
  }
}
