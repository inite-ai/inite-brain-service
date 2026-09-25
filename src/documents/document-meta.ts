/**
 * The two populations that share `source_document.meta`, and the seam
 * that keeps them apart.
 *
 * `IngestDocumentDto.meta` is the CALLER channel: operator vocabulary
 * (`data_class: pii`, `department: finance`) that the commit writer
 * projects onto every derived fact's `source.meta`, where ABAC source
 * rules match it. Untrusted input into a security-relevant surface, so
 * it is sanitized (snake_case keys, short scalars, ≤16 entries) and,
 * under SOURCE_META_STRICT, rejected outright rather than silently
 * trimmed — a dropped `data_class` would silently widen access.
 *
 * Brain also writes keys of its OWN onto the same column: the mention
 * wrapper's contextRef identifiers, the 0111 tool-observation hop. Those
 * are not operator vocabulary and never reach `source.meta` —
 * `CommitWriterService.factSource` re-sanitizes `doc.meta` before
 * projecting, so camelCase brain keys are filtered there by design and
 * are read back only off the RAW document header. Running them through
 * the caller's gate on the way IN is therefore a category error: it
 * validates brain's vocabulary against a rule written for somebody
 * else's, and under SOURCE_META_STRICT it 400s the write.
 *
 * "Brain's key" does not mean "brain's value". The contextRef ids are
 * caller strings that merely arrive TYPED (a mention's conversationId is
 * whatever the client sent); only the tool-observation note is
 * synthesised, and the ref is trustworthy because it was just verified.
 * So the internal channel has its own bound — the caller gate's
 * short-scalar limit, applied here, once — and an over-long or non-string
 * identifier is refused, never truncated (a truncated reference is a
 * wrong reference) and never dropped in silence.
 *
 * This module is that boundary. Internal writers hand their bag to
 * `mergeDocumentMeta` as `internal`, which is typed to the declared
 * brain-owned keys (so the channel cannot become a back door for
 * arbitrary unvalidated meta) and never sees the caller gate. The same
 * keys are stripped from the caller's bag on the way through, so a
 * client cannot forge brain provenance — notably `toolObservationRef`,
 * which the commit writer folds into `source.evidence[]` verbatim.
 *
 * Every writer of a `source_document` row names itself (`DocumentWriteOrigin`)
 * and states what it carries: `internal` is a required property whose
 * value may be `undefined`. The async ingest path once reached the store
 * with a positional optional argument simply left off, and every
 * `toolObservationRef` posted with `mode: 'async'` vanished without a
 * word — a shape the type system could not object to. Now it can.
 */
import { BadRequestException } from '@nestjs/common';
import { SOURCE_META_MAX_VALUE_CHARS } from '../policy/source-meta';
import type { KnownEntity } from '../ingest/dto/ingest-mention.dto';

/** Keys the pipeline synthesises for itself. Callers may not assert them. */
export const INTERNAL_DOCUMENT_META_KEYS = [
  // Mention-via-document: the typed MentionContextRef identifiers.
  'conversationId',
  'messageId',
  'eventId',
  // Mention-via-document: the L0 episode captured for the turn, so the
  // committed facts walk back to it exactly as the direct path's do
  // (source.episodeIds), and the speaker's session timezone, which the
  // event-time resolver anchors the local calendar day on.
  'episodeId',
  'timezone',
  // Mention-via-document: the turn's participants (IngestMentionDto
  // .knownEntities by role) — the extractor's coreference framing and
  // the commit writer's externalRef anchor for a first-time speaker.
  // The refs are `vertical:id` pairs.
  'speakerName',
  'speakerRef',
  'addresseeName',
  'addresseeRef',
  // Mention-via-document: the names of every knownEntities anchor the
  // caller attached (participants included), unit-separated — what the
  // extractor's memory context looks up first.
  'knownNames',
  // 0111 tool-observation provenance hop (DocumentIngestService).
  'toolObservationRef',
  'toolObservationNote',
  // Evidence → document bridge (EVIDENCE_DOCUMENT_BRIDGE): the asset
  // whose processor-extracted text this document IS, and the
  // derived_representation row the text was read from.
  'evidenceAssetId',
  'evidenceRepresentationId',
  // Source plane (SOURCE_PLANE_ENABLED): the connection + catalogue row
  // an item came through, and the SourceVersionStamp it was read at —
  // four bounded strings the commit writer folds back into one
  // `source.sourceVersion` so the drift sweep can compare it.
  'sourceConnectionId',
  'sourceItemId',
  'sourceVersionSystem',
  'sourceVersionRef',
  'sourceVersionValue',
  'sourceVersionReadAt',
  // Relearn from raw (relearn-from-raw.service.ts): the question a turn
  // answered only when read raw, and the answer read there — the
  // extractor's focus when the turn is read again.
  'focusQuestion',
  'focusAnswer',
] as const;

