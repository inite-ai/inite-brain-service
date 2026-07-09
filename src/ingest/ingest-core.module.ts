import { Module } from '@nestjs/common';
import { EntityResolverService } from './entity-resolver.service';
import { EntityUpsertService } from './entity-upsert.service';
import { FactEmbeddingService } from './fact-embedding.service';
import { FactResolverService } from './fact-resolver.service';

/**
 * The graph WRITE PRIMITIVES, module-separated from the ingest routes:
 * entity resolution/upsert, fact embedding, and the fn::resolve_fact
 * gateway. Both ingest paths consume these — the legacy mention/fact
 * controllers (IngestModule) and the document pipeline (DocumentsModule).
 * Splitting them out lets IngestModule import DocumentsModule (for the
 * mention-via-document wrapper) without an import cycle.
 */
@Module({
  providers: [
    EntityResolverService,
    EntityUpsertService,
    FactEmbeddingService,
    FactResolverService,
  ],
  exports: [
    EntityResolverService,
    EntityUpsertService,
    FactEmbeddingService,
    FactResolverService,
  ],
})
export class IngestCoreModule {}
