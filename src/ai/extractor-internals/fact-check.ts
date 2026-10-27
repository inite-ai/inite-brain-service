import type { DecisionService } from '../decisions/decision.service';
import type { ExtractionResult } from './types';

/**
 * Every extracted fact, checked against the document it came from before it
 * is written — one decision request per document.
 *
 * The extractor names a fact's subject by POSITION in its own entity list,
 * and a reasoning model re-rolled three times miscounts. Reproduced on the
 * text behind a confident wrong answer in production: "ESM-only" landed on
 * "PR #666" and "AES-256-GCM", "пропал с quay.io" on @nestjs/config, and
 * "по-русски" on "PR #668" — the entities next to the right ones in the
 * list. The self-consistency union kept all of them, and nothing downstream
 * can catch it: a verifier sees a stored fact that supports the answer.
 *
 * Counting passes does not fix it — measured on the same text, TWO of three
 * passes put "по-русски" on PR #668, because re-rolls of one prompt order
 * their entities alike and so miscount alike. Reading the document does.
 * The decision plane is asked, for each distinct (subject, predicate,
 * object): does the document say this of this subject? All questions share
 * the document as state and go in one request; on that text, 89 facts took
 * 700 ms and $0.00044, and the confident noes were exactly the seven
 * misnumbered bindings — no correct fact among them.
 *
 * The judge reads what the extractor read. A turn is not a document: «я его
 * вернул» names neither the speaker nor the table, and checked against the
 * turn alone every such transition was confidently "not stated" — measured,
 * the state-transition battery lost four of twelve scenarios that way. So
 * the state is the extractor's own context (who is speaking, the turns
 * before, the entities and facts memory already holds) followed by the text.
 *
 * A confident "no" drops the fact; a "yes", or an answer below the lane's
 * floor, keeps it. The lane off, unkeyed or failing keeps everything, which
 * is what extraction did before.
 */

/** The plane's input is cheap, not free: a document's worth, and the context that reads it. */
const TEXT_CHARS = 8000;
const CONTEXT_CHARS = 6000;

export interface FactCheck {
  result: ExtractionResult;
  asked: number;
  rejected: number;
  /** The dropped facts as `subject · predicate · object`, for the debug trace — never a log line. */
  droppedFacts?: string[];
}

export async function checkExtraction(args: {
  result: ExtractionResult;
  text: string;
  /** The extractor's context prefix (speaker, prior turns, memory) — the same one it extracted with. */
  context?: string | undefined;
  decisions: DecisionService | undefined;
}): Promise<FactCheck> {
  const { result, decisions } = args;
  if (
    (result.facts.length === 0 && result.edges.length === 0) ||
    !decisions?.enabled('extraction_check')
  ) {
    return { result, asked: 0, rejected: 0 };
  }
  const keyOf = (f: ExtractionResult['facts'][number]) =>
    `${f.entityIndex}\u0000${f.predicate}\u0000${f.object}`;
  const questionOf = new Map<string, string>();
  const questions: Record<
    string,
    { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  > = {};
  for (const f of result.facts) {
    const key = keyOf(f);
    const name = result.entities[f.entityIndex]?.name;
    if (questionOf.has(key) || !name) continue;
    const q = `f${questionOf.size}`;
    questionOf.set(key, q);
    questions[q] = {
      type: 'noul',
      instructions:
        `Does the text, read with its context, state this about «${name}»: ${f.predicate.replace(/_/g, ' ')} — «${f.object}»? ` +
        'Judge whom it is said of as well as what is said.',
      criteria: {
        true: `The text says this of «${name}» — by name, of it as a whole through one of its parts, or by reference ("I" when «${name}» is the speaker, "it", "him").`,
        false: 'The text says it of something else, or does not say it at all.',
      },
    };
  }
  // Relations are bound by position too ("Jev — made by — OpenRouter" when
  // the text says OpenRouter only SERVES it): the same question, asked of
  // the pair.
  const edgeKeyOf = (e: ExtractionResult['edges'][number]) =>
    `${e.fromEntityIndex}\u0000${e.kind}\u0000${e.toEntityIndex}`;
  const edgeQuestionOf = new Map<string, string>();
  for (const e of result.edges) {
    const key = edgeKeyOf(e);
    const from = result.entities[e.fromEntityIndex]?.name;
    const to = result.entities[e.toEntityIndex]?.name;
    if (edgeQuestionOf.has(key) || !from || !to) continue;
    const q = `r${edgeQuestionOf.size}`;
    edgeQuestionOf.set(key, q);
    questions[q] = {
      type: 'noul',
      instructions:
        `Does the text, read with its context, state this relation: «${from}» — ${e.kind.replace(/_/g, ' ')} — «${to}»? ` +
        'Judge which of the two is which as well as the relation itself.',
      criteria: {
        true: `The text says «${from}» ${e.kind.replace(/_/g, ' ')} «${to}» (by name or by reference).`,
        false:
          'The text relates them differently, relates other things, or does not say it at all.',
      },
    };
  }
  const text = `TEXT:\n${args.text.slice(0, TEXT_CHARS)}`;
  const context = args.context?.trim();
  const res = await decisions.decide('extraction_check', {
    state: context ? [`CONTEXT:\n${context.slice(-CONTEXT_CHARS)}`, text] : text,
    questions,
  });
  const asked = questionOf.size + edgeQuestionOf.size;
  if (!res) return { result, asked, rejected: 0 };
  const noOf = (map: Map<string, string>): Set<string> => {
    const out = new Set<string>();
    for (const [key, q] of map) {
      const answer = res.answers[q];
      if (answer?.type !== 'noul') continue;
      // Asked of every answer, not only the noes: confident() is where the
      // lane's acted/escalated counter ticks, and a counter that saw only the
      // doubts would read as a plane that never agrees.
      const sure = decisions.confident('extraction_check', answer);
      if (answer.noul < 0.5 && sure) out.add(key);
    }
    return out;
  };
  const dropped = noOf(questionOf);
  const droppedEdges = noOf(edgeQuestionOf);
  if (dropped.size === 0 && droppedEdges.size === 0) return { result, asked, rejected: 0 };
  const facts = result.facts.filter((f) => !dropped.has(keyOf(f)));
  const edges = result.edges.filter((e) => !droppedEdges.has(edgeKeyOf(e)));
  return {
    result: { ...result, facts, edges },
    asked,
    rejected: result.facts.length - facts.length + (result.edges.length - edges.length),
    droppedFacts: [
      ...result.facts
        .filter((f) => dropped.has(keyOf(f)))
        .map((f) => `${result.entities[f.entityIndex]?.name} · ${f.predicate} · ${f.object}`),
      ...result.edges
        .filter((e) => droppedEdges.has(edgeKeyOf(e)))
        .map(
          (e) =>
            `${result.entities[e.fromEntityIndex]?.name} —${e.kind}→ ${result.entities[e.toEntityIndex]?.name}`,
        ),
    ],
  };
}
