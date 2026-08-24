import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { IndexerRouterService } from '../indexers/indexer-router.service';
import { normalizeEntityType } from '../ai/extractor-internals/grounding';
import { PACK_NAMESPACE_SEP } from '../ai/domain-packs/manifest';
import { policyFor } from '../ingest/conflict-resolver';
import { RETRACT_ADMIN_PREDICATES } from '../facts/facts.service';
import { envFlagEnabled } from '../common/env-validation';
import { sanitizeIngestText } from '../common/text-sanitizer';
import { MetricsService } from '../metrics/metrics.service';
import type {
  CandidateBatch,
  CandidateEntity,
  CandidateFact,
  CandidateRelation,
} from '../indexers/candidate.types';
import { DocumentStoreService, StoredDocument } from './document-store.service';
import { CandidateStoreService } from './candidate-store.service';
import { assertKeyBoundToPack, IndexerWorkService } from './indexer-work.service';
import { groundExternalBatch, GroundingDrop } from './candidate-grounding';
import { SubmitCandidatesDto, SubmittedFact, SubmittedRelation } from './dto/submit-candidates.dto';

export interface ExternalSubmissionResult {
  runId: string;
  packId: string;
  packVersion: string;
  staged: { entities: number; facts: number; relations: number };
  dropped: GroundingDrop[];
  /** true when the document has no stored content — spans unverifiable. */
  ungrounded: boolean;
}

/** Abuse bounds on one submission — an external key stages hypotheses,
 *  it must not be able to flood the staging table in one call. */
const MAX_ITEMS_PER_KIND = 200;
const MAX_NAME = 256;
const MAX_OBJECT = 2_000;

/**
 * The external-indexer seam: a remote service that read a stored
 * document POSTs its CandidateBatch here (scope `indexer:write`). The
 * server enforces what the in-process pipeline gets for free:
 *
 *   1. the indexer must be a pack installed for this tenant with
 *      `indexer.mode: 'external'` (registered identity, not a free string);
 *   2. fact predicates must live in the pack's namespace (or core) —
 *      an external indexer cannot squat another pack's vocabulary;
 *   3. spans are RE-GROUNDED against the stored document text — verbatim
 *      or dropped (documents stored without content stage `ungrounded`
 *      candidates instead; source-trust learning compensates);
 *   4. the indexer_run UNIQUE ledger applies — one run per
 *      (doc, pack, version), duplicate submissions collapse.
 *
 * Candidates staged here flow through the SAME merge + CommitMemory as
 * in-process runs; the endpoint never touches the graph directly.
 */
