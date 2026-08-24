import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { policyFor } from '../ingest/conflict-resolver';
import { getPolicyContext } from '../common/request-context';
import { evaluateRow, toRowView } from '../policy/policy-engine';
import type { PolicyContext } from '../policy/policy.types';
import { DocumentStoreService } from './document-store.service';
import { CandidateStoreService, type CandidateRow } from './candidate-store.service';
import { assertDocumentIngestEnabled } from './documents-gate';

/**
 * Read + erasure surface of the document pipeline: the document header,
 * its indexer runs, the Candidates-layer audit view, and the explicit
 * content purge. Writes live in DocumentsIngestController. Dark behind
 * DOCUMENT_INGEST_ENABLED (default off).
 */
@Controller('v1/documents')
@UseGuards(ApiKeyGuard)
export class DocumentsController {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly candidates: CandidateStoreService,
  ) {}

  @Get(':id')
  @RequireScopes('brain:read')
  @PolicyAction('rest.documents.get')
  async getDocument(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('includeText') includeText?: string,
  ) {
    assertDocumentIngestEnabled();
    const doc = await this.store.getById(req.brainAuth.companyId, id);
    if (!doc) throw new NotFoundException('document not found');
    const runs = await this.candidates.listRuns(req.brainAuth.companyId, id);
    let chunks;
    if (includeText === '1') {
      // The raw source text is the document verbatim — it can carry any PII
      // (addresses, DOB, medical text) that the committed-fact read path
      // gates behind brain:read_pii. Returning it under plain brain:read
      // would be a fence bypass, so require the PII scope explicitly.
      if (!req.brainAuth.scopes.includes('brain:read_pii')) {
        throw new ForbiddenException('includeText requires the brain:read_pii scope');
      }
      chunks = await this.store.getChunks(req.brainAuth.companyId, id);
    }
    return { ...doc, runs, ...(chunks ? { chunks } : {}) };
  }

  @Get(':id/candidates')
  @RequireScopes('brain:read')
  @PolicyAction('rest.documents.candidates')
  async listCandidates(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    assertDocumentIngestEnabled();
    const doc = await this.store.getById(req.brainAuth.companyId, id);
    if (!doc) throw new NotFoundException('document not found');
    const candidates = await this.candidates.listByDoc(req.brainAuth.companyId, id);
    return {
      documentId: doc.id,
      candidates: redactGatedCandidates(
        candidates,
        req.brainAuth.scopes,
        getPolicyContext() ?? null,
      ),
    };
  }

  @Delete(':id/content')
  @RequireScopes('brain:admin')
  @PolicyAction('rest.documents.purge_content')
  async purge(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    assertDocumentIngestEnabled();
    const purged = await this.store.purgeContent(req.brainAuth.companyId, id);
    if (!purged) throw new NotFoundException('document not found');
    return { purged: true };
  }
}

/**
 * A candidate's fact object can hold the same PII a committed fact would —
 * so the candidate audit view must honor the same predicate-scope policy
 * that passesPolicy applies on the search path. Redact the `object` of any
 * fact candidate whose predicate requires a scope the caller doesn't hold;
 * the row (predicate, provenance) stays visible for the audit trail.
 *
 * Two gates, mirroring the committed-fact read seam (row-filter.ts): the
 * always-on predicate scope gate, then the ABAC row verdict when the
 * request carries a PolicyContext. A candidate is a PENDING extraction and
 * carries no committed `source`, so only predicate/piiClass/posture rules
 * can fire here — source.* deny conditions stay absent (no-match), which is
 * correct: the fact's real source is only fixed at commit time.
 */
export function redactGatedCandidates(
  candidates: CandidateRow[],
  scopes: string[],
  ctx: PolicyContext | null,
): CandidateRow[] {
  return candidates.map((c) => {
    if (c.kind !== 'fact') return c;
    const predicate = String(c.payload?.predicate ?? '');
    const requiresScope = policyFor(predicate).requiresScope;
    const scopeGated = !!requiresScope && !scopes.includes(requiresScope);
    const abacDenied =
      !!ctx &&
      evaluateRow(
        ctx,
        toRowView({ predicate }, (p) => policyFor(p).piiClass),
      ).decision === 'deny';
    if (!scopeGated && !abacDenied) return c;
    // Redact BOTH the extracted value and the verbatim grounding
    // sentence: `clause` is a quote from the source document and carries
    // the same PII the `object` does, so redacting object alone still
    // leaked the value through the citation.
    const redactedPayload: Record<string, unknown> = {
      ...c.payload,
      object: '[redacted]',
      redacted: true,
    };
    if ('clause' in redactedPayload) redactedPayload.clause = '[redacted]';
    return { ...c, payload: redactedPayload };
  });
}
