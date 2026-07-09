import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { IngestModule } from '../ingest/ingest.module';
import { IndexersModule } from '../indexers/indexers.module';
import { DocumentsController } from './documents.controller';
import { DocumentsIngestController } from './documents-ingest.controller';
import { DocumentStoreService } from './document-store.service';
import { CandidateStoreService } from './candidate-store.service';
import { IndexerRunService } from './indexer-run.service';
import { IndexerDispatchService } from './indexer-dispatch.service';
import { CommitWriterService } from './commit-writer.service';
import { CandidateCommitService } from './candidate-commit.service';
import { DocumentIngestService } from './document-ingest.service';
import { DocumentAsyncService } from './document-async.service';
import { CandidateSweeperService } from './candidate-sweeper.service';

/**
 * The Source → Indexer → Candidates → Brain pipeline (migrations
 * 0048–0050). Depends on IngestModule for the write primitives — the
 * Brain step drives the SAME EntityUpsertService / FactResolverService /
 * fn::resolve_fact the mention path uses — and on IndexersModule for the
 * dedicated extraction + relevance routing machinery.
 */
@Module({
  imports: [AiModule, IngestModule, IndexersModule],
  controllers: [DocumentsController, DocumentsIngestController],
  providers: [
    DocumentStoreService,
    CandidateStoreService,
    IndexerRunService,
    IndexerDispatchService,
    CommitWriterService,
    CandidateCommitService,
    DocumentIngestService,
    DocumentAsyncService,
    CandidateSweeperService,
  ],
  exports: [DocumentIngestService, DocumentStoreService, CandidateStoreService],
})
export class DocumentsModule {}
