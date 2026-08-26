/**
 * L3 evidence citations (FOVEA_L3_EPISODE_CITATIONS) — the pure resolver
 * (src/synthesize/l3-citations.ts). No IO, no flags: the fence property
 * (only rendered turns are citable), the span-anchor contract (NFC,
 * code-point offsets, fail-safe episodeId-only), dedupe, and the cap.
 */
import { resolveEpisodeCitations, type CitableTurn } from '../src/synthesize/l3-citations';

const TURNS: ReadonlyMap<string, CitableTurn> = new Map([
  [
    'episode:ep1',
    {
      text: 'my tier is sapphire, confirmed last week',
      conversationId: 'conv1',
      occurredAt: '2026-04-01T10:00:00.000Z',
    },
  ],
  ['episode:ep2', { text: 'twice twice — the word repeats', conversationId: 'conv1' }],
]);

describe('resolveEpisodeCitations — fence, spans, dedupe, cap', () => {
  it('drops an episodeId not in the rendered-turn map (the anti-hallucination fence) and counts it', () => {
    const { citations, counts } = resolveEpisodeCitations(
      [
        { episodeId: 'episode:ghost', quote: 'anything' },
        { episodeId: 'episode:ep1', quote: 'tier is sapphire' },
      ],
      TURNS,
    );
    expect(citations.map((c) => c.episodeId)).toEqual(['episode:ep1']);
    expect(counts.dropped_unknown).toBe(1);
    expect(counts.span_anchored).toBe(1);
  });

  it('counts malformed entries (no string episodeId) as dropped', () => {
    const { citations, counts } = resolveEpisodeCitations(
      [null, 42, { quote: 'no id' }, { episodeId: '' }],
      TURNS,
    );
    expect(citations).toEqual([]);
    expect(counts.dropped_unknown).toBe(4);
  });

  it('anchors a verifiable quote → span with code-point offsets over the NFC text', () => {
    const { citations } = resolveEpisodeCitations(
      [{ episodeId: 'episode:ep1', quote: 'tier is sapphire' }],
      TURNS,
    );
    expect(citations).toEqual([
      {
        episodeId: 'episode:ep1',
        conversationId: 'conv1',
        occurredAt: '2026-04-01T10:00:00.000Z',
        span: { start: 3, end: 19, exact: 'tier is sapphire' },
      },
    ]);
  });

  it('offsets are CODE POINTS, not UTF-16 units (astral chars count once)', () => {
    const turns = new Map<string, CitableTurn>([
      ['episode:astral', { text: '𝄞𝄞 note: the clef sings' }],
    ]);
    const { citations } = resolveEpisodeCitations(
      [{ episodeId: 'episode:astral', quote: 'the clef' }],
      turns,
    );
    // '𝄞𝄞 note: ' = 9 code points (each 𝄞 is ONE position, 2 UTF-16 units).
    expect(citations[0]?.span).toEqual({ start: 9, end: 17, exact: 'the clef' });
  });

  it('ambiguous quote (2+ occurrences) → episodeId-only citation, counted episode_only', () => {
    const { citations, counts } = resolveEpisodeCitations(
      [{ episodeId: 'episode:ep2', quote: 'twice' }],
      TURNS,
    );
    expect(citations).toEqual([{ episodeId: 'episode:ep2', conversationId: 'conv1' }]);
    expect(counts.episode_only).toBe(1);
    expect(counts.span_anchored).toBe(0);
  });

  it('absent/empty quote → episodeId-only citation (fail-safe, never a guessed span)', () => {
    const { citations, counts } = resolveEpisodeCitations(
      [
        { episodeId: 'episode:ep1', quote: 'not in the turn at all' },
        { episodeId: 'episode:ep2', quote: '' },
      ],
      TURNS,
    );
    expect(citations.every((c) => c.span === undefined)).toBe(true);
    expect(counts.episode_only).toBe(2);
  });

  it('dedupes by (episodeId, span?.start): same span once, distinct spans kept', () => {
    const { citations, counts } = resolveEpisodeCitations(
      [
        { episodeId: 'episode:ep1', quote: 'tier is sapphire' },
        { episodeId: 'episode:ep1', quote: 'tier is sapphire' }, // same span → dropped
        { episodeId: 'episode:ep1', quote: 'confirmed last week' }, // other span → kept
        { episodeId: 'episode:ep1', quote: 'not present' }, // episodeId-only
        { episodeId: 'episode:ep1', quote: 'also not present' }, // dup episodeId-only → dropped
      ],
      TURNS,
    );
    expect(citations).toHaveLength(3);
    expect(counts.span_anchored).toBe(2);
    expect(counts.episode_only).toBe(1);
  });

  it('caps the resolved citations at 16', () => {
    const turns = new Map<string, CitableTurn>(
      Array.from({ length: 25 }, (_, i): [string, CitableTurn] => [
        `episode:e${i}`,
        { text: `turn number ${i} content` },
      ]),
    );
    const { citations } = resolveEpisodeCitations(
      Array.from({ length: 25 }, (_, i) => ({
        episodeId: `episode:e${i}`,
        quote: `turn number ${i}`,
      })),
      turns,
    );
    expect(citations).toHaveLength(16);
  });
});
