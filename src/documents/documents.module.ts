import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { IngestCoreModule } from '../ingest/ingest-core.module';
import { IndexersModule } from '../indexers/indexers.module';
import { EvidenceModule } from '../evidence/evidence.module';
import { DocumentsController } from './documents.controller';
import { DocumentsIngestController } from './documents-ingest.controller';
import { ExternalCandidatesController } from './external-candidates.controller';
import { ExternalCandidatesService } from './external-candidates.service';
import { IndexerWorkController } from './indexer-work.controller';
import { IndexerWorkService } from './indexer-work.service';
import { IndexerWebhookService } from './indexer-webhook.service';
import { DocumentStoreService } from './document-store.service';
import { CandidateStoreService } from './candidate-store.service';
import { IndexerRunService } from './indexer-run.service';
import { IndexerDispatchService } from './indexer-dispatch.service';
import { CommitWriterService } from './commit-writer.service';
import { CandidateCommitService } from './candidate-commit.service';
import { DocumentIngestService } from './document-ingest.service';
import { DocumentAsyncService } from './document-async.service';
import { DocumentReindexService } from './document-reindex.service';
import { PackSeedIngestService } from './pack-seed-ingest.service';
import { CandidateSweeperService } from './candidate-sweeper.service';
import { MentionViaDocumentService } from './mention-via-document.service';
import { OutcomesModule } from '../outcomes/outcomes.module';

/**
 * The Source → Indexer → Candidates → Brain pipeline (migrations
 * 0048–0050). Depends on IngestCoreModule for the write primitives — the
 * Brain step drives the SAME EntityUpsertService / FactResolverService /
 * fn::resolve_fact the mention path uses — and on IndexersModule for the
 * dedicated extraction + relevance routing machinery.
 */
@Module({
  // EvidenceModule: the sweeper's evidence retention/reconciliation leg (0109).
  imports: [AiModule, IngestCoreModule, IndexersModule, EvidenceModule, OutcomesModule],
  controllers: [
    DocumentsController,
    DocumentsIngestController,
    ExternalCandidatesController,
    IndexerWorkController,
  ],
  providers: [
    DocumentStoreService,
    CandidateStoreService,
    IndexerRunService,
    IndexerDispatchService,
    CommitWriterService,
    CandidateCommitService,
    DocumentIngestService,
    DocumentAsyncService,
    DocumentReindexService,
    PackSeedIngestService,
    CandidateSweeperService,
    MentionViaDocumentService,
    ExternalCandidatesService,
    IndexerWorkService,
    IndexerWebhookService,
  ],
  exports: [
    DocumentIngestService,
    DocumentStoreService,
    CandidateStoreService,
    MentionViaDocumentService,
    PackSeedIngestService,
  ],
})
export class DocumentsModule {}
