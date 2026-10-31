/**
 * entailmentLabels: a hypothesis is entailed when the NLI model's own top
 * label is entailment — no threshold of ours (src/admin/nli-entailment.ts).
 */
import { entailmentLabels, type NliPipelineParts } from '../src/admin/nli-entailment';

/** A fake 3-label model; each row's logits are given in order. */
function nli(rows: number[][], id2label: Record<string, string>): NliPipelineParts {
  const model = Object.assign(
    async () => ({ logits: { data: rows.flat(), dims: [rows.length, rows[0]?.length ?? 0] } }),
    { config: { id2label } },
  );
  return { tokenizer: async () => ({}), model } as unknown as NliPipelineParts;
}

describe('entailmentLabels', () => {
  const labels = { '0': 'entailment', '1': 'neutral', '2': 'contradiction' };

  it('entailed only where entailment is the top label', async () => {
    const out = await entailmentLabels(
      nli(
        [
          [2.1, 0.3, -1.0], // entailment
          [0.4, 1.2, -0.5], // neutral wins
          [0.1, 0.2, 3.0], // contradiction wins
        ],
        labels,
      ),
      'I sold the Ninja.',
      ['a', 'b', 'c'],
    );
    expect(out).toEqual([true, false, false]);
  });

  it('reads the label order from the model config, whatever it is', async () => {
    const out = await entailmentLabels(
      nli([[0.1, 0.2, 3.0]], { '0': 'contradiction', '1': 'neutral', '2': 'ENTAILMENT' }),
      'p',
      ['h'],
    );
    expect(out).toEqual([true]);
  });

  it('no hypotheses, no call', async () => {
    expect(await entailmentLabels(nli([], labels), 'p', [])).toEqual([]);
  });
});
