/**
 * RAGAS-style faithfulness — claim-decomposed grounding for
 * synthesize-endpoint outputs.
 *
 * Our synthesize verifier-LLM was a binary "is this answer grounded?"
 * classifier. Faithfulness (RAGAS, Es et al. 2024) decomposes the
 * answer into atomic claims and judges each one independently against
 * the retrieved context. A 5-claim answer with 1 unsupported claim
 * scores 0.8 — same LLM cost (one decompose + one bulk-verify call),
 * 10× the diagnostic signal: we know WHICH sentence hallucinated.
 *
 * Two-step pipeline:
 *
 *   1. Decompose: LLM splits the answer into atomic claims (one
 *      verifiable factual statement each).
 *   2. Bulk verify: a single LLM call judges every claim against
 *      the source-facts list. Verdicts ∈ {supported, partial,
 *      not_supported}. Bulk avoids N round-trips.
 *
 * Faithfulness = (supported + 0.5 × partial) / total_claims
 *
 *   - 1.0 = every claim directly stated by the source facts
 *   - 0.0 = nothing in the answer is supported (full hallucination)
 *   - between = partial / paraphrased (legit RAGAS shape; production
 *     thresholds are usually 0.85 to keep paraphrase noise out)
 *
 * Pure function — caller provides the OpenAI client. Lets the eval
 * runner reuse the same client config (model, retries, timeout)
 * without dragging Nest's DI into the test harness. Returns null
 * faithfulness when the answer was empty or the decomposer emitted
 * zero claims; the aggregator surfaces null as "—".
 */

export interface FaithfulnessSourceFact {
  factId: string;
  predicate: string;
  object: string;
}

export interface FaithfulnessInput {
  answer: string;
  sourceFacts: FaithfulnessSourceFact[];
  /** Default OPENAI_CHAT_MODEL or 'gpt-4o-mini'. */
  model?: string;
}

export interface FaithfulnessClaim {
  claim: string;
  verdict: 'supported' | 'partial' | 'not_supported';
}

export interface FaithfulnessScore {
  /** Final 0..1 faithfulness number. null when no claims to score. */
  faithfulness: number | null;
  totalClaims: number;
  supportedClaims: number;
  partialClaims: number;
  unsupportedClaims: number;
  /** Per-claim verdicts. Useful for surfacing which claim hallucinated. */
  claims: FaithfulnessClaim[];
}

/**
 * Minimal OpenAI client shape — narrow enough that the production
 * SDK satisfies it AND a unit-test stub can mock it without pulling
 * in @types/openai. Lets the metric live in a pure-function world
 * outside the Nest container.
 */
export interface OpenAiLike {
  chat: {
    completions: {
      create: (args: unknown) => Promise<{
        choices?: Array<{ message?: { content?: string | null } }>;
      }>;
    };
  };
}

const DECOMPOSER_SYSTEM = `You decompose a synthesized answer into ATOMIC CLAIMS.

An atomic claim is the smallest standalone factual statement that can be independently verified. Rules:
- Each claim is one short sentence, no compound assertions joined by "and"/"or".
- Reference specific entities, dates, values when relevant.
- Skip filler phrases ("based on the data", "according to the facts").
- Two facts mentioned together stay separate ("Maya complained about parking in April") → ["Maya complained about parking", "the complaint was in April"] when the date is verifiable separately, otherwise keep as one claim.

Return strictly the JSON shape requested.`;

const VERIFIER_SYSTEM = `You judge whether each CLAIM is directly supported by the SOURCE FACTS.

Verdicts:
- "supported"     — a source fact directly states the claim
- "partial"       — claim is paraphrased / inferred from facts but
                     adds detail beyond what's strictly stated
- "not_supported" — claim is not in the facts at all

Be strict. A claim that adds a date, location, or value not in the facts is at most "partial".

Return strictly the JSON shape requested. Verdicts in the same order as input claims.`;

