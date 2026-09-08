/**
 * The no-network {@link BrainClient} — the DEFAULT until `--submit` is
 * passed. An operator can point the indexer at any repository and see
 * exactly what it would contribute before a single byte leaves the
 * machine; a tool that reads source and posts it elsewhere should never
 * do so on an unflagged invocation.
 */
import type { CandidatePayload } from './bundle';
import type {
  BrainClient,
  IngestDocumentInput,
  IngestedDocument,
  SubmissionOutcome,
} from './brain-client';

export class DryRunBrainClient implements BrainClient {
  readonly documents: Array<IngestDocumentInput & { documentId: string }> = [];
  readonly submissions: Array<{ documentId: string; payload: CandidatePayload }> = [];

  ingestDocument(input: IngestDocumentInput): Promise<IngestedDocument> {
    const documentId = `dry-run-document:${this.documents.length}`;
    this.documents.push({ ...input, documentId });
    return Promise.resolve({ documentId, deduplicated: false });
  }

  submitCandidates(documentId: string, payload: CandidatePayload): Promise<SubmissionOutcome> {
    this.submissions.push({ documentId, payload });
    return Promise.resolve({
      runId: null,
      staged: { entities: payload.entities.length, facts: payload.facts.length, relations: 0 },
      dropped: [],
      alreadyProcessed: false,
    });
  }
}
