import { Module } from '@nestjs/common';
import { OutcomesModule } from '../outcomes/outcomes.module';
import { EntityResolverService } from './entity-resolver.service';
import { EntityUpsertService } from './entity-upsert.service';
import { FactEmbeddingService } from './fact-embedding.service';
import { FactResolverService } from './fact-resolver.service';
import { EpisodeStoreService } from './episode-store.service';
import { MemoryContextService } from './memory-context.service';

/**
 * The graph WRITE PRIMITIVES, module-separated from the ingest routes:
 * entity resolution/upsert, fact embedding, and the fn::resolve_fact
 * gateway. Both ingest paths consume these — the legacy mention/fact
 * controllers (IngestModule) and the document pipeline (DocumentsModule).
 * Splitting them out lets IngestModule import DocumentsModule (for the
 * mention-via-document wrapper) without an import cycle.
 */
@Module({
  // OutcomesModule supplies the 0107 contradicted-outcome writer the
  // fact resolver emits from its post-call tail (@Optional injection).
  imports: [OutcomesModule],
  providers: [
    EntityResolverService,
    EntityUpsertService,
    FactEmbeddingService,
    FactResolverService,
    // L0 episode capture is a write primitive too: both ingest paths — the
    // direct mention persister and the document commit a stock deployment
    // routes mentions through — capture the turn before extraction.
    EpisodeStoreService,
    // What the extractor reads before it extracts: the conversation so
    // far, the known entities and their facts (memory-context.service).
    MemoryContextService,
  ],
  exports: [
    EntityResolverService,
    EntityUpsertService,
    FactEmbeddingService,
    FactResolverService,
    EpisodeStoreService,
    MemoryContextService,
  ],
})
export class IngestCoreModule {}
