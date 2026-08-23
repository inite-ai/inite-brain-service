/**
 * Semantic entropy across N extraction passes.
 *
 * Reference: Farquhar et al., Nature 2024 ("Detecting hallucinations in
 * LLM outputs with semantic entropy"); Kernel Language Entropy (Nikitin
 * et al., NeurIPS 2024). The core insight: a stable answer surfaces as
 * a single cluster across N stochastic re-rolls; a hallucination
 * surfaces as a high-entropy distribution over near-paraphrases.
 *
 * We adopt the cluster-then-entropy shape but use a deterministic
 * predicate-canonical + normalised-object clustering rule instead of
 * bidirectional NLI. Rationale: our extractor already canonicalises
 * predicates via the EDC table (a learned-equivalence step), so two
 * facts that mean the same thing in our domain land in the same
 * cluster without an NLI round-trip. For free-text objects we apply a
 * conservative whitespace + diacritic + case normaliser.
 *
 * Pure module — no DI, no IO. Caller passes the N-pass extractions in;
 * this module returns per-fact entropy + the cluster distribution.
 */

export interface PassFact {
  /** Canonical predicate id after EDC rewrite (caller-supplied). */
  predicate: string;
  /** The object span — caller-supplied; will be normalised here. */
  object: string;
  /**
   * Merged-entity identity the fact is ABOUT (audit W3 #5). Without it,
   * two people sharing a value ("Anna lives in Berlin", "Boris lives in
   * Berlin") collapse into one cluster: the merge dropped one of the
   * facts outright and the self-consistency stats counted the other
   * person's pass as agreement. Optional so single-entity callers and
   * older fixtures keep working.
   */
  entity?: string | number | undefined;
}

/**
 * Cluster a list of facts coming from N independent extraction passes.
 * Two facts are in the same cluster iff their predicate is identical
 * AND their normalised object is identical. The returned map is
 * keyed by `${predicate}::${normalisedObject}` and carries the count
 * across passes plus an exemplar fact reference for downstream
 * consumers (e.g. the ingest layer picking which variant to persist).
 */
export function clusterAcrossPasses(
  passFacts: readonly (readonly PassFact[])[],
): Map<string, { count: number; exemplar: PassFact }> {
  const clusters = new Map<string, { count: number; exemplar: PassFact }>();
  for (const pass of passFacts) {
    const seenInPass = new Set<string>();
    for (const fact of pass) {
      const key = clusterKey(fact);
      if (seenInPass.has(key)) continue; // dedupe within a single pass
      seenInPass.add(key);
      const prior = clusters.get(key);
      if (prior) {
        prior.count += 1;
      } else {
        clusters.set(key, { count: 1, exemplar: fact });
      }
    }
  }
  return clusters;
}

/**
 * Shannon entropy in nats over the cluster distribution. A single
 * dominant cluster across N passes → entropy → 0; an even spread → log(N).
 * Returns 0 for empty input.
 */
export function clusterEntropy(
  clusters: ReadonlyMap<string, { count: number; exemplar: PassFact }>,
): number {
  const counts = [...clusters.values()].map((c) => c.count);
  const total = counts.reduce((acc, c) => acc + c, 0);
  if (total === 0) return 0;
  let h = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / total;
    h -= p * Math.log(p);
  }
  return h;
}

/**
 * Per-fact entropy + agreement rate. The entropy is the *cluster*
 * entropy — the same value for every fact in the same cluster — but
 * folded into a per-fact map for easy attribution at the ingest call
 * site. `agreement` is the fraction of passes that surfaced this
 * cluster ∈ [0, 1], following the CISC (ACL findings 2025) confidence-
 * informed self-consistency definition.
 */
export interface FactSelfConsistency {
  entropy: number;
  agreement: number;
}

export function selfConsistencyByFact(
  passFacts: readonly (readonly PassFact[])[],
): Map<string, FactSelfConsistency> {
  const clusters = clusterAcrossPasses(passFacts);
  const entropy = clusterEntropy(clusters);
  const passCount = Math.max(passFacts.length, 1);
  const out = new Map<string, FactSelfConsistency>();
  for (const [key, info] of clusters) {
    out.set(key, { entropy, agreement: info.count / passCount });
  }
  return out;
}

/**
 * Stable cluster key. Used as the Map key in `clusterAcrossPasses`
 * and re-derived by the caller when it wants to look up a fact's
 * cluster in the result map.
 */
export function clusterKey(f: PassFact): string {
  const subject = f.entity === undefined ? '' : String(f.entity);
  return `${subject}::${f.predicate}::${normaliseObject(f.object)}`;
}

/**
 * Conservative object-text normaliser used for clustering. Lower-case +
 * NFC + strip leading/trailing whitespace + collapse internal whitespace
 * + strip diacritics. Identity for already-canonical short strings.
 */
function normaliseObject(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // diacritics
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
