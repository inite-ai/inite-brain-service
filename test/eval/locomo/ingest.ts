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
import { runPool } from '../harness/pool';

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
    companyId?: string | undefined;
    entityId: string;
    name: string;
    validFrom: string;
  }): Promise<void>;

  /** Stream one conversation turn into brain's NLU extractor. */
  ingestMention(input: {
    companyId?: string | undefined;
    speakerEntityId: string;
    /** Speaker display name — drives first-person coreference in the extractor. */
    speakerName: string;
    /**
     * The addressed participant (the other speaker in 2-party dialogue) —
     * drives second-person ("you") coreference. Omitted when ambiguous.
     */
    addressee?: { entityId: string; name: string } | undefined;
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
    speakerName: string;
    addressee?: { entityId: string; name: string } | undefined;
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
      const speakerEntityId = speakerEntityFor(
        turn,
        speakerAId,
        speakerBId,
        prefix,
        conv,
      );
      // Addressee = the other main speaker (2-party dialogue). Drives
      // second-person "you" coreference. Omitted for stranger turns where
      // the addressee is ambiguous.
      const addressee =
        speakerEntityId === speakerAId
          ? { entityId: speakerBId, name: conv.speakerB }
          : speakerEntityId === speakerBId
            ? { entityId: speakerAId, name: conv.speakerA }
            : undefined;
      // Image turns carry the answer-bearing detail in the BLIP caption
      // ("they made this!" + photo of a cup with a dog face). The
      // full-context baseline renders captions into its transcript
      // (locomo-fullcontext-baseline.ts) — omitting them here blinded the
      // memory side to ~21% of turns and skewed every FC comparison.
      // Same rendering as the baseline, for protocol symmetry.
      const caption = turn.blip_caption
        ? ` [shares an image: ${turn.blip_caption}]`
        : '';
      mentions.push({
        speakerEntityId,
        speakerName: turn.speaker,
        addressee,
        text: `${turn.text}${caption}`,
        validFrom: session.dateTime,
        sourceMessageId: `locomo:${conv.sampleId}:${turn.dia_id}`,
      });
    }
  }
  return { speakers, mentions };
}

export interface ExecuteIngestOptions {
  companyId?: string;
  /** Attempts per mention before giving up on it. Default 4. */
  retries?: number;
  /** Base backoff (ms) — grows exponentially per attempt. Default 3000. */
  backoffMs?: number;
  /** Called once per mention that exhausts its retries and is skipped. */
  onDrop?: (info: { sourceMessageId: string; error: string }) => void;
  /**
   * Max mentions in flight. Default 1 = serial (byte-identical to the old
   * loop). >1 fans out the per-mention POSTs — the eval-iteration speedup,
   * safe because the server serializes same-(entity,predicate) writes behind
   * a KeyedMutex; the only nondeterminism is recordedAt tiebreak order among
   * same-validFrom facts (extraction is already nondeterministic at temp 0.1).
   * Hold this constant across an A/B pair.
   */
  concurrency?: number;
}

export interface IngestOutcome {
  ingested: number;
  /** Mentions that failed every attempt and were skipped. */
  dropped: Array<{ sourceMessageId: string; error: string }>;
}

/**
 * Stream the plan into brain. Resilient by design: a single transient
 * upstream hiccup (an OpenAI "Connection error" / 429 mid-extraction surfaces
 * as a 500 here) must NOT throw away a 40-minute ingest. Each mention is
 * retried with exponential backoff; one that still fails is dropped and the
 * run continues. Drops are reported (via onDrop and the returned outcome) —
 * never silently swallowed, so a degraded run is visible, not mistaken for a
 * clean one. Speaker registration still throws (it's cheap, ordered, and a
 * failure there means the tenant/key is wrong — not worth continuing).
 *
 * Retry caveat (honest): a mention is NOT written in one transaction — the
 * server persists facts one-by-one and has no messageId idempotency. So a
 * failure AFTER partial persist (a 5xx or lost response once some facts are
 * committed) will, on retry, re-run a fresh (nondeterministic) extraction and
 * write a second, possibly different, fact set on top of the survivors —
 * inflating append_only predicates. In practice the dominant transient is an
 * OpenAI error DURING extraction, before any write, which retries cleanly;
 * post-commit failures are rare. This is acceptable for a benchmark but is a
 * real reproducibility caveat, not a guarantee. A true fix is server-side
 * messageId idempotency (skip an already-ingested mention) — out of scope here.
 */
export async function executeIngest(
  plan: IngestPlan,
  sink: IngestSink,
  options: ExecuteIngestOptions | string = {},
): Promise<IngestOutcome> {
  // Back-compat: the 3rd arg used to be a bare companyId string.
  const opts: ExecuteIngestOptions =
    typeof options === 'string' ? { companyId: options } : options;
  const companyId = opts.companyId;
  const retries = Math.max(1, opts.retries ?? 4);
  const backoffMs = Math.max(0, opts.backoffMs ?? 3000);
  const concurrency = Math.max(1, Math.trunc(opts.concurrency ?? 1));

  // Speakers register first (ordered, cheap) — a failure here means the
  // tenant/key is wrong, so it still throws.
  for (const speaker of plan.speakers) {
    await sink.registerSpeaker({ companyId, ...speaker });
  }

  const dropped: IngestOutcome['dropped'] = [];
  let ingested = 0;

  // One mention through its retry budget. Shared by the serial and
  // concurrent paths so the resilience contract is identical.
  const ingestOne = async (mention: IngestPlan['mentions'][number]) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await sink.ingestMention({ companyId, ...mention });
        ingested++;
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < retries) {
          const wait = backoffMs * Math.pow(3, attempt - 1);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }
    const error = lastErr instanceof Error ? lastErr.message : String(lastErr);
    dropped.push({ sourceMessageId: mention.sourceMessageId, error });
    opts.onDrop?.({ sourceMessageId: mention.sourceMessageId, error });
  };

  // concurrency 1 = serial, byte-identical to the original loop.
  await runPool(concurrency, plan.mentions, ingestOne);
  return { ingested, dropped };
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
