/**
 * From derived facts to a submittable bundle: deterministic identity,
 * the client-side fences, the evidence document, and the candidate
 * payload.
 *
 * THE EVIDENCE DOCUMENT is the heart of this design. Brain re-grounds
 * every external span against the stored document text (see
 * docs/indexer-protocol.md, "Grounding rules"), so an indexer that
 * submits facts about a repository must give Brain the repository
 * evidence to check them against. This module composes exactly that: one
 * block per fact carrying the anchor, the claim, the DERIVATION RULE
 * that produced it, and the artefact quoted verbatim with its file and
 * line span. The document is the audit trail — a reader can re-derive
 * every claim from it without trusting the indexer.
 *
 * THE FENCES run client-side, before anything leaves the machine. A
 * candidate that would fail the server's namespace fence, its caps, or
 * its grounding check is DROPPED here with a reason. Sending a claim you
 * already know will be rejected is not a submission, it is noise.
 */
import { createHash } from 'node:crypto';
import { isGroundedSpan, normalizeForGrounding } from '../../ai/extractor-internals/grounding';
import { CODE_MEMORY_PACK } from '../../ai/domain-packs/code-memory.pack';
import { isValueShaped } from './modules/config.module';
import {
  MAX_ENTITY_NAME_CHARS,
  MAX_FACT_OBJECT_CHARS,
  type DroppedRepoFact,
  type IdentifiedRepoFact,
  type IndexerCaps,
  type RepoFact,
} from './types';

/** `code_memory__gotcha` for kind `gotcha`. */
export function predicateFor(packId: string, kind: string): string {
  return `${packId}__${kind}`;
}

/**
 * Deterministic candidate identity over (path, kind, content hash) —
 * the idempotency key. Stable across runs, machines and clones: two
 * runs over an unchanged repository produce byte-identical ids, so the
 * second run submits nothing.
 */
export function candidateIdOf(fact: RepoFact): string {
  const content = createHash('sha256')
    .update([fact.subject, fact.object, fact.evidence.excerpt].join(''))
    .digest('hex');
  return createHash('sha256')
    .update([fact.evidence.path, fact.kind, content].join(''))
    .digest('hex')
    .slice(0, 32);
}

export function identify(facts: RepoFact[]): IdentifiedRepoFact[] {
  const seen = new Set<string>();
  const out: IdentifiedRepoFact[] = [];
  for (const fact of facts) {
    const candidateId = candidateIdOf(fact);
    // Within-run dedupe: two derivers can legitimately read the same
    // artefact line; the fact is one fact.
    if (seen.has(candidateId)) continue;
    seen.add(candidateId);
    out.push({ ...fact, candidateId });
  }
  return out;
}

function drop(
  fact: IdentifiedRepoFact,
  reason: DroppedRepoFact['reason'],
  detail: string,
): DroppedRepoFact {
  return { candidateId: fact.candidateId, kind: fact.kind, subject: fact.subject, reason, detail };
}

/**
 * Kinds whose pack semantics are `single_active`, read from the MANIFEST
 * rather than restated here, so the fence and the ontology can never
 * drift apart.
 *
 * Sending several claims for one of these on a single anchor does not
 * record several values — each would SUPERSEDE the last on commit, and
 * only the final one would survive. That is right for the slots that
 * genuinely have one current value (`owns`, `default_value`,
 * `depends_on_version`, `decided`) and the fence keeps the strongest per
 * (subject, kind).
 *
 * It is NOT a licence to drop coexisting claims. The first dogfood pass
 * over this repository lost 1254 legitimate `invariant` facts across 515
 * anchors to this fence — which was the fence correctly reporting a
 * DOMAIN MODELLING ERROR upstream, not doing its job. `invariant` became
 * `append_only` in pack 0.6.0 and now flows through untouched; the fence
 * is deliberately left reading the manifest so the next such mistake
 * surfaces the same way instead of being hard-coded around.
 */
const SINGLE_ACTIVE_KINDS = new Set(
  CODE_MEMORY_PACK.predicates.filter((p) => p.semantics === 'single_active').map((p) => p.localId),
);

/**
 * Winner per (subject, kind): highest confidence, ties to the first
 * seen. Derivers emit newest-evidence-first (git log is read
 * newest-first), so equal-confidence claims resolve to the most recent
 * artefact — the current owner, the current pin, the current decision.
 */
