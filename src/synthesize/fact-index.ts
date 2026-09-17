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
  /** As written — the name rendered into the fact line. */
  predicate: string;
  /**
   * The SLOT — `predicateAlias ?? predicate`, the 0083 identity every
   * other consumer keys on. Separate from `predicate` because the line
   * shows what was written while a comparison needs the canon: a fact
   * coined `deploys_to` and aliased onto `deploy_target` must compare
   * equal to one coined `deploy_target`, and reads identically to the
   * belief plane's own slot (0147), which is what makes the two planes
   * joinable.
   */
  slot: string;
  object: string;
  /** Who claimed it — the write-time sourceKey (trustSnapshot). Lets a
   *  caller chase the citation to get_source_reputation. Absent on
   *  pre-0044 facts. */
  sourceKey?: string;
}

export interface FactIndexResult {
  /** factId → Citation. Handles are looked up beside it: handlesOf(). */
  factIndex: Map<string, Citation>;
  factLines: string[];
}

/**
 * handle → factId, per index. Kept BESIDE the index rather than inside it
 * because five consumers iterate or count the index (the outcome writer
 * records one `selected_for_context` per key, the grounding-quote lane
 * fetches one episode per key, three span attributes count it), and a
 * second key per fact would double every one of them. Keyed by the Map
 * object itself, so nothing has to be threaded through the round types.
 */
const HANDLES = new WeakMap<ReadonlyMap<string, Citation>, ReadonlyMap<string, string>>();

/** The handle → factId table of an index built by buildFactIndex; empty for any other map. */
export function handlesOf(factIndex: ReadonlyMap<string, Citation>): ReadonlyMap<string, string> {
  return HANDLES.get(factIndex) ?? new Map();
}

/**
 * The citation handle of the n-th rendered fact line (0-based).
 *
 * WHY HANDLES. The generator used to be shown `[knowledge_fact:<20 random
 * chars>]` on every line and asked to copy the id exactly. On a five-line
 * evidence set it did; on the prod tenant's twelve-line set gpt-4o-mini
 * mis-cited two of three correct answers — one id copied from the wrong
 * line (Alice Smith's tariff fact under "relocating to Porto"), one
 * invented from the `[source 2026-09-17 …]` quote tag. Both answers were
 * right and both were dropped: a wrong id fails the citation gate, and
 * the plausibility judge, shown the mis-cited premise, vetoes. A short
 * handle is copied reliably; the id is restored in code
 * (expandCitationHandles) before anything downstream reads the answer,
 * so the wire contract — `[knowledge_fact:…]` inline, real ids in
 * `citations` — is unchanged.
 */
export function factHandle(index: number): string {
  return `f${index + 1}`;
}

