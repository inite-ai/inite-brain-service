import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { IngestModule } from '../ingest/ingest.module';
import { DocumentsController } from './documents.controller';
import { DocumentStoreService } from './document-store.service';
import { CandidateStoreService } from './candidate-store.service';
import { IndexerRunService } from './indexer-run.service';
import { CommitWriterService } from './commit-writer.service';
import { CandidateCommitService } from './candidate-commit.service';
import { DocumentIngestService } from './document-ingest.service';

/**
 * The Source → Indexer → Candidates → Brain pipeline (docs: migrations
 * 0048–0050). Depends on IngestModule for the write primitives — the
 * Brain step drives the SAME EntityUpsertService / FactResolverService /
 * fn::resolve_fact the mention path uses.
 */
@Module({
  imports: [AiModule, IngestModule],
  controllers: [DocumentsController],
  providers: [
    DocumentStoreService,
    CandidateStoreService,
    IndexerRunService,
    CommitWriterService,
    CandidateCommitService,
    DocumentIngestService,
  ],
  exports: [DocumentIngestService, DocumentStoreService, CandidateStoreService],
})
export class DocumentsModule {}