export async function computeFaithfulness(
  client: OpenAiLike,
  input: FaithfulnessInput,
): Promise<FaithfulnessScore> {
  const empty: FaithfulnessScore = {
    faithfulness: null,
    totalClaims: 0,
    supportedClaims: 0,
    partialClaims: 0,
    unsupportedClaims: 0,
    claims: [],
  };
  if (!input.answer || !input.answer.trim()) return empty;

  const model = input.model ?? 'gpt-4o-mini';

  const claims = await decomposeClaims(client, input.answer, model);
  if (claims.length === 0) return empty;

  const verdicts = await verifyClaims(
    client,
    claims,
    input.sourceFacts,
    model,
  );

  const annotated: FaithfulnessClaim[] = claims.map((c, i) => ({
    claim: c,
    verdict: verdicts[i] ?? 'not_supported',
  }));

  const supported = annotated.filter((c) => c.verdict === 'supported').length;
  const partial = annotated.filter((c) => c.verdict === 'partial').length;
  const unsupported = annotated.filter(
    (c) => c.verdict === 'not_supported',
  ).length;

  // RAGAS-style: partial counts as 0.5. Keeps paraphrase-noise out
  // of the binary win/lose framing while still rewarding answers
  // that stay close to the source.
  const score = (supported + 0.5 * partial) / annotated.length;

  return {
    faithfulness: score,
    totalClaims: annotated.length,
    supportedClaims: supported,
    partialClaims: partial,
    unsupportedClaims: unsupported,
    claims: annotated,
  };
}

/** Mean faithfulness across a batch. Null when no scorable inputs. */
export function meanFaithfulness(
  scores: FaithfulnessScore[],
): number | null {
  const scored = scores.filter(
    (s): s is FaithfulnessScore & { faithfulness: number } =>
      s.faithfulness !== null,
  );
  if (scored.length === 0) return null;
  return (
    scored.reduce((acc, s) => acc + s.faithfulness, 0) / scored.length
  );
}

async function decomposeClaims(
  client: OpenAiLike,
  answer: string,
  model: string,
): Promise<string[]> {
  try {
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: DECOMPOSER_SYSTEM },
        { role: 'user', content: `Answer:\n${answer}` },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'atomic_claims',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              claims: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['claims'],
          },
        },
      },
      max_completion_tokens: 512,
      temperature: 0,
    });
    const content = res.choices?.[0]?.message?.content;
    if (!content) return [];
    const parsed = JSON.parse(content) as { claims?: unknown };
    if (!Array.isArray(parsed.claims)) return [];
    return parsed.claims.filter(
      (c): c is string => typeof c === 'string' && c.trim().length > 0,
    );
  } catch {
    return [];
  }
}

async function verifyClaims(
  client: OpenAiLike,
  claims: string[],
  sourceFacts: FaithfulnessSourceFact[],
  model: string,
): Promise<Array<'supported' | 'partial' | 'not_supported'>> {
  if (claims.length === 0) return [];
  const factLines =
    sourceFacts.length > 0
      ? sourceFacts
          .map(
            (f) => `[${f.factId}] ${f.predicate}: ${f.object}`,
          )
          .join('\n')
      : '(no source facts)';
  const numbered = claims.map((c, i) => `${i + 1}. ${c}`).join('\n');
  try {
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: VERIFIER_SYSTEM },
        {
          role: 'user',
          content: `Claims:\n${numbered}\n\nSource facts:\n${factLines}`,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'claim_verdicts',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              verdicts: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['supported', 'partial', 'not_supported'],
                },
              },
            },
            required: ['verdicts'],
          },
        },
      },
      max_completion_tokens: 256,
      temperature: 0,
    });
    const content = res.choices?.[0]?.message?.content;
    if (!content) return claims.map(() => 'not_supported');
    const parsed = JSON.parse(content) as { verdicts?: unknown };
    if (!Array.isArray(parsed.verdicts)) {
      return claims.map(() => 'not_supported');
    }
    // Length mismatch is a model error; pad with not_supported so we
    // don't silently inflate faithfulness on a partial response.
    const out: Array<'supported' | 'partial' | 'not_supported'> = [];
    for (let i = 0; i < claims.length; i++) {
      const v = parsed.verdicts[i];
      if (v === 'supported' || v === 'partial' || v === 'not_supported') {
        out.push(v);
      } else {
        out.push('not_supported');
      }
    }
    return out;
  } catch {
    return claims.map(() => 'not_supported');
  }
}