function singleActiveWinners(facts: IdentifiedRepoFact[], packId: string): Set<string> | null {
  // Another pack's semantics are unknown to this table, so the fence
  // stands down rather than dropping claims on a guess.
  if (packId !== CODE_MEMORY_PACK.id) return null;
  const winners = new Map<string, IdentifiedRepoFact>();
  for (const fact of facts) {
    if (!SINGLE_ACTIVE_KINDS.has(fact.kind)) continue;
    const key = `${fact.kind}${fact.subject.toLowerCase()}`;
    const held = winners.get(key);
    if (!held || fact.confidence > held.confidence) winners.set(key, fact);
  }
  return new Set([...winners.values()].map((f) => f.candidateId));
}

export interface ShapeFenceInput {
  facts: IdentifiedRepoFact[];
  packId: string;
  caps: IndexerCaps;
  /** Candidate ids submitted by a previous run (the state file). */
  alreadySubmitted: ReadonlySet<string>;
}

/**
 * Shape + policy fences. Runs BEFORE the evidence document is composed,
 * so a rejected fact never even contributes text.
 */
export function applyShapeFences(input: ShapeFenceInput): {
  kept: IdentifiedRepoFact[];
  dropped: DroppedRepoFact[];
} {
  const kept: IdentifiedRepoFact[] = [];
  const dropped: DroppedRepoFact[] = [];
  // Already-submitted facts leave FIRST, and the single-active contest is
  // then run over what remains. Order matters: a changed file's new
  // invariant must be free to supersede the one a previous run recorded,
  // rather than losing a contest to its own already-staged predecessor.
  const fresh: IdentifiedRepoFact[] = [];
  for (const fact of input.facts) {
    if (input.alreadySubmitted.has(fact.candidateId)) {
      dropped.push(drop(fact, 'already_submitted', 'submitted by an earlier run'));
    } else {
      fresh.push(fact);
    }
  }
  const winners = singleActiveWinners(fresh, input.packId);
  for (const fact of fresh) {
    if (winners !== null && SINGLE_ACTIVE_KINDS.has(fact.kind) && !winners.has(fact.candidateId)) {
      dropped.push(
        drop(
          fact,
          'single_active_collision',
          `another ${fact.kind} claim on "${fact.subject}" scored higher; ` +
            `${fact.kind} is single_active in the pack manifest`,
        ),
      );
      continue;
    }
    const predicate = predicateFor(input.packId, fact.kind);
    // Namespace fence (server: external-candidates.service validateFact).
    // A namespaced predicate outside the submitting pack is squatting and
    // is a 400 — so it never leaves here.
    if (!predicate.startsWith(`${input.packId}__`) || predicate.split('__').length !== 2) {
      dropped.push(drop(fact, 'namespace_fence', predicate));
      continue;
    }
    const subject = fact.subject.trim();
    const object = fact.object.trim();
    if (!subject || !object) {
      dropped.push(drop(fact, 'empty_span', `${predicate} subject/object empty`));
      continue;
    }
    if (subject.length > MAX_ENTITY_NAME_CHARS) {
      dropped.push(drop(fact, 'name_too_long', `${subject.length} chars`));
      continue;
    }
    if (object.length > MAX_FACT_OBJECT_CHARS) {
      dropped.push(drop(fact, 'object_too_long', `${object.length} chars`));
      continue;
    }
    // code_memory 0.4.3: default_value takes ONLY value-shaped defaults.
    // Prose belongs in invariant, so a prose "default" is dropped rather
    // than mis-slotted.
    if (fact.kind === 'default_value' && !isValueShaped(object)) {
      dropped.push(drop(fact, 'not_value_shaped', object.slice(0, 80)));
      continue;
    }
    if (kept.length >= input.caps.maxCandidates) {
      dropped.push(drop(fact, 'over_run_cap', `run cap ${input.caps.maxCandidates} reached`));
      continue;
    }
    kept.push({ ...fact, subject, object });
  }
  return { kept, dropped };
}

/** One evidence document plus the facts it grounds. */
export interface EvidenceDocument {
  text: string;
  facts: IdentifiedRepoFact[];
}

export interface ComposeInput {
  facts: IdentifiedRepoFact[];
  packId: string;
  caps: IndexerCaps;
  /** Human-readable repo identity for the document header. */
  repoLabel: string;
  headSha: string | null;
}