export type InternalDocumentMetaKey = (typeof INTERNAL_DOCUMENT_META_KEYS)[number];

/** A brain-owned document-header bag: declared keys, bounded string values. */
export type InternalDocumentMeta = Partial<Record<InternalDocumentMetaKey, string>>;

/**
 * The longest value an internal key may carry — the caller gate's
 * short-scalar limit. The ids are caller strings; the note is
 * `<tool> @ <iso>`; nothing legitimate approaches this.
 */
export const INTERNAL_DOCUMENT_META_MAX_CHARS = SOURCE_META_MAX_VALUE_CHARS;

const RESERVED = new Set<string>(INTERNAL_DOCUMENT_META_KEYS);

/**
 * Build an internal bag, dropping absent entries. A JS object literal
 * materialises a key even when its value is `undefined`, which is how
 * the mention wrapper came to assert `eventId` on requests that never
 * sent one — so the omission has to be explicit, here, once.
 *
 * A present value must be a string of at most
 * INTERNAL_DOCUMENT_META_MAX_CHARS. Anything else is a 400 with the key
 * named: the values are caller-supplied identifiers, and a reference
 * that is silently dropped or cut short is worse than one refused. `null`
 * reads as absent (JSON's way of not sending a field).
 */
export function internalDocumentMeta(
  entries: Partial<Record<InternalDocumentMetaKey, string | null | undefined>>,
): InternalDocumentMeta | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      throw new BadRequestException(`contextRef.${key} must be a string`);
    }
    if (value.length > INTERNAL_DOCUMENT_META_MAX_CHARS) {
      throw new BadRequestException(
        `contextRef.${key} exceeds ${INTERNAL_DOCUMENT_META_MAX_CHARS} characters`,
      );
    }
    if (value.length > 0) out[key] = value;
  }
  return Object.keys(out).length > 0 ? (out as InternalDocumentMeta) : undefined;
}

/**
 * Who is handing the store a document row, and what brain-owned
 * provenance rides with it. `internal` is required so that a writer must
 * SAY what it carries — `undefined` is a statement, an omitted argument
 * was not.
 */
export type DocumentWriteChannel = 'ingest_sync' | 'ingest_async';

export interface DocumentWriteOrigin {
  channel: DocumentWriteChannel;
  internal: InternalDocumentMeta | undefined;
}

/**
 * Who is calling document ingest. Only the in-process writers may attach
 * an internal bag — the mention wrapper (its typed contextRef ids), the
 * evidence bridge (the asset it read the text from) and the source plane
 * (the connection, catalogue row and revision stamp); a wire-facing
 * writer hands over a validated DTO and nothing else, so the channel can
 * never become a way for a client to assert brain's keys. The verified
 * tool-observation hop is threaded by the ingest services themselves,
 * on every channel, from `dto.toolObservationRef`.
 */
export type DocumentIngestOrigin =
  | { channel: 'api' | 'mcp' | 'pack_seed' }
  | { channel: 'mention' | 'evidence' | 'relearn'; internal: InternalDocumentMeta | undefined }
  | {
      channel: 'source';
      internal: InternalDocumentMeta | undefined;
      /**
       * `none` = the pack-less general extractor does NOT run over this
       * document (a rendered record: its facts arrive deterministically
       * as external candidates, and prose extraction over `key: value`
       * lines would only add noise and a model call). Dedicated /
       * external routing is unaffected. Internal channel only — never a
       * caller's choice.
       */
      extraction?: 'general' | 'none';
    };

/** The internal bag an ingest origin contributes — the mention wrapper
 *  (its typed contextRef ids), the evidence bridge (the asset +
 *  representation it read the text from) and the source plane (the
 *  connection, catalogue row and revision stamp); wire-facing channels
 *  carry none. */
export function originInternalMeta(origin: DocumentIngestOrigin): InternalDocumentMeta | undefined {
  return origin.channel === 'mention' ||
    origin.channel === 'evidence' ||
    origin.channel === 'relearn' ||
    origin.channel === 'source'
    ? origin.internal
    : undefined;
}

/**
 * Fold the four source-version header keys back into one stamp (null
 * when the header carries none, or an incomplete set — a half-stamp
 * must never look bound to a version it cannot be swept against).
 */
