import type { EvidenceCapability } from '../common/evidence-taxonomy';
import type { EvidenceCitation } from './synthesize.types';

/**
 * Fragment evidence citations (EVIDENCE_FRAGMENT_CITATIONS, MM-zoom PR2)
 * — the pure resolver that turns the generator's raw `citedFragmentIds`
 * output into verified fragment-arm EvidenceCitations. No IO, no DI, no
 * env: the caller supplies the fragmentsById map and emits metrics from
 * the returned counts. The l3-citations.ts sibling, one lane over.
 *
 * THE ANTI-HALLUCINATION + SECURITY FENCE: `fragmentsById` contains ONLY
 * the fragments actually rendered into the prompt's media-evidence
 * section — rows that already passed the full media fence stack on their
 * way in (FragmentLaneService: tenant → asset-join user fence → media
 * PII → 0112 consent → availability). Any fragmentId the generator emits
 * that is NOT in that map is dropped (and counted), so a fragment
 * citation can never name a fragment the caller couldn't read, whether
 * the id was hallucinated or probed.
 *
 * RENDERED-EXCERPT-ONLY: the citation's `excerpt` is copied from the
 * rendered set — the exact (≤600-char) derived-representation excerpt
 * the generator saw — never generator-authored text, so a wrong or
 * invented quote can never ship as a citation.
 */

/** One rendered media-evidence line's fragment, as the resolver may cite it. */
export interface CitableFragment {
  /** evidence_fragment record id, exactly as rendered in the line header. */
  fragmentId: string;
  /** Parent evidence_asset record id (the GDPR/outcome rollup target). */
  assetId: string;
  /** capabilityForModality over the parent asset's modality. */
  capability: EvidenceCapability;
  /** The RENDERED excerpt — the only citable text. */
  excerpt: string;
  /** ISO event time of the observation, when known. */
  occurredAt?: string | undefined;
}

/** Per-citation resolution outcomes (the metric label values). */
export interface FragmentCitationCounts {
  /** fragmentId was rendered → a fragment-arm citation shipped. */
  cited: number;
  /** fragmentId not in the rendered set (or malformed entry) →
   *  dropped, never surfaced. */
  dropped_unknown: number;
}

/** Ceiling on resolved fragment citations per answer (the l3-citations
 *  EVIDENCE_CITATION_CAP idiom — bounded output). */
const FRAGMENT_CITATION_CAP = 16;

/**
 * Resolve the generator's raw citedFragmentIds against the rendered-set
 * map. Deduped by fragmentId; capped at 16. Input is `unknown[]` by
 * design — the LLM output is parsed defensively here, not trusted at the
 * call site (a `{fragmentId}` object entry is tolerated alongside the
 * schema's plain string).
 */
export function resolveFragmentCitations(
  citedFragmentIds: ReadonlyArray<unknown>,
  fragmentsById: ReadonlyMap<string, CitableFragment>,
): { citations: EvidenceCitation[]; counts: FragmentCitationCounts } {
  const counts: FragmentCitationCounts = { cited: 0, dropped_unknown: 0 };
  const citations: EvidenceCitation[] = [];
  const seen = new Set<string>();
  for (const raw of citedFragmentIds) {
    if (citations.length >= FRAGMENT_CITATION_CAP) break;
    const fragmentId = parseEntry(raw);
    if (!fragmentId) {
      counts.dropped_unknown += 1;
      continue;
    }
    const frag = fragmentsById.get(fragmentId);
    if (!frag) {
      counts.dropped_unknown += 1;
      continue;
    }
    if (seen.has(fragmentId)) continue;
    seen.add(fragmentId);
    // ONE-OF invariant (EvidenceCitation): the fragment arm only —
    // never an episodeId on the same citation.
    citations.push({
      fragmentId: frag.fragmentId,
      assetId: frag.assetId,
      capability: frag.capability,
      excerpt: frag.excerpt,
      ...(frag.occurredAt !== undefined ? { occurredAt: frag.occurredAt } : {}),
    });
    counts.cited += 1;
  }
  return { citations, counts };
}

/** Metrics port for the counting wrapper (keeps this module pure). */
export interface FragmentCitationMetrics {
  countFragmentCitation(outcome: 'cited' | 'dropped_unknown', n?: number): void;
}

/**
 * Service-facing wrapper (the L3 resolveEvidence sibling): resolve +
 * emit the per-outcome telemetry. An absent fence map means the flag
 * was off for the request OR nothing was rendered (the map is only
 * populated under the resolved-once citations switch) — [] either way,
 * the byte-identical default path.
 */
export function resolveAndCountFragmentCitations(opts: {
  citedFragmentIds: ReadonlyArray<unknown> | undefined;
  fragmentsById: ReadonlyMap<string, CitableFragment> | undefined;
  metrics?: FragmentCitationMetrics | undefined;
}): EvidenceCitation[] {
  if (!opts.fragmentsById) return [];
  const { citations, counts } = resolveFragmentCitations(
    opts.citedFragmentIds ?? [],
    opts.fragmentsById,
  );
  for (const outcome of ['cited', 'dropped_unknown'] as const) {
    if (counts[outcome] > 0) opts.metrics?.countFragmentCitation(outcome, counts[outcome]);
  }
  return citations;
}

/** Defensive shape check on one generator-emitted entry; a malformed row
 *  (no non-empty string id) resolves to null and counts as dropped. */
function parseEntry(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof raw === 'object' && raw !== null) {
    const id = (raw as { fragmentId?: unknown }).fragmentId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}
