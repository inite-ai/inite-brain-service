import { Injectable, Logger, Optional } from '@nestjs/common';
import { ExtractorService, type ExtractionResult } from '../ai/extractor.service';
import { IngestMentionDto } from './dto/ingest-mention.dto';
import { traceArtifact, traceSpan } from '../common/debug-trace';
import { redactPii } from './ingest-utils';
import { FactEmbeddingService } from './fact-embedding.service';
import { factIndexText } from './fact-index-text';
import { envFlagEnabled } from '../common/env-validation';
import { MemoryContextService } from './memory-context.service';

export interface MentionSource {
  /**
   * Grounding episode id(s) of the captured turn (Drift-1) — stamped by
   * mention-ingest ONLY under EVIDENCE_FAIL_CLOSED_CAPTURE; absent
   * otherwise (byte-identical off-state).
   */
  episodeIds?: string[];
  vertical: string;
  eventId?: string | undefined;
  conversationId?: string | undefined;
  messageId?: string | undefined;
  recorder: string;
}

export type MentionPrep =
  | { skip: 'empty' | 'no_entities' }
  | {
      skip: null;
      extraction: ExtractionResult;
      source: MentionSource;
      /** Per-fact embeddings aligned with extraction.facts; [] on failure. */
      factEmbeddings: number[][];
    };

/**
 * Pre-persistence stage of mention ingest, run OUTSIDE the db session:
 * PII-redact the text, LLM-extract entities/facts/edges, and batch-embed every
 * fact's `${predicate}: ${object}` string in ONE call (pre-batch, each fact did
 * its own embed round-trip — N facts = N sequential calls before the loop could
 * start). Returns a skip signal for empty / entity-less input.
 */
@Injectable()
export class MentionExtractionService {
  private readonly logger = new Logger(MentionExtractionService.name);

  constructor(
    private readonly extractor: ExtractorService,
    private readonly factEmbedding: FactEmbeddingService,
    // @Optional: a stripped-down module (or a direct-construction spec)
    // without the memory reader extracts context-free, as before.
    @Optional() private readonly memory?: MemoryContextService,
  ) {}

  async prepare(companyId: string, dto: IngestMentionDto): Promise<MentionPrep> {
    const text = redactPii(dto.text);
    traceArtifact('ingest.mention.input', {
      text,
      contextRef: dto.contextRef,
      knownEntities: dto.knownEntities,
    });

    if (!text.trim()) {
      return { skip: 'empty' };
    }

    // Coreference context: tell the extractor who is speaking (and whom
    // they address), so first-person "I decided …" attaches to the speaker
    // rather than a junk "I" node. Derived by ROLE from knownEntities;
    // absent → the extractor runs speaker-agnostic exactly as before.
    const speaker = dto.knownEntities?.find((k) => k.role === 'speaker');
    const addressee = dto.knownEntities?.find((k) => k.role === 'addressee');
    // What the memory already holds around this turn — the conversation
    // so far, the entities it names, their facts, the tenant's
    // predicates (MemoryContextService) — read before the extraction so
    // the extractor pins mentions and closes replaced values itself.
    const memory = await this.memory?.build({
      companyId,
      text,
      occurredAt: dto.emittedAt,
      conversationId: dto.contextRef.conversationId,
      messageId: dto.contextRef.messageId,
      userId: dto.userId,
      // Every anchor the caller attached, participants first.
      participants: [
        ...new Set(
          [speaker?.name, addressee?.name, ...(dto.knownEntities ?? []).map((k) => k.name)].filter(
            (n): n is string => !!n,
          ),
        ),
      ],
    });
    const context = {
      ...(speaker?.name !== undefined ? { speakerName: speaker.name } : {}),
      ...(addressee?.name !== undefined ? { addresseeName: addressee.name } : {}),
      ...(memory ? { memory } : {}),
    };

    const extraction = await traceSpan('ingest.nlu.extract', () =>
      this.extractor.extract(text, companyId, context),
    );
    traceArtifact('ingest.nlu.extracted', extraction);

    if (extraction.entities.length === 0) {
      return { skip: 'no_entities' };
    }

    const source: MentionSource = {
      vertical: dto.contextRef.vertical,
      eventId: dto.contextRef.eventId,
      conversationId: dto.contextRef.conversationId,
      messageId: dto.contextRef.messageId,
      // Populate source.recorder so fn::source_key_of yields a discriminating
      // `vertical:recorder` key instead of `vertical:_`. Caller-provided
      // recorder wins; otherwise the extraction model id, so source-trust
      // scores LLM-extracted facts per model.
      recorder: dto.contextRef.recorder ?? this.extractor.modelId(),
    };

    // Contextual fact embedding (Anthropic Contextual Retrieval, fact-level):
    // a bare "predicate: object" ("preference: hiking") is stripped of the
    // context a conversational query matches on — who said it and when. When
    // INGEST_CONTEXTUAL_FACT_EMBEDDING is on, prepend a compact context stamp
    // (speaker + session date) so the stored embedding is closer to
    // context-referencing queries ("what is Caroline's identity"). Off →
    // bare text → byte-identical embeddings. Only the embedding basis
    // changes; the fact's stored object/predicate/haystack are untouched.
    const ctxStamp =
      envFlagEnabled(process.env.INGEST_CONTEXTUAL_FACT_EMBEDDING) &&
      (speaker?.name || dto.emittedAt)
        ? [speaker?.name, dto.emittedAt?.slice(0, 10)].filter(Boolean).join(', ')
        : '';
    // Base per-fact index text via the shared builder: under
    // INGEST_PREDICATE_INDEX_TEXT (default off) it appends the humanized
    // predicate words ("rate_limit" → "rate limit") so the stored vector
    // matches natural-language queries that phrase the predicate; off →
    // the bare `predicate: object`, byte-identical.
    const factTexts = extraction.facts.map((f: { predicate: string; object: string }) => {
      const base = factIndexText(f.predicate, f.object);
      return ctxStamp ? `${ctxStamp} — ${base}` : base;
    });
    let factEmbeddings: number[][];
    try {
      factEmbeddings = await this.factEmbedding.embedMany(factTexts);
    } catch (e) {
      // Fallback: let the per-row embed() handle it. We'd rather pay the
      // round-trips than fail the whole mention on an embedder hiccup.
      this.logger.warn(
        `mention batched embed failed (${(e as Error).message}); ` +
          `falling back to per-fact embed`,
      );
      factEmbeddings = [];
    }

    return {
      skip: null,
      extraction,
      source,
      factEmbeddings,
    };
  }
}