@Injectable()
export class ExternalCandidatesService {
  // The submission seam spans the document store, the run ledger, the
  // pack fence (router), and claim verification (work service).
  // eslint-disable-next-line max-params
  constructor(
    private readonly store: DocumentStoreService,
    private readonly candidates: CandidateStoreService,
    private readonly router: IndexerRouterService,
    private readonly work: IndexerWorkService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async submit(p: {
    companyId: string;
    docId: string;
    dto: SubmitCandidatesDto;
    /** Per-pack binding of the calling key; absent = unrestricted. */
    keyPackIds?: string[] | undefined;
  }): Promise<ExternalSubmissionResult> {
    const { companyId, docId, dto } = p;
    // G9 write-anomaly signal (one increment per external submission —
    // the PoisonedRAG / AgentPoison flood surface).
    this.metrics?.countIngestWrite('candidate');
    const doc = await this.store.getById(companyId, docId);
    if (!doc) throw new NotFoundException('document not found');

    assertKeyBoundToPack(p.keyPackIds, dto.indexerId);
    const binding = await this.resolveExternalBinding(companyId, dto);
    validateShapes(dto, binding.indexerId);
    const claim = resolveClaimFields(dto);

    // Claimed flow: the run row already exists (claimed via the work
    // API) — verify the token fences it, drop any prior attempt's staged
    // candidates (drop-and-restage, exactly what createRun's reopen
    // does), and fulfil THAT slot. Provenance pins the claimed run's
    // packVersion — the work item is the source of truth for its slot.
    let runId: string | undefined;
    let packVersion = binding.packVersion;
    if (claim) {
      const run = await this.work.verifyClaimForSubmit({
        companyId,
        runId: claim.runId,
        claimToken: claim.claimToken,
        docId: doc.id,
        packId: binding.indexerId,
      });
      await this.candidates.dropRunCandidates(companyId, run.runId);
      runId = run.runId;
      packVersion = run.packVersion;
    }

    const { batch, dropped, ungrounded } = await this.groundAgainstDocument({
      companyId,
      doc,
      dto,
      // The RESOLVED installed version — not dto.packVersion, which the
      // caller may omit. Keeps candidate/fact provenance in lockstep with
      // the run ledger instead of stamping the '0' fallback.
      packVersion,
    });

    if (runId === undefined) {
      // Claimless flow: open (or reopen) the run — the createRun CAS is
      // the claim. A pre-created 'pending' external work item is absorbed
      // here (pending → running reopen), so simple pollers never need the
      // claim endpoint at all.
      const run = await this.candidates.createRun(companyId, {
        docId: doc.id,
        packId: binding.indexerId,
        packVersion,
        external: true,
      });
      if (!run.created) {
        throw new ConflictException(
          `indexer "${binding.indexerId}"@${packVersion} already processed this document`,
        );
      }
      runId = run.runId;
    }

    const counts = await this.candidates.insertBatch(companyId, {
      docId: doc.id,
      runId,
      chunkSeq: 0,
      batch,
    });
    await this.candidates.finalizeRun(companyId, {
      runId,
      status: 'succeeded',
      stats: { ...counts, dropped: dropped.length, external: true },
    });

    return {
      runId,
      packId: binding.indexerId,
      packVersion,
      staged: counts,
      dropped,
      ungrounded,
    };
  }

  private async resolveExternalBinding(
    companyId: string,
    dto: SubmitCandidatesDto,
  ): Promise<{ indexerId: string; packVersion: string }> {
    const bindings = await this.router.bindingsFor(companyId);
    const binding = bindings.find((b) => b.indexerId === dto.indexerId);
    if (!binding) {
      throw new NotFoundException(
        `indexer pack "${dto.indexerId}" is not installed for this tenant`,
      );
    }
    if (binding.mode !== 'external') {
      throw new BadRequestException(
        `pack "${dto.indexerId}" is not declared indexer.mode='external' — in-process packs stage through their own runs`,
      );
    }
    if (dto.packVersion !== undefined && dto.packVersion !== binding.packVersion) {
      throw new ConflictException(
        `version mismatch: submitted ${dto.packVersion}, installed ${binding.packVersion}`,
      );
    }
    return { indexerId: binding.indexerId, packVersion: binding.packVersion };
  }

  private async groundAgainstDocument(p: {
    companyId: string;
    doc: StoredDocument;
    dto: SubmitCandidatesDto;
    packVersion: string;
  }): Promise<{
    batch: CandidateBatch;
    dropped: GroundingDrop[];
    ungrounded: boolean;
  }> {
    const { dto, doc } = p;
    // G9 ingest sanitization (INGEST_SANITIZE_UNICODE, default off):
    // de-obfuscate submitted names/objects. The stored document text this
    // batch re-grounds against was itself sanitized at ingest (when the
    // flag was on), so both sides of the grounding comparison see the
    // same text. Flag off → submitted fields flow through verbatim.
    const clean = envFlagEnabled(process.env.INGEST_SANITIZE_UNICODE);
    const entities: CandidateEntity[] = dto.entities.map((e, i) => ({
      entityIndex: i,
      name: clean ? sanitizeIngestText(e.name) : e.name,
      type: normalizeEntityType(e.type),
      canonical: clean ? sanitizeIngestText(e.canonical) : e.canonical,
    }));
    const facts: CandidateFact[] = dto.facts.map((f) => {
      const fact = toFact(f);
      return clean ? { ...fact, object: sanitizeIngestText(fact.object) } : fact;
    });
    const relations: CandidateRelation[] = (dto.relations ?? []).map(toRelation);

    const provenance = {
      indexerId: dto.indexerId,
      packVersion: p.packVersion,
      executionMode: 'external' as const,
      model: null,
    };

    if (!doc.hasContent) {
      // storeContent:false — there is no stored text to re-ground against,
      // so an external indexer could stage an arbitrary (entity, predicate,
      // object) with no verification. That auto-commits into the graph, so
      // it is opt-in: default-off, operators who deliberately run
      // content-less external indexers enable it. Grounded (content-bearing)
      // submissions are unaffected.
      if (!envFlagEnabled(process.env.DOCUMENT_ALLOW_UNGROUNDED_EXTERNAL)) {
        throw new BadRequestException(
          'document has no stored content; ungrounded external candidates are disabled ' +
            '(set DOCUMENT_ALLOW_UNGROUNDED_EXTERNAL=1 to allow unverifiable spans)',
        );
      }
      // Stage the hypotheses flagged ungrounded; the trade was the caller's.
      return {
        batch: {
          provenance,
          entities: entities.map((e) => ({ ...e, ungrounded: true })),
          facts: facts.map((f) => ({ ...f, ungrounded: true })),
          relations: relations.map((r) => ({ ...r, ungrounded: true })),
        },
        dropped: [],
        ungrounded: true,
      };
    }

    const chunks = await this.store.getChunks(p.companyId, doc.id);
    const docText = chunks.map((c) => c.text).join('\n');
    const grounded = groundExternalBatch({ docText, entities, facts, relations });
    return {
      batch: {
        provenance,
        entities: grounded.entities,
        facts: grounded.facts,
        relations: grounded.relations,
      },
      dropped: grounded.dropped,
      ungrounded: false,
    };
  }
}

/** runId + claimToken travel together, or not at all. */
function resolveClaimFields(
  dto: SubmitCandidatesDto,
): { runId: string; claimToken: string } | null {
  const hasRun = dto.runId !== undefined;
  const hasToken = dto.claimToken !== undefined;
  if (hasRun !== hasToken) {
    throw new BadRequestException('runId and claimToken must be provided together');
  }
  return hasRun ? { runId: dto.runId as string, claimToken: dto.claimToken as string } : null;
}

/**
 * Per-item shape checks the whitelist pipe can't do: caps, confidence
 * clamps, and the namespace fence.
 */
function validateShapes(dto: SubmitCandidatesDto, indexerId: string): void {
  const relations = dto.relations ?? [];
  if (
    dto.entities.length > MAX_ITEMS_PER_KIND ||
    dto.facts.length > MAX_ITEMS_PER_KIND ||
    relations.length > MAX_ITEMS_PER_KIND
  ) {
    throw new BadRequestException(`a submission is capped at ${MAX_ITEMS_PER_KIND} items per kind`);
  }
  for (const [i, e] of dto.entities.entries()) {
    if (!isBoundedString(e?.name, MAX_NAME)) {
      throw new BadRequestException(
        `entities[${i}].name must be a non-empty string of at most ${MAX_NAME} chars`,
      );
    }
  }
  dto.facts.forEach((f, i) => validateFact(f, i, indexerId));
  for (const [i, r] of relations.entries()) {
    if (
      !Number.isInteger(r?.fromEntityIndex) ||
      !Number.isInteger(r?.toEntityIndex) ||
      typeof r.kind !== 'string' ||
      !r.kind.trim()
    ) {
      throw new BadRequestException(
        `relations[${i}] must carry integer endpoints and a non-empty kind`,
      );
    }
  }
}

function validateFact(f: SubmittedFact, i: number, indexerId: string): void {
  if (!Number.isInteger(f?.entityIndex) || f.entityIndex < 0) {
    throw new BadRequestException(`facts[${i}].entityIndex must be a non-negative integer`);
  }
  if (typeof f.predicate !== 'string' || !f.predicate.trim()) {
    throw new BadRequestException(`facts[${i}].predicate must be a non-empty string`);
  }
  // Namespace fence: this indexer's own vocabulary, or core (unprefixed).
  // Another pack's namespace is squatting — rejected, not dropped.
  if (
    f.predicate.includes(PACK_NAMESPACE_SEP) &&
    !f.predicate.startsWith(indexerId + PACK_NAMESPACE_SEP)
  ) {
    throw new BadRequestException(
      `facts[${i}].predicate "${f.predicate}" is outside the "${indexerId}" namespace`,
    );
  }
  // Predicate-class fence (write side): an `indexer:write` key stages
  // hypotheses — it must not seed high-value CORE facts it could never
  // retract (retract needs brain:admin). Reject PII-sensitive predicates
  // (dob/address — requiresScope) and the retract-admin class
  // (billing_event/human_declared). Pack-namespaced predicates are the
  // indexer's own vocabulary and are unaffected.
  if (!f.predicate.includes(PACK_NAMESPACE_SEP)) {
    if (RETRACT_ADMIN_PREDICATES.has(f.predicate)) {
      throw new BadRequestException(
        `facts[${i}].predicate "${f.predicate}" is an operator-attested class; an external indexer cannot seed it`,
      );
    }
    if (policyFor(f.predicate).requiresScope) {
      throw new BadRequestException(
        `facts[${i}].predicate "${f.predicate}" is a scope-gated core predicate; an external indexer cannot seed it`,
      );
    }
  }
  if (!isBoundedString(f.object, MAX_OBJECT)) {
    throw new BadRequestException(
      `facts[${i}].object must be a non-empty string of at most ${MAX_OBJECT} chars`,
    );
  }
}

function isBoundedString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function toFact(f: SubmittedFact): CandidateFact {
  return {
    entityIndex: f.entityIndex,
    predicate: f.predicate,
    object: f.object,
    confidence: clamp01(f.confidence ?? 0.7),
    clause: f.clause,
  };
}

function toRelation(r: SubmittedRelation): CandidateRelation {
  return {
    fromEntityIndex: r.fromEntityIndex,
    toEntityIndex: r.toEntityIndex,
    kind: r.kind,
    confidence: clamp01(r.confidence ?? 0.7),
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.7;
  return Math.min(1, Math.max(0, n));
}
