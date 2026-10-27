import type { RelearnRequest } from '../documents/relearn-from-raw.service';
import type { FinalizeContext } from './answer-integrity';
import type { SynthesizeResult } from './synthesize.types';

/**
 * What a served answer teaches the memory about raw text
 * (relearn-from-raw.service.ts; docs/roadmap/raw-processing-triggers-
 * 2026-09.md §4.2 T-3): the raw turns it cites, the question and the
 * answer, and whether facts carried it too. Null when there is nothing to
 * learn — an abstention, no answer, or no raw turn cited. Pure.
 */
export function rawLessonOf(ctx: FinalizeContext, final: SynthesizeResult): RelearnRequest | null {
  if (final.reason !== undefined || !final.answer || !ctx.companyId || !ctx.dto) return null;
  const episodeIds = (final.evidenceCitations ?? []).flatMap((c) =>
    c.episodeId ? [c.episodeId] : [],
  );
  if (episodeIds.length === 0) return null;
  return {
    companyId: ctx.companyId,
    userId: ctx.dto.userId,
    episodeIds,
    question: ctx.dto.query,
    answer: final.answer,
    factCited: final.citations.length > 0,
  };
}