export function sourceVersionFromHeader(
  meta: Record<string, unknown> | undefined,
): { system: string; ref: string; version: string; readAt: string } | null {
  const system = meta?.['sourceVersionSystem'];
  const ref = meta?.['sourceVersionRef'];
  const version = meta?.['sourceVersionValue'];
  const readAt = meta?.['sourceVersionReadAt'];
  if (
    typeof system !== 'string' ||
    typeof ref !== 'string' ||
    typeof version !== 'string' ||
    typeof readAt !== 'string'
  ) {
    return null;
  }
  return { system, ref, version, readAt };
}

/**
 * Reserved keys a caller's bag tried to assert. Stripping them is not
 * negotiable, but it must not be silent — dropping caller data without
 * saying so is the exact failure mode SOURCE_META_STRICT exists to
 * prevent, so the store warns on a non-empty result. (Under the strict
 * flag this list is unreachable today: every reserved key is camelCase
 * and the sanitizer 400s it first.)
 */
export function reservedKeysIn(callerMeta: Record<string, unknown> | undefined): string[] {
  if (callerMeta === undefined) return [];
  return Object.keys(callerMeta).filter((key) => RESERVED.has(key));
}

/**
 * The stored `meta` column: the caller's bag (verbatim — sanitization
 * is the caller gate's job and happens before this, at the store) minus
 * any reserved key it tried to assert, with brain's own provenance
 * overlaid on top.
 *
 * Absent on both sides ⇒ `undefined`, so a metadata-free document keeps
 * the pre-fix row byte-identical.
 */
export function mergeDocumentMeta(
  callerMeta: Record<string, unknown> | undefined,
  internal: InternalDocumentMeta | undefined,
): Record<string, unknown> | undefined {
  if (callerMeta === undefined && internal === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(callerMeta ?? {})) {
    if (!RESERVED.has(key)) out[key] = value;
  }
  return Object.assign(out, internal ?? {});
}

/**
 * A brain-owned string off the RAW document header. The internal
 * channel never passes the caller gate, so it is read here, not from
 * the sanitized projection; a missing or non-string value is undefined.
 */
export function internalMetaString(
  meta: Record<string, unknown> | undefined,
  key: InternalDocumentMetaKey,
): string | undefined {
  const v = meta?.[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * The turn's participants back out of the internal channel, in the
 * shape the mention wrapper threaded them (IngestMentionDto
 * .knownEntities by role): the `vertical:id` ref and the display name.
 * Absent or malformed → no participant of that role.
 */
export function participantsFromMeta(meta: Record<string, unknown> | undefined): {
  speaker?: KnownEntity | undefined;
  addressee?: KnownEntity | undefined;
} {
  const speaker = participantFromMeta(meta, 'speaker');
  const addressee = participantFromMeta(meta, 'addressee');
  return {
    ...(speaker ? { speaker } : {}),
    ...(addressee ? { addressee } : {}),
  };
}

function participantFromMeta(
  meta: Record<string, unknown> | undefined,
  role: 'speaker' | 'addressee',
): KnownEntity | undefined {
  const ref = internalMetaString(meta, role === 'speaker' ? 'speakerRef' : 'addresseeRef');
  if (!ref) return undefined;
  const cut = ref.indexOf(':');
  if (cut <= 0 || cut === ref.length - 1) return undefined;
  const name = internalMetaString(meta, role === 'speaker' ? 'speakerName' : 'addresseeName');
  return {
    vertical: ref.slice(0, cut),
    id: ref.slice(cut + 1),
    role,
    ...(name ? { name } : {}),
  };
}

/** The separator between names in the `knownNames` internal key. */
export const KNOWN_NAMES_SEPARATOR = '\u001f';

/**
 * The caller's anchor names as one bounded internal value: names in
 * order, unit-separated, cut before the name that would cross the
 * short-scalar limit (a truncated name would be a wrong name).
 */
export function joinKnownNames(names: ReadonlyArray<string | undefined>): string | undefined {
  const out: string[] = [];
  let length = 0;
  for (const raw of names) {
    const name = raw?.trim();
    if (!name) continue;
    const next = length + name.length + (out.length > 0 ? 1 : 0);
    if (next > INTERNAL_DOCUMENT_META_MAX_CHARS) break;
    out.push(name);
    length = next;
  }
  return out.length > 0 ? out.join(KNOWN_NAMES_SEPARATOR) : undefined;
}

/** The names back out of the `knownNames` internal value. */
export function splitKnownNames(value: string | undefined): string[] {
  return value ? value.split(KNOWN_NAMES_SEPARATOR).filter((n) => n.length > 0) : [];
}
