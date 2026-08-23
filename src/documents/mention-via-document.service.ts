import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { MetricsService } from '../metrics/metrics.service';
import { IngestMentionDto } from '../ingest/dto/ingest-mention.dto';
import { DocumentIngestService } from './document-ingest.service';
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
 * Known (flag-gated) differences vs the legacy path: `knownEntities`
 * hints are not threaded into entity resolution, and skip detection for
 * 'no_entities' happens AFTER the document + candidates are staged (the
 * document is the audit trail of the empty read).
 */
@Injectable()
export class MentionViaDocumentService {
  constructor(
    private readonly documents: DocumentIngestService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async ingest(companyId: string, dto: IngestMentionDto): Promise<MentionCompatResult> {
    // Audit 2026-08-21 P0, FAIL-CLOSED: the document pipeline does not
    // carry per-user scope yet — refusing a user-scoped mention beats
    // silently landing a user's memory tenant-global. M2M tenant-global
    // traffic (no userId) is unaffected.
    if (pinUserScope(dto.userId)) {
      throw new BadRequestException(
        'INGEST_MENTION_VIA_DOCUMENT does not support user-scoped ' +
          'mentions yet — retry without the flag or without userId',
      );
    }
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
      const res = await this.documents.ingestDocument(companyId, {
        kind: 'chat',
        text: dto.text,
        occurredAt: dto.emittedAt,
        contextRef: {
          vertical: dto.contextRef.vertical,
          recorder: dto.contextRef.recorder,
        },
        meta: {
          conversationId: dto.contextRef.conversationId,
          messageId: dto.contextRef.messageId,
          eventId: dto.contextRef.eventId,
        },
        indexers: 'general',
        mode: 'sync',
      });
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
