/**
 * Shared types and pure helpers for the ingest conflict-preflight
 * (predict) path. Lives in its own module so both the orchestration
 * (IngestPredictionService) and the scoring (PredictScoringService)
 * sides can import them without a circular dependency.
 */

export type IngestOutcome =
  | 'INSERTED'
  | 'SUPERSEDED'
  | 'COMPETING'
  | 'REJECTED';

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
