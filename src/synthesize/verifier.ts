import type OpenAI from 'openai';
import { withGenAiCall } from '../common/gen-ai-observability';
import { getAbortSignal } from '../common/request-context';
import { traceArtifact } from '../common/debug-trace';
import type { MetricsService } from '../metrics/metrics.service';

/**
 * Corrective-RAG verifier: audits a synthesized answer against the
 * EVIDENCE BUNDLE the generator was given. Split out of
 * synthesize.service.ts (third split, file-size gate) at a real seam —
 * the auditor is a self-contained LLM call with its own contract.
 *
 * Audit W5 #22: the bundle used to be fact lines only, so an answer
 * correctly built from transcript quotes or the computed interval table
 * had claims present in no fact line — strict mode dropped correct
 * answers, and every other mode shipped quoted L0 content with zero
 * faithfulness scoring. Whatever the generator may answer from, the
 * verifier must judge against.
 */
export interface VerifierOutput {
  verdict: 'supported' | 'partial' | 'unsupported';
  unsupportedClaims?: string[];
}

const VERIFIER_SYSTEM = `You are a fact-grounding auditor for a knowledge-graph answer system.

Given a synthesized answer and the EVIDENCE that was available at generation time, judge whether every CLAIM in the answer is directly supported by at least one piece of that evidence. The evidence may come in several sections: extracted source facts, verbatim conversation turns, and computed date intervals. ALL sections count as support — a claim taken word-for-word from a quoted turn is supported, exactly like one taken from a fact.

Definitions:
- "supported": every distinct claim is directly stated by at least one piece of evidence.
- "partial": some claims are supported, but at least one claim is paraphrased / inferred without directly supporting evidence.
- "unsupported": one or more central claims are not in the evidence at all (hallucination).

Be strict on "supported" — a paraphrase that adds detail beyond the evidence is "partial" at best. Cite each unsupported / partially-supported claim by quoting the offending span verbatim.

Output strictly the JSON shape requested by the schema.`;

export interface VerifyRequest {
  openai: OpenAI;
  metrics?: MetricsService;
  query: string;
  answer: string;
  factLines: string[];
  /** Verbatim source turns the generator was allowed to answer from. */
  transcriptLines?: string[];
  /** Precomputed date-interval rows (T1b) the answer may read off. */
  intervalTable?: string[];
  model: string;
}

/** Compose the auditor's evidence sections; empty ones are omitted. */
export function buildVerifierUserMessage({
  query,
  answer,
  factLines,
  transcriptLines,
  intervalTable,
}: {
  query: string;
  answer: string;
  factLines: string[];
  transcriptLines?: string[];
  intervalTable?: string[];
}): string {
  const sections = [`Source facts:\n${factLines.join('\n')}`];
  if (transcriptLines && transcriptLines.length > 0) {
    sections.push(
      `Source conversation turns (verbatim, equally valid support):\n` +
        transcriptLines.join('\n'),
    );
  }
  if (intervalTable && intervalTable.length > 0) {
    sections.push(
      `Computed date intervals (derived from the dated facts above; ` +
        `treat as supported):\n${intervalTable.join('\n')}`,
    );
  }
  return `Query: ${query}\n\nAnswer:\n${answer}\n\n${sections.join('\n\n')}`;
}

export async function runVerifier(req: VerifyRequest): Promise<VerifierOutput> {
  const { openai, metrics, model } = req;
  const user = buildVerifierUserMessage(req);
  traceArtifact('synthesize.verifier_prompt', {
    system: VERIFIER_SYSTEM,
    user,
    model,
  });
  const res = await withGenAiCall(
    {
      kind: 'chat',
      spanName: 'gen_ai.chat.synthesize_verifier',
      system: 'openai',
      model,
    },
    metrics,
    () =>
      openai.chat.completions.create(
        {
          model,
          messages: [
            { role: 'system', content: VERIFIER_SYSTEM },
            { role: 'user', content: user },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'verifier_verdict',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  verdict: {
                    type: 'string',
                    enum: ['supported', 'partial', 'unsupported'],
                  },
                  unsupportedClaims: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
                required: ['verdict', 'unsupportedClaims'],
              },
            },
          },
          max_completion_tokens: 256,
          temperature: 0,
        },
        { signal: getAbortSignal() },
      ),
  );
  const content = res.choices[0]?.message?.content;
  if (!content) throw new Error('empty verifier response');
  const parsed = JSON.parse(content) as VerifierOutput;
  if (
    parsed.verdict !== 'supported' &&
    parsed.verdict !== 'partial' &&
    parsed.verdict !== 'unsupported'
  ) {
    throw new Error('verifier returned invalid verdict');
  }
  traceArtifact('synthesize.verifier_output', parsed);
  return parsed;
}
