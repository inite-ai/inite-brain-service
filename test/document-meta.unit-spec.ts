import { BadRequestException } from '@nestjs/common';
import type { Surreal } from 'surrealdb';
import {
  internalDocumentMeta,
  mergeDocumentMeta,
  reservedKeysIn,
  INTERNAL_DOCUMENT_META_KEYS,
} from '../src/documents/document-meta';
import { DocumentStoreService } from '../src/documents/document-store.service';
import type { SurrealService } from '../src/db/surreal.service';
import { MentionViaDocumentService } from '../src/documents/mention-via-document.service';
import type { DocumentIngestService } from '../src/documents/document-ingest.service';
import type { IngestDocumentDto } from '../src/documents/dto/ingest-document.dto';
import type { IngestMentionDto } from '../src/ingest/dto/ingest-mention.dto';
import { runWithRequestContext } from '../src/common/request-context';

/**
 * The caller/internal boundary over `source_document.meta`.
 *
 * `meta` carries two populations: operator vocabulary the caller supplies
 * (projected onto `source.meta`, matched by ABAC source rules, policed by
 * SOURCE_META_STRICT) and provenance brain synthesises for itself (the
 * mention wrapper's contextRef identifiers, the 0111 tool-observation
 * hop). The incident of 2026-09-02 was the second running through the
 * first's gate. These cases pin the seam that keeps them apart.
 */

describe('internalDocumentMeta', () => {
  it('drops absent entries instead of materialising undefined keys', () => {
    // The defect in one line: `{ eventId: undefined }` HAS the key, so
    // the sanitizer reported "key 'eventId' is not snake_case" for
    // requests that never sent an eventId.
    const bag = internalDocumentMeta({
      conversationId: 'c1',
      messageId: undefined,
      eventId: undefined,
    });
    expect(bag).toEqual({ conversationId: 'c1' });
    expect(Object.prototype.hasOwnProperty.call(bag ?? {}, 'eventId')).toBe(false);
  });

  it('collapses an all-absent bag to undefined (metaless rows stay metaless)', () => {
    expect(internalDocumentMeta({})).toBeUndefined();
    expect(
      internalDocumentMeta({ conversationId: undefined, messageId: undefined }),
    ).toBeUndefined();
  });

  it('drops empty strings — an empty id is not provenance', () => {
    expect(internalDocumentMeta({ conversationId: '' })).toBeUndefined();
  });
});

describe('mergeDocumentMeta', () => {
  it("keeps caller meta verbatim (sanitizing is the gate's job, not the merge's)", () => {
    expect(mergeDocumentMeta({ data_class: 'pii', department: 'people' }, undefined)).toEqual({
      data_class: 'pii',
      department: 'people',
    });
  });

  it('overlays brain provenance on top of the caller bag', () => {
    expect(mergeDocumentMeta({ data_class: 'pii' }, { conversationId: 'c1' })).toEqual({
      data_class: 'pii',
      conversationId: 'c1',
    });
  });

  it('strips reserved keys a caller tried to assert (no forged provenance)', () => {
    // toolObservationRef is folded into every derived fact's
    // source.evidence[] verbatim, so a caller-asserted one would be a
    // fabricated provenance hop. It is brain's key; the caller's copy dies
    // here regardless of SOURCE_META_STRICT.
    const merged = mergeDocumentMeta(
      { data_class: 'pii', toolObservationRef: 'tool_observation:forged' },
      { toolObservationRef: 'tool_observation:verified' },
    );
    expect(merged).toEqual({
      data_class: 'pii',
      toolObservationRef: 'tool_observation:verified',
    });
  });

  it('strips a reserved key even when brain asserts nothing', () => {
    expect(mergeDocumentMeta({ conversationId: 'spoofed', ok_key: 'v' }, undefined)).toEqual({
      ok_key: 'v',
    });
  });

  it('nothing on either side ⇒ undefined; an empty caller bag stays an object', () => {
    expect(mergeDocumentMeta(undefined, undefined)).toBeUndefined();
    expect(mergeDocumentMeta({}, undefined)).toEqual({});
  });

  it('declares both internal writers', () => {
    expect([...INTERNAL_DOCUMENT_META_KEYS]).toEqual([
      'conversationId',
      'messageId',
      'eventId',
      'toolObservationRef',
      'toolObservationNote',
    ]);
  });
});

describe('reservedKeysIn — the strip is never silent', () => {
  it('names every reserved key a caller asserted', () => {
    expect(
      reservedKeysIn({ data_class: 'pii', conversationId: 'x', toolObservationRef: 'y' }),
    ).toEqual(['conversationId', 'toolObservationRef']);
  });

  it('is empty for an honest bag or none at all', () => {
    expect(reservedKeysIn({ data_class: 'pii' })).toEqual([]);
    expect(reservedKeysIn(undefined)).toEqual([]);
  });
});

