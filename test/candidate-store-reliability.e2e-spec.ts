/**
 * Reliability of the async run ledger (audit wave F3), against a real
 * SurrealDB:
 *   BUG1 — a run pre-created 'pending' is counted by countNonTerminalRuns
 *          from the outset (so a fast pass can't commit before a slower
 *          run's row exists), and createRun transitions pending → running.
 *   BUG4 — the pending/failed reopen is a compare-and-swap: the second
 *          concurrent createRun on an already-running row does NOT re-open.
 *   BUG2 — findDocsNeedingCommit re-drives a 'committed' document that
 *          still has pending candidates (a lost external commit), not only
 *          'indexing'/'indexed' ones.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { DocumentStoreService } from '../src/documents/document-store.service';
import { CandidateStoreService } from '../src/documents/candidate-store.service';

describe('candidate-store run-ledger reliability', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  let store: CandidateStoreService;

  beforeAll(async () => {
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    f = await createApp({ companyId: 'co_run_ledger_e2e' });
    store = f.app.get(CandidateStoreService);
  });

  afterAll(async () => {
    delete process.env.DOCUMENT_INGEST_ENABLED;
    if (f) await f.close();
  });

  async function makeDoc(text: string): Promise<string> {
    f.extractor.setScript({ entities: [], facts: [], edges: [] });
    const r = await f.http.post('/v1/ingest/document').set(auth()).send({
      kind: 'markdown',
      text,
      occurredAt: '2026-07-01T10:00:00.000Z',
      contextRef: { vertical: 'ledger_e2e' },
    });
    expect(r.status).toBe(201);
    return r.body.documentId as string;
  }

  it('pending pre-created run is counted, then createRun transitions it (BUG1)', async () => {
    const docId = await makeDoc('Ledger doc for pending pre-creation.');

    await store.ensureRunPending(f.companyId, {
      docId,
      packId: 'pack_a',
      packVersion: 'v1',
    });
    // Counted before any job has started — the whole point of BUG1's fix.
    expect(await store.countNonTerminalRuns(f.companyId, docId)).toBeGreaterThanOrEqual(1);

    const first = await store.createRun(f.companyId, {
      docId,
      packId: 'pack_a',
      packVersion: 'v1',
    });
    expect(first.created).toBe(true); // pending → running (CAS winner)
    // Still non-terminal (now 'running'), so commit still defers.
    expect(await store.countNonTerminalRuns(f.companyId, docId)).toBeGreaterThanOrEqual(1);

    // A second createRun on the now-'running' row must NOT reopen it (BUG4).
    const second = await store.createRun(f.companyId, {
      docId,
      packId: 'pack_a',
      packVersion: 'v1',
    });
    expect(second.created).toBe(false);
    expect(second.runId).toBe(first.runId);

    await store.finalizeRun(f.companyId, { runId: first.runId, status: 'succeeded' });
    expect(await store.countNonTerminalRuns(f.companyId, docId)).toBe(0);
  });

  it('findDocsNeedingCommit re-drives a committed doc with pending candidates (BUG2)', async () => {
    const docId = await makeDoc('Ledger doc for external orphaned commit.');
    const run = await store.createRun(f.companyId, {
      docId,
      packId: 'pack_ext',
      packVersion: 'v1',
    });
    await store.finalizeRun(f.companyId, { runId: run.runId, status: 'succeeded' });

    const surreal = f.app.get(SurrealService);
    const docStore = f.app.get(DocumentStoreService);
    // Seed a leftover pending candidate, then mark the doc 'committed' — the
    // shape an external submission whose inline commit was lost leaves behind.
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `CREATE candidate SET
           docId = type::record('source_document', $doc),
           runId = type::record('indexer_run', $run),
           chunkSeq = 0, kind = 'fact', status = 'pending',
           payload = { predicate: 'name', object: 'Orphan' }`,
        { doc: docId.split(':')[1], run: run.runId.split(':')[1] },
      );
    });
    await docStore.setStatus({ companyId: f.companyId, docId, status: 'committed' });

    const needing = await store.findDocsNeedingCommit(f.companyId);
    // Before the fix this filtered to indexing/indexed only, so a committed
    // doc's orphaned candidates were never re-driven → expired = memory loss.
    expect(needing).toContain(docId);
  });
});
