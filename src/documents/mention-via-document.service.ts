import { Injectable, Optional } from '@nestjs/common';
import { MetricsService } from '../metrics/metrics.service';
import { IngestMentionDto } from '../ingest/dto/ingest-mention.dto';
import { DocumentIngestService } from './document-ingest.service';
import { internalDocumentMeta } from './document-meta';
import { pinUserScope } from '../auth/user-scope';

export interface MentionCompatResult {
  skipped: boolean;
  reason?: 'empty' | 'no_entities';
  extractedEntityIds: string[];
  extractedFactIds: string[];
  extractedEdgeIds?: string[];
}

/**
 * INGEST_MENTION_VIA_DOCUMENT wrapper: route a mention through the
 * Source → Indexer → Candidates → Brain pipeline while preserving the
 * mention response contract EXACTLY (extractedEntityIds/FactIds/EdgeIds,
 * skipped/reason). One pipeline, one decision engine — mention traffic
 * gains a stored document, staged candidates, and origin-keyed
 * corroboration (0050) for free.
 *
 * Per-user scope (0128): a user-scoped mention flows through with its
 * userId intact — the stored document, every committed fact and any
 * projected scenes carry userId + the 0093 scope tag exactly as the
 * direct path stamps them (facts go through the SAME
 * fn::resolve_fact/userId machinery). Entities minted by extraction stay
 * tenant-global on both paths (name/type nodes only).
 *
 * Known (flag-gated) differences vs the legacy path: `knownEntities`
 * hints are not threaded into entity resolution, skip detection for
 * 'no_entities' happens AFTER the document + candidates are staged (the
 * document is the audit trail of the empty read), and no L0 episode turn
 * is captured — the stored document is the raw observation instead.
 */
@Injectable()
export class MentionViaDocumentService {
  constructor(
    private readonly documents: DocumentIngestService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async ingest(companyId: string, dto: IngestMentionDto): Promise<MentionCompatResult> {
    // Per-user scope pin at the entry (audit 2026-08-21 P0 seam, same as
    // the legacy path): a user-bound token writes ONLY its own user's
    // slice (mismatch 403, BEFORE any write; omitted → the token's
    // user); M2M assertions pass through. The pipeline carries the scope
    // end-to-end now (0128) — the pre-0128 fail-closed 400 is gone.
    const userId = pinUserScope(dto.userId);
    if (!dto.text?.trim()) {
      this.metrics?.countIngestMention('skipped');
      return {
        skipped: true,
        reason: 'empty',
        extractedEntityIds: [],
        extractedFactIds: [],
      };
    }
    try {
      const res = await this.documents.ingestDocument(
        companyId,
        {
          kind: 'chat',
          text: dto.text,
          occurredAt: dto.emittedAt,
          // The pinned per-user scope (0128) — stamps the stored document,
          // every committed fact and any projected scenes. Absent key for
          // tenant-global traffic keeps that path byte-identical.
          ...(userId !== undefined ? { userId } : {}),
          contextRef: {
            vertical: dto.contextRef.vertical,
            recorder: dto.contextRef.recorder,
          },
          // NO `meta`. The document `meta` field is the CALLER channel —
          // operator vocabulary bound for the ABAC `source.meta` surface,
          // policed by SOURCE_META_STRICT. A mention has no caller meta
          // at all (IngestMentionDto has no such field); what follows is
          // brain's own provenance, read off the TYPED contextRef, and it
          // rides the internal channel instead. Asserting it as caller
          // meta 400'd every mention under SOURCE_META_STRICT=1 — and,
          // because an object literal materialises a key even for an
          // undefined value, it did so even for requests that sent no
          // conversationId/messageId/eventId whatsoever.
          indexers: 'general',
          mode: 'sync',
        },
        internalDocumentMeta({
          conversationId: dto.contextRef.conversationId,
          messageId: dto.contextRef.messageId,
          eventId: dto.contextRef.eventId,
        }),
      );
      if (res.committed.entityIds.length === 0) {
        this.metrics?.countIngestMention('skipped');
        return {
          skipped: true,
          reason: 'no_entities',
          extractedEntityIds: [],
          extractedFactIds: [],
        };
      }
      this.metrics?.countIngestMention('extracted');
      return {
        skipped: false,
        extractedEntityIds: res.committed.entityIds,
        extractedFactIds: res.committed.factIds,
        extractedEdgeIds: res.committed.edgeIds,
      };
    } catch (err) {
      this.metrics?.countIngestMention('failed');
      throw err;
    }
  }
}