// ── the store gate: caller meta only ──────────────────────────────────

function makeStore() {
  const created: Array<Record<string, unknown>> = [];
  const db = {
    query: async (sql: string, vars?: Record<string, unknown>) => {
      if (sql.startsWith('CREATE')) {
        const row = vars!.d as Record<string, unknown>;
        created.push(row);
        return [[{ ...row, id: 'source_document:d1' }]];
      }
      return [[]];
    },
  } as unknown as Surreal;
  const surreal = {
    withCompany: (_co: string, cb: (d: Surreal) => unknown) => cb(db),
  } as unknown as SurrealService;
  return { store: new DocumentStoreService(surreal), created };
}

const docDto = (meta?: Record<string, unknown>): IngestDocumentDto =>
  ({
    kind: 'chat',
    text: 'Acme moved to the gold tier',
    occurredAt: '2026-09-02T10:00:00.000Z',
    contextRef: { vertical: 'crm' },
    ...(meta ? { meta } : {}),
  }) as unknown as IngestDocumentDto;

describe('DocumentStoreService: SOURCE_META_STRICT polices the caller channel only', () => {
  afterEach(() => {
    delete process.env.SOURCE_META_STRICT;
  });

  it('rejects non-operator CALLER meta under the flag (gate unchanged)', async () => {
    process.env.SOURCE_META_STRICT = '1';
    const { store } = makeStore();
    await expect(store.createOrGet('co_x', docDto({ dataClass: 'pii' }))).rejects.toThrow(
      BadRequestException,
    );
  });

  it('accepts brain-synthesised meta under the flag and stores it', async () => {
    process.env.SOURCE_META_STRICT = '1';
    const { store, created } = makeStore();
    await store.createOrGet('co_x', docDto(), {
      conversationId: 'c1',
      messageId: 'm1',
    });
    expect(created[0]!.meta).toEqual({ conversationId: 'c1', messageId: 'm1' });
  });

  it('a document with neither bag stores no meta at all (byte-identical row)', async () => {
    const { store, created } = makeStore();
    await store.createOrGet('co_x', docDto());
    expect(created[0]!.meta).toBeUndefined();
  });
});

// ── the mention wrapper no longer asserts caller meta ─────────────────

function makeWrapper() {
  const calls: Array<{ dto: IngestDocumentDto; internal: unknown }> = [];
  const documents = {
    ingestDocument: async (_co: string, dto: IngestDocumentDto, internal?: unknown) => {
      calls.push({ dto, internal });
      return {
        documentId: 'source_document:d1',
        deduplicated: false,
        chunkCount: 1,
        mode: 'sync',
        runs: [],
        committed: {
          entityIds: ['knowledge_entity:e1'],
          factIds: ['knowledge_fact:f1'],
          edgeIds: [],
        },
        counts: { pending: 1, committed: 1, merged: 0, rejected: 0 },
      };
    },
  } as unknown as DocumentIngestService;
  return { svc: new MentionViaDocumentService(documents), calls };
}

const mentionDto = (contextRef: Record<string, unknown>): IngestMentionDto =>
  ({
    text: 'Acme moved to the gold tier',
    contextRef,
    emittedAt: '2026-09-02T10:00:00.000Z',
  }) as unknown as IngestMentionDto;

describe('MentionViaDocumentService routes contextRef ids off the caller channel', () => {
  it('sends NO caller meta, and the ids ride the internal bag instead', async () => {
    const { svc, calls } = makeWrapper();
    await runWithRequestContext({ correlationId: 'm1' }, () =>
      svc.ingest(
        'co_x',
        mentionDto({ vertical: 'crm', conversationId: 'c1', messageId: 'm1', eventId: 'e1' }),
      ),
    );
    expect(Object.prototype.hasOwnProperty.call(calls[0]!.dto, 'meta')).toBe(false);
    expect(calls[0]!.internal).toEqual({
      conversationId: 'c1',
      messageId: 'm1',
      eventId: 'e1',
    });
  });

  it('omits identifiers the caller never sent (the eventId proof)', async () => {
    const { svc, calls } = makeWrapper();
    await runWithRequestContext({ correlationId: 'm2' }, () =>
      svc.ingest('co_x', mentionDto({ vertical: 'crm', conversationId: 'c1' })),
    );
    expect(calls[0]!.internal).toEqual({ conversationId: 'c1' });
  });

  it('a bare contextRef produces no internal bag at all', async () => {
    const { svc, calls } = makeWrapper();
    await runWithRequestContext({ correlationId: 'm3' }, () =>
      svc.ingest('co_x', mentionDto({ vertical: 'crm' })),
    );
    expect(calls[0]!.internal).toBeUndefined();
  });
});
