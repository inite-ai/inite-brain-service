/**
 * Bespoke-MiniCheck client (V11 §2 arm b) — grounded-consistency check
 * of a claim against a document over a local Ollama server. The model
 * (bespoke-minicheck, SOTA on the LLM-AggreFact grounded-factuality
 * leaderboard) answers a bare Yes/No for "is the claim consistent with
 * the document", which is exactly the abstention decision shape: an
 * answer whose text is not consistent with the evidence bundle should
 * decline instead of surfacing.
 *
 * Pure module — no DI, no env reads; the orchestrator passes the
 * endpoint. Errors throw (the caller owns the degrade contract, same
 * as the LLM verifier path).
 */

export interface MiniCheckRequest {
  /** Ollama base URL, e.g. http://127.0.0.1:11434 */
  baseUrl: string;
  /** Ollama model tag, e.g. 'bespoke-minicheck' */
  model: string;
  /** The evidence bundle the claim must be grounded in. */
  document: string;
  /** The claim under check (declarative text). */
  claim: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal | undefined;
}

/** True = the claim is consistent with the document (grounded). */
export async function miniCheckConsistent(req: MiniCheckRequest): Promise<boolean> {
  const doFetch = req.fetchImpl ?? fetch;
  const res = await doFetch(`${req.baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: req.model,
      // The bespoke-minicheck Ollama template wraps this into the
      // model's trained input format; the response opens with Yes/No.
      prompt: `Document: ${req.document}\nClaim: ${req.claim}`,
      stream: false,
      // Evidence bundles run ~5k tokens — the Ollama default ctx
      // truncates them silently, so size it explicitly.
      options: { temperature: 0, num_ctx: 8192, num_predict: 8 },
    }),
    ...(req.signal !== undefined ? { signal: req.signal } : {}),
  });
  if (!res.ok) {
    throw new Error(`minicheck HTTP ${res.status}`);
  }
  const body = (await res.json()) as { response?: string };
  const out = (body.response ?? '').trim().toLowerCase();
  if (out.startsWith('yes')) return true;
  if (out.startsWith('no')) return false;
  throw new Error(`minicheck unparseable verdict: '${out.slice(0, 40)}'`);
}

/**
 * Compose the evidence-bundle document the answer-claim is checked
 * against — the SAME sections the generator saw (evidence parity; the
 * G4 advisory notes are excluded exactly as on the verifier path, and
 * the MM-zoom PR2 media lines join when the fragment lane rendered
 * any). Pure string work, split out of synthesize.service (file-size
 * gate) at the natural seam.
 */
export function buildMiniCheckDocument(args: {
  factLines: string[];
  transcriptLines: string[];
  insightLines: string[];
  fragmentLines?: string[] | undefined;
}): string {
  return [
    `Facts:\n${args.factLines.join('\n')}`,
    ...(args.transcriptLines.length
      ? [`Conversation excerpts:\n${args.transcriptLines.join('\n')}`]
      : []),
    ...(args.insightLines.length ? [`Derived insights:\n${args.insightLines.join('\n')}`] : []),
    ...(args.fragmentLines?.length ? [`Media evidence:\n${args.fragmentLines.join('\n')}`] : []),
  ].join('\n\n');
}
