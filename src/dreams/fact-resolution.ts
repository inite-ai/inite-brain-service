/**
 * Fact resolution (#828): each newly written fact is judged against the
 * entity's open facts that resemble it — across predicate names, with no
 * recency window — and the judgement is applied with valid-time
 * precedence.
 *
 * The established pipeline: Graphiti/Zep (arXiv 2501.13956 §2.2.2–2.2.3)
 * retrieves candidate edges by similarity and has a model decide
 * duplicate / contradiction, closing the old edge at the new one's valid
 * time; Mem0 (arXiv 2504.19413) judges each new memory against its top-s
 * similar ones (ADD / UPDATE / DELETE / NOOP). Here the model names only
 * the RELATION between two facts; which of two successive values is the
 * later one is read from valid time, not from arrival — a late-arriving
 * older value goes into history instead of overwriting the present
 * (Graphiti orders by ingestion).
 *
 * This replaced nothing silently: before it, a fact was reconciled only
 * inside its slot (entity + predicate string) under the predicate's
 * registered policy, and the extractor had to name what a turn replaced
 * from the entity's 12 newest facts — on the memory-fitness corpus every
 * revision but two stayed current beside the value it replaced.
 */

/** Candidates judged per new fact — Mem0's s (top-s similar memories). */
export const RESOLUTION_CANDIDATES = 10;
/** New facts per judged batch (one model call, or one harness batch). */
export const RESOLUTION_FACTS_PER_BATCH = 8;

export const RESOLUTION_VERDICTS = ['same', 'replaces', 'contradicts', 'unrelated'] as const;
export type ResolutionVerdict = (typeof RESOLUTION_VERDICTS)[number];

/** The judge's instructions — the server model's and the harness agent's. */
export const FACT_RESOLUTION_SYSTEM = `You compare a NEW fact about an entity with facts already in memory about the same entity, and name how each memory fact relates to the new one.

For each memory fact answer exactly one of:
- same — it states the same thing as the new fact, possibly worded differently or less completely (a paraphrase, a confirmation).
- replaces — it is the same attribute of the same subject at a DIFFERENT time: one value succeeded the other (moved from X to Y, switched from A to B, the date moved, the plan changed). Do not decide which one is newer; only that they are successive values of one attribute.
- contradicts — the same attribute of the same subject at the same time, and the two values cannot both be true, with nothing saying one replaced the other (two sources disagree).
- unrelated — anything else: a different attribute, compatible details, a reason or a plan ABOUT the attribute rather than its value, two separate occurrences of the same kind of thing (two visits, two payments).

Each fact shows what it was read from — the turn, or who wrote it. Use it: a turn that announces a change ("we switch to", "moved", "replaces the earlier decision") makes successive values; two sources stating different values for the same time without either replacing the other is a contradiction.

Names of attributes may differ ("deploy_target" vs "deployed_to", "queue backend" vs "job queue"); judge by meaning. When unsure, answer unrelated — it changes nothing.`;

export interface ResolvableFact {
  id: string;
  predicate: string;
  object: string;
  /** ISO instant the value holds from. */
  validFrom: string;
  validUntil?: string | undefined;
  /** ISO instant the memory learned it. */
  recordedAt: string;
  /** What it was read from: the source turn quoted, or who wrote it directly. */
  source?: string | undefined;
  /** The source episode, when the fact was read from one. */
  episodeId?: string | undefined;
}

/** One new fact and its candidates, as the judge reads them (r1, r2, … / c1, c2, …). */
export function resolutionUserContent(
  items: Array<{ entity: string; fact: ResolvableFact; candidates: ResolvableFact[] }>,
): string {
  const line = (f: ResolvableFact) =>
    `${f.predicate}: ${f.object} (holds from ${f.validFrom.slice(0, 10)}${f.validUntil ? ` until ${f.validUntil.slice(0, 10)}` : ''})${f.source ? ` — from ${f.source}` : ''}`;
  return items
    .map((it, i) =>
      [
        `Item r${i + 1} — entity: ${it.entity}`,
        `NEW: ${line(it.fact)}`,
        ...it.candidates.map((c, j) => `c${j + 1}: ${line(c)}`),
      ].join('\n'),
    )
    .join('\n\n');
}

/** The reply's JSON schema. */
export function resolutionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['item', 'verdicts'],
          properties: {
            item: { type: 'string', description: 'r1, r2, …' },
            verdicts: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['candidate', 'verdict'],
                properties: {
                  candidate: { type: 'string', description: 'c1, c2, …' },
                  verdict: { type: 'string', enum: [...RESOLUTION_VERDICTS] },
                },
              },
            },
          },
        },
      },
    },
  };
}

/** item index → candidate index → verdict; malformed entries are dropped, never guessed. */
export function parseResolution(result: unknown): Map<number, Map<number, ResolutionVerdict>> {
  const out = new Map<number, Map<number, ResolutionVerdict>>();
  const items = (result as { items?: unknown })?.items;
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    const item = /^r(\d+)$/.exec(String((it as { item?: unknown })?.item ?? ''));
    const verdicts = (it as { verdicts?: unknown })?.verdicts;
    if (!item || !Array.isArray(verdicts)) continue;
    const byCandidate = new Map<number, ResolutionVerdict>();
    for (const v of verdicts) {
      const c = /^c(\d+)$/.exec(String((v as { candidate?: unknown })?.candidate ?? ''));
      const verdict = (v as { verdict?: unknown })?.verdict;
      if (!c || !RESOLUTION_VERDICTS.includes(verdict as ResolutionVerdict)) continue;
      byCandidate.set(Number(c[1]) - 1, verdict as ResolutionVerdict);
    }
    out.set(Number(item[1]) - 1, byCandidate);
  }
  return out;
}

/** A write the verdicts call for — applied by the resolver's own stamps. */
export type ResolutionAction =
  | { kind: 'supersede'; loser: string; winner: string }
  | { kind: 'corroborate'; incumbent: string; younger: string }
  | { kind: 'compete'; a: string; b: string };

/**
 * The writes for one new fact's verdicts. `replaces`: the value that
 * holds from the EARLIER valid time closes, whichever arrived first — the
 * bitemporal reading; an equal valid time falls back to arrival order.
 * `same`: the later-learned row corroborates the earlier one.
 * `contradicts`: both stand, competing.
 */
export function resolutionActions(
  fact: ResolvableFact,
  candidates: ResolvableFact[],
  verdicts: Map<number, ResolutionVerdict>,
): ResolutionAction[] {
  const ms = (iso: string) => new Date(iso).getTime();
  const earlier = (a: ResolvableFact, b: ResolvableFact, by: 'validFrom' | 'recordedAt') =>
    ms(a[by]) !== ms(b[by]) ? ms(a[by]) < ms(b[by]) : ms(a.recordedAt) <= ms(b.recordedAt);
  const out: ResolutionAction[] = [];
  candidates.forEach((c, i) => {
    switch (verdicts.get(i)) {
      case 'replaces': {
        const [loser, winner] = earlier(c, fact, 'validFrom') ? [c, fact] : [fact, c];
        out.push({ kind: 'supersede', loser: loser.id, winner: winner.id });
        break;
      }
      case 'same': {
        const [incumbent, younger] = earlier(c, fact, 'recordedAt') ? [c, fact] : [fact, c];
        out.push({ kind: 'corroborate', incumbent: incumbent.id, younger: younger.id });
        break;
      }
      case 'contradicts':
        out.push({ kind: 'compete', a: c.id, b: fact.id });
        break;
      default:
        break;
    }
  });
  return out;
}
