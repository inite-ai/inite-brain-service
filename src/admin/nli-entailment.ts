/**
 * Natural-language inference over (premise, hypothesis) pairs with the
 * local NLI model the intent classifier already loads
 * (mDeBERTa-v3-base-xnli, three labels). A hypothesis is entailed when
 * the model's own top label is `entailment` — the attribution test of
 * AIS / AlignScore-style grounding checks, with no threshold of ours.
 *
 * Read by the focus view (src/mcp/compact-read.ts): a raw turn may stand
 * in for the facts read from it only if it entails them — the extractor
 * reads a turn WITH its conversation, so a fact can carry a value the
 * turn merely refers to.
 */

/** The parts of a transformers.js text-classification pipeline this needs. */
export interface NliPipelineParts {
  tokenizer: (
    texts: string[],
    opts: { text_pair: string[]; padding: boolean; truncation: boolean },
  ) => Promise<unknown>;
  model: ((inputs: unknown) => Promise<{ logits: { data: ArrayLike<number>; dims: number[] } }>) & {
    config: { id2label: Record<string, string> };
  };
}

/** The model's own top label for a (premise, hypothesis) pair. */
export type NliLabel = 'entailment' | 'neutral' | 'contradiction';

/** Each hypothesis's top label under the premise (the model's argmax). */
export async function nliLabels(
  nli: NliPipelineParts,
  premise: string,
  hypotheses: string[],
): Promise<NliLabel[]> {
  if (hypotheses.length === 0) return [];
  const inputs = await nli.tokenizer(new Array<string>(hypotheses.length).fill(premise), {
    text_pair: hypotheses,
    padding: true,
    truncation: true,
  });
  const out = await nli.model(inputs);
  const labels = out.logits.dims[1] ?? 0;
  const names = nli.model.config.id2label;
  return hypotheses.map((_, row) => {
    let best = 0;
    for (let j = 1; j < labels; j++) {
      if ((out.logits.data[row * labels + j] ?? 0) > (out.logits.data[row * labels + best] ?? 0)) {
        best = j;
      }
    }
    const name = (names[String(best)] ?? '').toLowerCase();
    return name.startsWith('entail')
      ? 'entailment'
      : name.startsWith('contra')
        ? 'contradiction'
        : 'neutral';
  });
}

/** Whether each hypothesis is entailed by the premise (the model's argmax label). */
export async function entailmentLabels(
  nli: NliPipelineParts,
  premise: string,
  hypotheses: string[],
): Promise<boolean[]> {
  return (await nliLabels(nli, premise, hypotheses)).map((l) => l === 'entailment');
}