/** `f12` / `[f12]` → `f12`; anything else → null. */
export function parseFactHandle(raw: string): string | null {
  const m = /^\[?(f\d{1,4})\]?$/u.exec(raw.trim());
  return m ? m[1]! : null;
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
    elapsedAsOf?: string | undefined;
    /**
     * Enumeration lane (T2): render fact lines in chronological
     * validFrom order (undated last, otherwise stable) so exhaustive
     * list answers read off an ordered timeline. Sorting happens here —
     * in code — never by the generator.
     */
    chronological?: boolean | undefined;
    /**
     * T5 update arbitration: on slots (entity + `predicateAlias ??
     * predicate`, the 0083 identity — two coinages of one attribute
     * arbitrate against each other, as they must) holding ≥2
     * dated, disagreeing statements, tag the max(validFrom) one with
     * "[most recent for this slot]" — knowledge-update misses answer
     * STALE values; the marker makes recency selection a read-off.
     */
    markRecency?: boolean | undefined;
    /**
     * V12 mention anchoring (profile.mentionDates): append
     * "(mentioned YYYY-MM-DD)" when the DERIVER_MENTION_STAMP anchor
     * disagrees with validFrom by calendar day — the generator sees
     * WHEN a fact was said next to when it claims to hold, instead of
     * only the (possibly collapsed) validity date. Unstamped facts and
     * same-day anchors render nothing.
     */
    mentionDates?: boolean | undefined;
    /**
     * V13 scene traces (profile.sceneTraces): append "(context: …)"
     * from the deriver-stamped source.scene — the situational anchor
     * the dual-trace encoding wrote. Unstamped facts render nothing.
     */
    sceneTraces?: boolean | undefined;
  },
): FactIndexResult {
  const factIndex = new Map<string, Citation>();
  const entries: Array<{
    line: string;
    t: number;
    slot: string;
    obj: string;
    /** The cited fact behind the line; absent for a relation line. */
    citation?: Citation;
  }> = [];
  for (const r of results) {
    for (const f of r.facts) {
      const citation: Citation = {
        factId: f.factId,
        entityId: r.entityId,
        canonicalName: r.canonicalName,
        predicate: f.predicate,
        slot: f.predicateAlias ?? f.predicate,
        object: f.object,
        ...(f.sourceKey ? { sourceKey: f.sourceKey } : {}),
      };
      factIndex.set(f.factId, citation);
      const t = f.validFrom ? Date.parse(f.validFrom) : NaN;
      const validT = Number.isNaN(t) || t === 0 ? Number.POSITIVE_INFINITY : t;
      entries.push({
        // The handle is prefixed once the order is final (below).
        line: `${r.canonicalName} (${r.entityType}) — ${f.predicate}: ${f.object}${factLineSuffixes(f, opts)}`,
        t: validT,
        slot: `${r.entityId}::${f.predicateAlias ?? f.predicate}`,
        obj: f.object,
        citation,
      });
    }
    // The entity's graph relations, as evidence lines beside its facts.
    // The extractor files the same statement as a fact in one language
    // and as an edge in another ("works at Orbital Dynamics" became a
    // fact for Thomas and an edge for Maria in the same corpus), and an
    // answer plane that read only facts had the generator asserting an
    // employer the verifier could not find — and dropping the answer.
    // No bracket on a relation line: a relation is support, not a
    // citation. Tagged `[relation]`, the generator cited the tag — on the
    // prod tenant "relocating to Porto" rested on the edge alone and came
    // back as `citedFactIds: ["relation"]`, which resolves to nothing, so
    // a correct answer was dropped for want of a citation. With nothing
    // to copy the model cites the fact handle beside it, or abstains.
    for (const rel of r.relations ?? []) {
      entries.push({
        line: `(relation) ${r.canonicalName} (${r.entityType}) — ${rel.kind}: ${rel.peer} (${rel.peerType})`,
        t: Number.POSITIVE_INFINITY,
        slot: `${r.entityId}::relation::${rel.kind}::${rel.peer}`,
        obj: rel.peer,
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
  // Handles follow the rendered order, so "[f3]" is the third line the
  // model reads. Relation lines carry no handle: support, not a citation.
  let n = 0;
  const handles = new Map<string, string>();
  const factLines = entries.map((e) => {
    if (!e.citation) return e.line;
    const handle = factHandle(n++);
    handles.set(handle, e.citation.factId);
    return `[${handle}] ${e.line}`;
  });
  HANDLES.set(factIndex, handles);
  return { factIndex, factLines };
}

/** The flag-gated suffix chain of one fact line: validity, mention
 *  anchor, scene trace, precomputed elapsed — in that order (split
 *  from buildFactIndex for the complexity gate). */
function factLineSuffixes(
  f: SearchHit['facts'][number],
  opts?: {
    elapsedAsOf?: string | undefined;
    mentionDates?: boolean | undefined;
    sceneTraces?: boolean | undefined;
  },
): string {
  const elapsed = opts?.elapsedAsOf ? formatElapsed(f.validFrom, opts.elapsedAsOf) : '';
  const mention = opts?.mentionDates ? formatMentionDate(f.mentionedAt, f.validFrom) : '';
  const scene = opts?.sceneTraces && f.scene?.trim() ? ` (context: ${f.scene.trim()})` : '';
  return `${formatFactValidity(f.validFrom, f.validUntil)}${mention}${scene}${elapsed}`;
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

/**
 * "(mentioned YYYY-MM-DD)" suffix for stamped facts whose mention
 * anchor and validFrom fall on different calendar days — same-day
 * anchors add nothing the validity suffix doesn't already say, so they
 * render empty. Shares toValidityDate's parsing (epoch sentinel and
 * unparseable values render nothing).
 */
function formatMentionDate(mentionedAt?: string, validFrom?: string): string {
  const mention = toValidityDate(mentionedAt);
  if (!mention) return '';
  if (toValidityDate(validFrom) === mention) return '';
  return ` (mentioned ${mention})`;
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
