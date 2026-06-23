/**
 * Translates a normalized LoCoMo conversation into brain ingest events.
 *
 * Each turn becomes one `POST /v1/ingest/mention` call — the body
 * carries the raw utterance + speaker + session timestamp, and
 * brain's NLU extractor turns it into entities and facts. We do NOT
 * pre-extract facts ourselves; the whole point is to evaluate brain's
 * extraction + retrieval pipeline, not our parser of LoCoMo.
 *
 * Tenancy: brain's API-key model binds one key to one companyId, so
 * we keep ALL conversations in one tenant and namespace by entity
 * id. Each sample's speakers become entityId `<sampleId>__alice`,
 * `<sampleId>__bob` — the `__` separator survives `sanitizeId` and
 * gives the operator a single grep to find one sample's facts.
 *
 * Timing: every turn carries its session's date as `emittedAt`,
 * which the extractor threads into `validFrom`. asOf queries from
 * the QA layer work — "what did Alice say in session 5?" runs with
 * asOf = session_5_date.
 *
 * Idempotency: source.messageId includes `:<sampleId>:<dia_id>` so a
 * partial run can be resumed by skipping turns whose IDs already
 * exist. This is left as a hook on the IngestSink interface — the
 * default HTTP sink doesn't dedupe.
 */
import type { NormalizedConversation, LocomoTurn } from './types';

export interface IngestSink {
  /**
   * Register a speaker entity. The vertical is set by the sink (default
   * 'locomo'); the id is sample-prefixed so two samples can share a
   * speaker name ("Alice") without collision.
   */
  registerSpeaker(input: {
    /**
     * Optional tenant pin — defaults to the api-key's companyId. Kept
     * on the interface so a future admin-key sink can route per-call.
     */
    companyId?: string;
    entityId: string;
    name: string;
    validFrom: string;
  }): Promise<void>;

  /** Stream one conversation turn into brain's NLU extractor. */
  ingestMention(input: {
    companyId?: string;
    speakerEntityId: string;
    text: string;
    validFrom: string;
    sourceMessageId: string;
  }): Promise<void>;
}

export interface IngestPlan {
  /** Per-sample speaker entities — id is `<sampleId>__<speakerName>`. */
  speakers: Array<{ entityId: string; name: string; validFrom: string }>;
  /**
   * Per-turn mentions. speakerEntityId matches one of the registered
   * speakers above; sourceMessageId carries the sample id + dia_id so
   * partial-run resume is trivial.
   */
  mentions: Array<{
    speakerEntityId: string;
    text: string;
    validFrom: string;
    sourceMessageId: string;
  }>;
}

/**
 * Build the ingest plan without sending anything. The runner can dry-
 * run for sanity (turn count, date range, entity ids) before paying
 * for the extractor LLM calls.
 */
export function planIngest(conv: NormalizedConversation): IngestPlan {
  const earliestSession = conv.sessions[0];
  const baseDate = earliestSession?.dateTime ?? new Date(0).toISOString();
  const sampleSlug = sanitizeId(conv.sampleId);
  const prefix = `${sampleSlug}__`;
  const speakerAId = prefix + sanitizeId(conv.speakerA);
  const speakerBId = prefix + sanitizeId(conv.speakerB);
  const speakers = [
    { entityId: speakerAId, name: conv.speakerA, validFrom: baseDate },
    { entityId: speakerBId, name: conv.speakerB, validFrom: baseDate },
  ];
  const mentions: IngestPlan['mentions'] = [];
  for (const session of conv.sessions) {
    for (const turn of session.turns) {
      mentions.push({
        speakerEntityId: speakerEntityFor(
          turn,
          speakerAId,
          speakerBId,
          prefix,
          conv,
        ),
        text: turn.text,
        validFrom: session.dateTime,
        sourceMessageId: `locomo:${conv.sampleId}:${turn.dia_id}`,
      });
    }
  }
  return { speakers, mentions };
}

export async function executeIngest(
  plan: IngestPlan,
  sink: IngestSink,
  companyId?: string,
): Promise<void> {
  for (const speaker of plan.speakers) {
    await sink.registerSpeaker({ companyId, ...speaker });
  }
  for (const mention of plan.mentions) {
    await sink.ingestMention({ companyId, ...mention });
  }
}

function sanitizeId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function speakerEntityFor(
  turn: LocomoTurn,
  speakerAId: string,
  speakerBId: string,
  prefix: string,
  conv: NormalizedConversation,
): string {
  if (turn.speaker === conv.speakerA) return speakerAId;
  if (turn.speaker === conv.speakerB) return speakerBId;
  // Multiparty conversation — keep the foreign speaker namespaced
  // under the same sample prefix so cross-talk between samples is
  // still impossible.
  const stranger = sanitizeId(turn.speaker);
  return stranger ? prefix + stranger : speakerAId;
}
