import { anchorQuote } from '../admin/span-anchor';
import type { EvidenceCitation } from './synthesize.types';

/**
 * L3 evidence citations (FOVEA_L3_EPISODE_CITATIONS) — the pure resolver
 * that turns the L3 generator's raw `citedEpisodes` output into verified
 * EvidenceCitations. No IO, no DI, no env: the service supplies the
 * turnsById map and emits the metrics from the returned counts.
 *
 * THE ANTI-HALLUCINATION + SECURITY FENCE: `turnsById` contains ONLY the
 * turns actually rendered into the L3 transcript — rows that already
 * passed the PII/user/scope read gates on their way in
 * (EpisodeReadStoreService.conversationTurns / windowAround). Any
 * episodeId the generator emits that is NOT in that map is dropped (and
 * counted), so an L3 citation can never name an episode the caller
 * couldn't read, whether the id was hallucinated or probed.
 *
 * Quotes are verified mechanically via anchorQuote (NFC, code-point
 * offsets, fail-safe null): a verifiable quote yields a span citation, an
 * absent/ambiguous/unverifiable one degrades to an episodeId-only
 * citation — the fact of grounding survives, a wrong highlight never
 * ships.
 */

/** One rendered transcript turn the resolver may cite. */
export interface CitableTurn {
  /** The STORED turn text the transcript line was rendered from (the
   *  text spans anchor against — the span-anchor invariant). */
  text: string;
  conversationId?: string | undefined;
  /** ISO event time of the turn, when known. */
  occurredAt?: string | undefined;
}

/** Per-citation resolution outcomes (the metric label values). */
export interface EpisodeCitationCounts {
  /** Quote verified verbatim → citation carries a code-point span. */
  span_anchored: number;
  /** Quote absent/ambiguous/unverifiable → episodeId-only citation. */
  episode_only: number;
  /** episodeId not in the rendered transcript (or malformed entry) →
   *  dropped, never surfaced. */
  dropped_unknown: number;
}

/** Ceiling on resolved evidence citations per L3 answer (mirrors the
 *  bounded-output idiom of the fact-citation path). */
const EVIDENCE_CITATION_CAP = 16;

/**
 * Resolve the generator's raw citedEpisodes against the rendered-turn
 * map. Deduped by (episodeId, span?.start); capped at 16. Input is
 * `unknown[]` by design — the LLM output is parsed defensively here, not
 * trusted at the call site.
 */
export function resolveEpisodeCitations(
  citedEpisodes: ReadonlyArray<unknown>,
  turnsById: ReadonlyMap<string, CitableTurn>,
): { citations: EvidenceCitation[]; counts: EpisodeCitationCounts } {
  const counts: EpisodeCitationCounts = { span_anchored: 0, episode_only: 0, dropped_unknown: 0 };
  const citations: EvidenceCitation[] = [];
  const seen = new Set<string>();
  for (const raw of citedEpisodes) {
    if (citations.length >= EVIDENCE_CITATION_CAP) break;
    const entry = parseEntry(raw);
    if (!entry) {
      counts.dropped_unknown += 1;
      continue;
    }
    const turn = turnsById.get(entry.episodeId);
    if (!turn) {
      counts.dropped_unknown += 1;
      continue;
    }
    const span = anchorQuote(turn.text, entry.quote);
    const key = `${entry.episodeId}\u0000${span ? span.start : 'none'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({
      episodeId: entry.episodeId,
      ...(turn.conversationId !== undefined ? { conversationId: turn.conversationId } : {}),
      ...(turn.occurredAt !== undefined ? { occurredAt: turn.occurredAt } : {}),
      ...(span ? { span: { start: span.start, end: span.end, exact: span.exact } } : {}),
    });
    counts[span ? 'span_anchored' : 'episode_only'] += 1;
  }
  return { citations, counts };
}

/** Defensive shape check on one generator-emitted entry; a malformed row
 *  (no string episodeId) resolves to null and counts as dropped. */
function parseEntry(raw: unknown): { episodeId: string; quote: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const episodeId = (raw as { episodeId?: unknown }).episodeId;
  if (typeof episodeId !== 'string' || episodeId.length === 0) return null;
  const quote = (raw as { quote?: unknown }).quote;
  return { episodeId, quote: typeof quote === 'string' ? quote : '' };
}
