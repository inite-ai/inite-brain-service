import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { MetricsService } from '../metrics/metrics.service';
import { IngestMentionDto } from '../ingest/dto/ingest-mention.dto';
import { EpisodeStoreService } from '../ingest/episode-store.service';
import { failClosedCaptureEnabled } from '../common/evidence-flags';
import { DocumentIngestService } from './document-ingest.service';
import { internalDocumentMeta, joinKnownNames } from './document-meta';
import { pinUserScope } from '../auth/user-scope';
import { MemoryContextService } from '../ingest/memory-context.service';
import { UserEntityService } from '../ingest/user-entity.service';
import { participantsOf } from '../ingest/participants';

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
 * The L0 episode is captured here exactly as the direct path captures
 * it, BEFORE the document is staged, and its id rides the internal
 * document channel onto every committed fact's `source.episodeIds`. It
 * did not use to be: the wrapper stored the document as "the raw
 * observation instead", which is true for the evidence plane and false
 * for every plane that reads EPISODES — scene segmentation, belief
 * promotion, the transcript sections of an answer, the L3 anchors. A
 * full-chain trace on the prod assembly (INGEST_MENTION_VIA_DOCUMENT=1,
 * SCENES_SEGMENTATION_ENABLED=1, SCENES_BELIEF_PROMOTION=1) read
 * `episode = 0` after four turns: the episodic plane was switched on and
 * had nothing to segment, because the only writer of its input lived on
 * the path the deployment does not run.
 *
 * The participants (`knownEntities` by role) ride the internal channel
 * too — speaker/addressee names for the extractor's coreference framing
 * and their externalRefs for the commit writer's anchor — so this path
 * files a first-person turn under its speaker exactly as the direct
 * path does. Known difference that remains: skip detection for
 * 'no_entities' happens AFTER the document + candidates are staged (the
 * document is the audit trail of the empty read).
 */
@Injectable()
export class MentionViaDocumentService {
  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly documents: DocumentIngestService,
    @Optional() private readonly episodes?: EpisodeStoreService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly memory?: MemoryContextService,
    @Optional() private readonly users?: UserEntityService,
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
    // The user is the speaker of their own turn unless the caller says
    // who else is (participants.ts) — the same normalisation as the
    // direct path, before the episode and the internal meta read it.
    dto = (await this.users?.participants(companyId, { ...dto, userId })) ?? dto;
    // L0 episode capture (EPISODE_SUBSTRATE_ENABLED) runs BEFORE the
    // document is staged, so an indexer failure or an empty read no
    // longer loses the turn. Non-fatal by contract; idempotent on retry.
    // Same seam as the direct path, same fail-closed rule.
    const scoped = { ...dto, ...(userId !== undefined ? { userId } : {}) };
    const episodeId = (await this.episodes?.captureTurn(companyId, scoped)) ?? null;
    if (failClosedCaptureEnabled() && !episodeId) {
      this.metrics?.countIngestMention('failed');
      throw new ServiceUnavailableException(
        'episode capture unavailable — fail-closed ingest (EVIDENCE_FAIL_CLOSED_CAPTURE ' +
          'requires EPISODE_SUBSTRATE_ENABLED and a successful L0 episode write)',
      );
    }
    // Bounded BEFORE the pipeline runs: an over-long or non-string id is a
    // 400 at the door, not a failed extraction.
    const { speaker, addressee } = participantsOf(dto);
    const internal = internalDocumentMeta({
      conversationId: dto.contextRef.conversationId,
      messageId: dto.contextRef.messageId,
      eventId: dto.contextRef.eventId,
      episodeId,
      timezone: dto.timezone,
      speakerName: speaker?.name,
      speakerRef: speaker ? `${speaker.vertical}:${speaker.id}` : undefined,
      addresseeName: addressee?.name,
      addresseeRef: addressee ? `${addressee.vertical}:${addressee.id}` : undefined,
      knownNames: joinKnownNames((dto.knownEntities ?? []).map((k) => k.name)),
    });
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
          // at all (IngestMentionDto has no such field); what follows are
          // the caller's identifiers read off the TYPED contextRef, and
          // they ride the internal channel instead — bounded there
          // (internalDocumentMeta: string, ≤ the short-scalar limit, else
          // 400). Asserting them as caller meta 400'd every mention under
          // SOURCE_META_STRICT=1 — and, because an object literal
          // materialises a key even for an undefined value, it did so
          // even for requests that sent no conversationId/messageId/
          // eventId whatsoever.
          indexers: 'general',
          mode: 'sync',
        },
        { channel: 'mention', internal },
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
      this.memory?.remember(companyId, dto.contextRef.conversationId, res.committed.entityIds);
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
