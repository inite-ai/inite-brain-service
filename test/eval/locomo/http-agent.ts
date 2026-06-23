/**
 * HTTP-based QaAgent + IngestSink.
 *
 * Drives brain directly through the v1 HTTP surface — no Claude, no
 * MCP transport. Useful for two things:
 *   - CI baseline (deterministic, comparable run-to-run without an
 *     Anthropic key in the pipeline)
 *   - Component isolation when debugging which leg of the QA pipeline
 *     went wrong (retrieval miss vs synthesize hallucination)
 *
 * For the agent-natural number reported against Mem0 / Zep / MemGPT,
 * a Claude-MCP agent is the right path (separate phase — needs an
 * Anthropic key in the loop). Numbers from this agent are a LOWER
 * BOUND on what brain can do: no agent-level chain-of-thought, just
 * one shot through the multi-hop planner + synthesize.
 *
 * Tenancy note: brain's API-key model binds one key to one companyId.
 * The runner picks an entity-id prefix per sample so all LoCoMo
 * conversations co-exist in one tenant without cross-talk. This is
 * also more honest — a real deployment doesn't reshape its tenancy
 * for a benchmark.
 */
import type { HttpBrainClient } from '../http-brain-client';
import type { IngestSink } from './ingest';
import type { QaAgent } from './runner';

export interface HttpAgentOptions {
  /** synthesize mode — strict closes to null on partial; lenient returns the answer. */
  synthesisGuardrails?: 'strict' | 'lenient' | 'off';
  /** Cap on planner hops. The default 3 matches the paper's multi-hop split. */
  maxHops?: number;
  /** When true, drives /v1/search/multi-hop; else single-shot /v1/synthesize. */
  useMultiHop?: boolean;
  /** Per-search candidate ceiling. */
  searchLimit?: number;
}

export function createHttpQaAgent(
  client: HttpBrainClient,
  options: HttpAgentOptions = {},
): QaAgent {
  const guardrails = options.synthesisGuardrails ?? 'lenient';
  const maxHops = options.maxHops ?? 3;
  const useMultiHop = options.useMultiHop ?? true;

  return {
    async answer({ companyId: _companyId, question, asOf }) {
      void _companyId; // tenancy comes from the api key, not the call
      if (useMultiHop) {
        const res = await client.multiHop({
          query: question,
          maxHops,
          synthesize: true,
          synthesisGuardrails: guardrails,
          asOf,
        });
        return res.synthesis?.answer ?? '';
      }
      const synth = await client.synthesize({
        query: question,
        limit: options.searchLimit,
        synthesisGuardrails: guardrails,
        asOf,
      });
      return synth.answer ?? '';
    },
  };
}

/**
 * HTTP-backed IngestSink wired to the production endpoints.
 *
 *   - registerSpeaker → POST /v1/ingest/fact   (entityRef + predicate=name)
 *   - ingestMention   → POST /v1/ingest/mention with the production DTO
 *                       shape: text + contextRef + emittedAt + knownEntities.
 *                       knownEntities hands the extractor a "this turn is
 *                       attributed to <speaker>" anchor, so facts get
 *                       linked to the right person without needing
 *                       robust NER on speaker mentions.
 *
 * companyId on the sink methods is ignored — the API key on the
 * client already pins the tenant. The parameter stays on the
 * interface so a future implementation that wants per-call tenant
 * pinning (e.g. a brain:admin master key that addresses tenants via
 * an X-Brain-Tenant header) can use it without an interface break.
 */
export interface HttpIngestSinkOptions {
  /** Vertical attribution for the ingest source. Defaults to 'locomo'. */
  vertical?: string;
}

export function createHttpIngestSink(
  client: HttpBrainClient,
  options: HttpIngestSinkOptions = {},
): IngestSink {
  const vertical = options.vertical ?? 'locomo';
  return {
    async registerSpeaker({ entityId, name, validFrom }) {
      await client.ingest.fact({
        entityRef: { vertical, id: entityId },
        predicate: 'name',
        object: name,
        validFrom,
        confidence: 1,
        source: {
          vertical,
          recorder: 'locomo:bootstrap',
          messageId: `locomo:speaker:${entityId}`,
        },
      });
    },
    async ingestMention({ speakerEntityId, text, validFrom, sourceMessageId }) {
      // conversationId = `locomo:<sampleId>` — the first two segments
      // of sourceMessageId. We can't strip the trailing segment because
      // dia_ids carry their own ':' (e.g. "D1:5"); splitting and
      // taking the prefix is the deterministic path.
      const conversationId = sourceMessageId.split(':').slice(0, 2).join(':');
      await client.ingest.mention({
        text,
        emittedAt: validFrom,
        contextRef: {
          vertical,
          conversationId,
          messageId: sourceMessageId,
          recorder: 'locomo:loader',
        },
        knownEntities: [
          { vertical, id: speakerEntityId, role: 'speaker' },
        ],
      });
    },
  };
}
