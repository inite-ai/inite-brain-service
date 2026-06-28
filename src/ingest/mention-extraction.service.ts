import { Injectable, Logger } from '@nestjs/common';
import { ExtractorService } from '../ai/extractor.service';
import { IngestMentionDto } from './dto/ingest-mention.dto';
import { traceArtifact, traceSpan } from '../common/debug-trace';
import { redactPii } from './ingest-utils';
import { FactEmbeddingService } from './fact-embedding.service';

export interface MentionSource {
  vertical: string;
  eventId?: string;
  conversationId?: string;
  messageId?: string;
  recorder: string;
}

export type MentionPrep =
  | { skip: 'empty' | 'no_entities' }
  | {
      skip: null;
      extraction: any;
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

    const extraction = await traceSpan('ingest.nlu.extract', () =>
      this.extractor.extract(text, companyId),
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

    const factTexts = extraction.facts.map(
      (f: { predicate: string; object: string }) => `${f.predicate}: ${f.object}`,
    );
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

    return { skip: null, extraction, source, factEmbeddings };
  }
}