function blockFor(fact: IdentifiedRepoFact, packId: string): string {
  const span =
    fact.evidence.startLine > 0
      ? `${fact.evidence.path}:${fact.evidence.startLine}-${fact.evidence.endLine}`
      : fact.evidence.path;
  const quoted = fact.evidence.excerpt
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  return [
    `### ${fact.subject}`,
    `${predicateFor(packId, fact.kind)}: ${fact.object}`,
    `derivation: ${fact.derivation}`,
    `producer: ${fact.producer}`,
    `evidence: ${span}${fact.evidence.commit ? ` @ ${fact.evidence.commit}` : ''}`,
    quoted,
    '',
  ].join('\n');
}

/**
 * Pack facts into evidence documents, bounded by BOTH the per-document
 * fact cap (the server allows 200 items per kind per submission) and the
 * character budget (the server hard cap is 512_000).
 */
export function composeEvidenceDocuments(input: ComposeInput): EvidenceDocument[] {
  const header = [
    `# Repository evidence: ${input.repoLabel}`,
    input.headSha ? `commit: ${input.headSha}` : 'commit: (not a git checkout)',
    '',
    'Each block below records one claim, the mechanical rule that derived it,',
    'and the repository artefact it was quoted from. Derived by the code_memory',
    'reference repository indexer; nothing here is a summary of code.',
    '',
  ].join('\n');

  const docs: EvidenceDocument[] = [];
  let buffer = header;
  let batch: IdentifiedRepoFact[] = [];
  const flush = (): void => {
    if (batch.length === 0) return;
    docs.push({ text: buffer, facts: batch });
    buffer = header;
    batch = [];
  };
  for (const fact of input.facts) {
    const block = blockFor(fact, input.packId);
    if (
      batch.length >= input.caps.maxFactsPerDocument ||
      buffer.length + block.length > input.caps.maxDocChars
    ) {
      flush();
    }
    buffer += block;
    batch.push(fact);
  }
  flush();
  return docs;
}

/**
 * Grounding fence — the same check the server runs
 * (`groundExternalBatch`), executed client-side against the document we
 * are about to send. A fact whose subject or value is not a verbatim,
 * whole-token span of its evidence document is dropped here.
 */
export function applyGroundingFence(doc: EvidenceDocument): {
  kept: IdentifiedRepoFact[];
  dropped: DroppedRepoFact[];
} {
  const normalized = normalizeForGrounding(doc.text);
  const kept: IdentifiedRepoFact[] = [];
  const dropped: DroppedRepoFact[] = [];
  for (const fact of doc.facts) {
    if (!isGroundedSpan(normalized, normalizeForGrounding(fact.subject))) {
      dropped.push(drop(fact, 'ungrounded_entity', fact.subject.slice(0, 80)));
      continue;
    }
    if (!isGroundedSpan(normalized, normalizeForGrounding(fact.object))) {
      dropped.push(drop(fact, 'ungrounded_value', fact.object.slice(0, 80)));
      continue;
    }
    kept.push(fact);
  }
  return { kept, dropped };
}

export interface SubmittedEntityPayload {
  name: string;
  type: string;
}

export interface SubmittedFactPayload {
  entityIndex: number;
  predicate: string;
  object: string;
  confidence: number;
  clause: string;
}

export interface CandidatePayload {
  indexerId: string;
  entities: SubmittedEntityPayload[];
  facts: SubmittedFactPayload[];
}

/** Build the `POST /v1/documents/:id/candidates` body for one document. */
export function toCandidatePayload(facts: IdentifiedRepoFact[], packId: string): CandidatePayload {
  const entityIndex = new Map<string, number>();
  const entities: SubmittedEntityPayload[] = [];
  const payloadFacts: SubmittedFactPayload[] = [];
  for (const fact of facts) {
    const key = `${fact.subjectType}${fact.subject.toLowerCase()}`;
    let index = entityIndex.get(key);
    if (index === undefined) {
      index = entities.length;
      entityIndex.set(key, index);
      entities.push({ name: fact.subject, type: fact.subjectType });
    }
    payloadFacts.push({
      entityIndex: index,
      predicate: predicateFor(packId, fact.kind),
      object: fact.object,
      confidence: fact.confidence,
      // A real quote of the artefact, per the protocol's clause contract.
      clause: fact.evidence.excerpt.replace(/\s+/g, ' ').trim().slice(0, 1_000),
    });
  }
  return { indexerId: packId, entities, facts: payloadFacts };
}
