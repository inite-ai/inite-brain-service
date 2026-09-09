import { BadRequestException } from '@nestjs/common';
import { internalDocumentMeta, type InternalDocumentMeta } from './document-meta';
import type { ToolObservationService } from '../outcomes/tool-observation.service';

/**
 * Thread a `tool_observation:<id>` provenance ref (0111) onto the
 * document header. Under TOOL_OBSERVATIONS_ENABLED the ref is validated
 * against the tenant's own rows (unknown/foreign/malformed ⇒ 400 — a
 * provenance claim must not be storable unverified) and stored in doc
 * meta (FLEXIBLE) together with a content-free note ('<tool> @ <iso>')
 * the commit-writer folds into every committed fact's source.evidence[].
 * Flag off ⇒ the ref is ignored and the write path is byte-identical.
 *
 * These two keys are BRAIN's, not the caller's — `toolObservationNote` is
 * synthesised outright from the verified row, and the ref is only
 * trustworthy because it was just verified. They therefore ride the
 * internal document-meta channel (document-meta.ts) instead of being
 * folded into `dto.meta`, where SOURCE_META_STRICT would reject their
 * camelCase against a rule written for operator vocabulary.
 *
 * One function for both ingest paths. The sync service had this as a
 * private method and the async service had nothing, which is how every
 * ref posted with `mode: 'async'` came to be dropped.
 */
export async function toolObservationMeta(
  toolObservations: ToolObservationService | undefined,
  companyId: string,
  ref: string | undefined,
): Promise<InternalDocumentMeta | undefined> {
  if (ref === undefined || !toolObservations?.enabled()) return undefined;
  const verified = await toolObservations.verifyRef(companyId, ref);
  if (!verified) {
    throw new BadRequestException(
      'toolObservationRef does not resolve to a tool_observation row in this tenant',
    );
  }
  return internalDocumentMeta({
    toolObservationRef: ref,
    toolObservationNote: `${verified.tool} @ ${verified.createdAt}`,
  });
}
