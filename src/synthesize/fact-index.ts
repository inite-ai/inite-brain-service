import type { SearchHit } from '../search/search.service';
import { formatElapsed } from './answer-router';

/**
 * Fact-line rendering for the generator/verifier prompts, split out of
 * synthesize.service (max-lines budget). Pure: no IO, no DI.
 */

export interface Citation {
  factId: string;
  entityId: string;
  canonicalName: string;
  predicate: string;
  object: string;
  /** Who claimed it — the write-time sourceKey (trustSnapshot). Lets a
   *  caller chase the citation to get_source_reputation. Absent on
   *  pre-0044 facts. */
  sourceKey?: string;
}

export interface FactIndexResult {
  factIndex: Map<string, Citation>;
  factLines: string[];
}

/**
 * T2b: "[first mentioned: …]" suffix plus the sort key for one fact,
 * from the earliest grounding-episode date; null when unknown so the
 * caller falls back to validFrom.
 */
function mentionAnnotation(
  mentionIso: string | undefined,
): { suffix: string; t: number } | null {
  if (!mentionIso) return null;
  const t = Date.parse(mentionIso);
  if (Number.isNaN(t)) return null;
  return { suffix: ` [first mentioned: ${mentionIso.slice(0, 10)}]`, t };
}

/**
 * Build the (factId → Citation) lookup the generator/verifier consult,
 * plus a human-readable line-per-fact list rendered into the prompts.
 * No-IO, no DI — pure.
 */
export function buildFactIndex(
  results: SearchHit[],
  opts?: {
    /**
     * Temporal lane (T1): asOf date to annotate each dated fact with a
     * precomputed [elapsed: …] suffix, so interval arithmetic happens
     * here — in code — and never in the generator.
     */
    elapsedAsOf?: string;
    /**
     * Enumeration lane (T2): render fact lines in chronological
     * validFrom order (undated last, otherwise stable) so exhaustive
     * list answers read off an ordered timeline. Sorting happens here —
     * in code — never by the generator.
     */
    chronological?: boolean;
    /**
     * T5 update arbitration: on slots (entity+predicate) holding ≥2
     * dated, disagreeing statements, tag the max(validFrom) one with
     * "[most recent for this slot]" — knowledge-update misses answer
     * STALE values; the marker makes recency selection a read-off.
     */
    markRecency?: boolean;
    /**
     * T2b mention-order: factId → earliest grounding-episode ISO date.
     * Annotates each covered fact with "[first mentioned: …]" and makes
     * that date the chronological sort key (validFrom is the EVENT date
     * on derived facts — the wrong signal for "order brought up").
     */
    mentionDates?: Record<string, string>;
  },
): FactIndexResult {
  const factIndex = new Map<string, Citation>();
  const entries: Array<{ line: string; t: number; slot: string; obj: string }> =
    [];
  for (const r of results) {
    for (const f of r.facts) {
      factIndex.set(f.factId, {
        factId: f.factId,
        entityId: r.entityId,
        canonicalName: r.canonicalName,
        predicate: f.predicate,
        object: f.object,
        ...(f.sourceKey ? { sourceKey: f.sourceKey } : {}),
      });
      const elapsed = opts?.elapsedAsOf
        ? formatElapsed(f.validFrom, opts.elapsedAsOf)
        : '';
      const mention = mentionAnnotation(opts?.mentionDates?.[f.factId]);
      const t = f.validFrom ? Date.parse(f.validFrom) : NaN;
      const validT = Number.isNaN(t) || t === 0 ? Number.POSITIVE_INFINITY : t;
      entries.push({
        line: `[${f.factId}] ${r.canonicalName} (${r.entityType}) — ${f.predicate}: ${f.object}${formatFactValidity(f.validFrom, f.validUntil)}${elapsed}${mention?.suffix ?? ''}`,
        // Mention date outranks validFrom as the sort key when known.
        t: mention ? mention.t : validT,
        slot: `${r.entityId}::${f.predicate}`,
        obj: f.object,
      });
    }
  }
  if (opts?.markRecency) {
    const bySlot = new Map<string, typeof entries>();
    for (const e of entries) {
      bySlot.set(e.slot, [...(bySlot.get(e.slot) ?? []), e]);
    }
    for (const group of bySlot.values()) {
      const dated = group.filter((e) => Number.isFinite(e.t));
      if (dated.length < 2) continue;
      if (new Set(group.map((e) => e.obj)).size < 2) continue;
      const newest = dated.reduce((a, b) => (b.t >= a.t ? b : a));
      newest.line += ' [most recent for this slot]';
    }
  }
  if (opts?.chronological) {
    // Stable by construction: Array.prototype.sort is stable, undated
    // entries share +Infinity and keep their relative retrieval order.
    entries.sort((a, b) => a.t - b.t);
  }
  return { factIndex, factLines: entries.map((e) => e.line) };
}

/**
 * Render a fact's validity window as a compact suffix for the prompt.
 * Without this the generator sees no temporal metadata and can only
 * abstain on "when did X happen" questions even when the answering fact
 * was retrieved — its validFrom carries the date. We surface a bare
 * `YYYY-MM-DD` (the time-of-day is noise for recall dating) and a
 * closing bound only when the fact is no longer open. Unparseable or
 * epoch-sentinel dates render nothing rather than a misleading "1970".
 */
function formatFactValidity(validFrom?: string, validUntil?: string): string {
  const from = toValidityDate(validFrom);
  const until = toValidityDate(validUntil);
  if (!from && !until) return '';
  if (from && until) return ` (valid ${from} → ${until})`;
  if (from) return ` (as of ${from})`;
  return ` (until ${until})`;
}

function toValidityDate(value?: string): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return undefined;
  // Drop ONLY the epoch sentinel (new Date(0), the unknown-date fallback) so it
  // never reads as 1970. `=== 0`, not `<= 0`: a real pre-1970 validFrom (an
  // older person's dob, a historical event) must still render its date.
  if (t === 0) return undefined;
  return new Date(t).toISOString().slice(0, 10);
}
