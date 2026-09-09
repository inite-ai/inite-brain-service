import { BadRequestException } from '@nestjs/common';
import { DocumentAsyncService } from '../src/documents/document-async.service';
import type { DocumentStoreService } from '../src/documents/document-store.service';
import type { DocumentIngestService } from '../src/documents/document-ingest.service';
import type { IngestDocumentDto } from '../src/documents/dto/ingest-document.dto';
import type { DocumentWriteOrigin } from '../src/documents/document-meta';
import { runWithRequestContext } from '../src/common/request-context';

/**
 * Every writer of a `source_document` row declares its origin, and the
 * async ingest path carries the same provenance the sync path does.
 *
 * The defect: `DocumentAsyncService.ingestAsync` reached the store with
 * the positional `internalMeta?` argument simply left off, so a
 * `toolObservationRef` posted with `mode: 'async'` was neither verified
 * nor stored — every fact the queue later committed lacked the hop, and
 * nothing said so. A positional optional cannot be required by the type
 * system; an object parameter with a required `internal` field can.
 */

const dto = (extra: Partial<IngestDocumentDto> = {}): IngestDocumentDto =>
  ({
    kind: 'markdown',
    text: 'Fetched report: Acme is platinum tier.',
    occurredAt: '2026-09-01T10:00:00.000Z',
    contextRef: { vertical: 'crm' },
    mode: 'async',
    ...extra,
  }) as IngestDocumentDto;

function makeAsync(opts: {
  enabled?: boolean;
  verified?: { tool: string; createdAt: string } | null;
}) {
  const created: Array<{ dto: IngestDocumentDto; origin: DocumentWriteOrigin }> = [];
  const store = {
    createOrGet: async (_co: string, d: IngestDocumentDto, origin: DocumentWriteOrigin) => {
      created.push({ dto: d, origin });
      return {
        doc: { id: 'source_document:d1', contentHash: 'a'.repeat(64), chunkCount: 1 },
        chunks: [{ index: 0, text: d.text }],
        deduplicated: false,
      };
    },
    setStatus: async () => undefined,
  };
  const dispatch = { selectDedicated: async () => [], planExternal: async () => [] };
  const candidates = { ensureRunPending: async () => undefined };
  const claim = { enqueue: async () => ({ created: true }) };
  const toolObservations = {
    enabled: () => opts.enabled ?? true,
    verifyRef: async () => opts.verified ?? null,
  };
  const svc = new DocumentAsyncService(
    store as never,
    dispatch as never,
    {} as never,
    candidates as never,
    undefined,
    claim as never,
    toolObservations as never,
  );
  return { svc, created };
}

describe('DocumentAsyncService threads the tool-observation hop onto the header', () => {
  it('a verified ref rides the internal bag into the store, on the async channel', async () => {
    const { svc, created } = makeAsync({
      verified: { tool: 'web_fetch', createdAt: '2026-09-01T09:59:00.000Z' },
    });
    const res = await runWithRequestContext({ correlationId: 'a1' }, () =>
      svc.ingestAsync('co_x', dto({ toolObservationRef: 'tool_observation:abc' }), {
        channel: 'api',
      }),
    );
    expect(res.mode).toBe('async');
    expect(created).toHaveLength(1);
    expect(created[0]!.origin).toEqual({
      channel: 'ingest_async',
      internal: {
        toolObservationRef: 'tool_observation:abc',
        toolObservationNote: 'web_fetch @ 2026-09-01T09:59:00.000Z',
      },
    });
  });

  it('an unknown ref is a 400 before anything is written — never a silent drop', async () => {
    const { svc, created } = makeAsync({ verified: null });
    await expect(
      runWithRequestContext({ correlationId: 'a2' }, () =>
        svc.ingestAsync('co_x', dto({ toolObservationRef: 'tool_observation:nope' }), {
          channel: 'api',
        }),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(created).toHaveLength(0);
  });

  it('flag off ⇒ the ref is ignored and the header carries no internal bag (byte-identical)', async () => {
    const { svc, created } = makeAsync({ enabled: false });
    await runWithRequestContext({ correlationId: 'a3' }, () =>
      svc.ingestAsync('co_x', dto({ toolObservationRef: 'tool_observation:abc' }), {
        channel: 'api',
      }),
    );
    expect(created[0]!.origin).toEqual({ channel: 'ingest_async', internal: undefined });
  });

  it('a document without a ref stores no internal bag at all', async () => {
    const { svc, created } = makeAsync({});
    await runWithRequestContext({ correlationId: 'a4' }, () =>
      svc.ingestAsync('co_x', dto(), { channel: 'api' }),
    );
    expect(created[0]!.origin.internal).toBeUndefined();
  });
});

describe('the write seam is a type, not a convention', () => {
  it('a writer cannot reach the store, or ingest, without declaring its origin', () => {
    // These lines are the test: each `@ts-expect-error` FAILS `pnpm
    // typecheck` if the call it guards ever compiles again. The async
    // path's original bug was exactly the first shape.
    const store = {} as DocumentStoreService;
    const ingest = {} as DocumentIngestService;
    const async = {} as DocumentAsyncService;
    const d = dto();
    // @ts-expect-error — origin is required; an omitted argument no longer type-checks
    void (() => store.createOrGet('co_x', d));
    // @ts-expect-error — `internal` is a required property (its VALUE may be undefined)
    void (() => store.createOrGet('co_x', d, { channel: 'ingest_sync' }));
    // @ts-expect-error — the ingest entry names its channel
    void (() => ingest.ingestDocument('co_x', d));
    // @ts-expect-error — so does the async entry
    void (() => async.ingestAsync('co_x', d));
    // @ts-expect-error — a wire channel cannot smuggle an internal bag
    void (() => ingest.ingestDocument('co_x', d, { channel: 'api', internal: {} }));
    expect(true).toBe(true);
  });
});
