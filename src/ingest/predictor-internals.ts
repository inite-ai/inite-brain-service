/**
 * Shared types and pure helpers for the ingest conflict-preflight
 * (predict) path. Lives in its own module so both the orchestration
 * (IngestPredictionService) and the scoring (PredictScoringService)
 * sides can import them without a circular dependency.
 */

// Mirrors the outcomes fn::resolve_fact can return (migration 0055).
// The preflight must be able to predict every one of them, not the
// 0006-era subset — otherwise detect_contradiction reports the wrong
// outcome for corroboration and backdated ingests.
export type IngestOutcome =
  | 'INSERTED'
  | 'INSERTED_HISTORICAL'
  | 'CORROBORATED'
  | 'SUPERSEDED'
  | 'COMPETING'
  | 'REJECTED';

/**
 * JS mirror of `fn::origin_key_of` (migration 0050) composed with
 * `fn::source_key_of` (0022): the origin key is `source.originKey` when
 * the writer set one (the document path stamps `doc:<contentHash>`),
 * else `vertical:recorder` (recorder → `_` when absent), else the
 * `system_seed` sentinel. Corroboration keys off this — the SAME claim
 * from a DIFFERENT origin is independent confirmation.
 */
export function originKeyOf(source: unknown): string {
  if (!source || typeof source !== 'object') return 'system_seed';
  const s = source as {
    originKey?: unknown;
    vertical?: unknown;
    recorder?: unknown;
  };
  if (s.originKey != null && s.originKey !== '') return String(s.originKey);
  if (s.vertical == null || s.vertical === '') return 'system_seed';
  const recorder =
    s.recorder == null || s.recorder === '' ? '_' : String(s.recorder);
  return `${String(s.vertical)}:${recorder}`;
}

export interface PredictResolveArgs {
  entityRef:
    | { vertical: string; id: string }
    | { entityId: string };
  predicate: string;
  object: string;
  validFrom: string;
  validUntil?: string;
  confidence?: number;
  source: {
    vertical: string;
    eventId?: string;
    messageId?: string;
    recorder?: string;
  };
  /**
   * Per-user memory scope (0055). When set, priors include the user's
   * personal facts alongside tenant-global ones — matching the opponent
   * set fn::resolve_fact would actually weigh for a user-scoped
   * record_fact. Omitted = tenant-global only (fail-closed), which is
   * the wrong opponent set for user-scoped candidates.
   */
  userId?: string;
}

export interface OpposingFact {
  factId: string;
  predicate: string;
  object: string;
  confidence: number;
  validFrom: string;
  validUntil?: string;
  recordedAt: string;
}

export interface PredictResolveResult {
  wouldOutcome: IngestOutcome;
  reasoning: string;
  opposingFacts: OpposingFact[];
  predicatePolicy: {
    semantics: string;
    decayHalfLifeDays: number | null;
    piiClass: string;
  };
}

export interface PriorRow {
  id: unknown;
  predicate: string;
  object: string;
  confidence?: number;
  validFrom: string | Date;
  validUntil?: string | Date | null;
  recordedAt: string | Date;
  embedding?: number[];
  source?: unknown;
  status?: string;
}

export function rowToOpposingFact(row: PriorRow): OpposingFact {
  return {
    factId: String(row.id),
    predicate: row.predicate,
    object: row.object,
    confidence: row.confidence ?? 0,
    validFrom: dateToIso(row.validFrom),
    validUntil: row.validUntil ? dateToIso(row.validUntil) : undefined,
    recordedAt: dateToIso(row.recordedAt),
  };
}

export function dateToIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return new Date().toISOString();
}

export function intervalsOverlap({
  aFrom,
  aUntil,
  bFrom,
  bUntil,
}: {
  aFrom: Date;
  aUntil: Date | null;
  bFrom: Date;
  bUntil: Date | null;
}): boolean {
  const aEnd = aUntil ?? new Date(8.64e15);
  const bEnd = bUntil ?? new Date(8.64e15);
  return aFrom < bEnd && bFrom < aEnd;
}

export function vectorNorm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

export function cosineSimilarity(a: number[], b: number[], aNorm: number): number {
  if (a.length !== b.length || aNorm === 0) return 0;
  let dot = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    bNorm += b[i] * b[i];
  }
  bNorm = Math.sqrt(bNorm);
  if (bNorm === 0) return 0;
  return dot / (aNorm * bNorm);
}
