/**
 * The document candidates audit view (GET /v1/documents/:id/candidates)
 * must honor the SAME two gates the committed-fact read seam applies:
 *   1. the predicate scope gate (a `dob`/`address` candidate needs
 *      brain:read_pii) — redact object AND the verbatim `clause`.
 *   2. the ABAC row verdict when a PolicyContext is active — a source
 *      deny rule on the predicate redacts the fact candidate too.
 * Non-fact candidates (entity/relation) are never touched.
 */
import { redactGatedCandidates } from '../src/documents/documents.controller';
import type { CandidateRow } from '../src/documents/candidate-store.service';
import { compilePolicySet } from '../src/policy/policy-compile';
import {
  CompiledPolicySet,
  PolicyContext,
  PolicyDocument,
  PolicyDocumentSchema,
} from '../src/policy/policy.types';

function factCandidate(predicate: string): CandidateRow {
  return {
    id: `candidate:${predicate}`,
    runId: 'run:1',
    chunkSeq: 0,
    kind: 'fact',
    confidence: 0.9,
    status: 'pending',
    payload: { predicate, object: 'secret value', clause: 'the source sentence' },
  };
}

function ctxWith(rules: PolicyDocument['rules']): PolicyContext {
  const parsed = PolicyDocumentSchema.parse({
    name: 'cand-test',
    description: '',
    posture: { actions: 'allow', reads: 'allow' },
    mode: 'enforce',
    rules,
  });
  const compiled = compilePolicySet(parsed) as CompiledPolicySet;
  return {
    companyId: 'co_test',
    keyHash: 'sha256:test',
    sets: [compiled],
    forceReportOnly: false,
    resolutionError: false,
  };
}

const isRedacted = (c: CandidateRow) =>
  c.payload.object === '[redacted]' &&
  c.payload.clause === '[redacted]' &&
  c.payload.redacted === true;

describe('redactGatedCandidates', () => {
  it('leaves a non-PII candidate visible when no scope/policy gates it', () => {
    const [c] = redactGatedCandidates([factCandidate('tier')], ['brain:read'], null);
    expect(c.payload.object).toBe('secret value');
    expect(c.payload.clause).toBe('the source sentence');
  });

  it('redacts object AND clause of a PII candidate without brain:read_pii', () => {
    const [c] = redactGatedCandidates([factCandidate('dob')], ['brain:read'], null);
    expect(isRedacted(c)).toBe(true);
  });

  it('shows the PII candidate to a caller holding brain:read_pii', () => {
    const [c] = redactGatedCandidates(
      [factCandidate('dob')],
      ['brain:read', 'brain:read_pii'],
      null,
    );
    expect(c.payload.object).toBe('secret value');
  });

  it('redacts a candidate an enforced ABAC rule denies (by predicate)', () => {
    const ctx = ctxWith([
      {
        id: 'no-tier',
        enabled: true,
        effect: 'deny',
        kind: 'source',
        match: [{ attr: 'predicate', op: 'eq', value: 'tier' }],
      },
    ]);
    const [denied] = redactGatedCandidates([factCandidate('tier')], ['brain:read'], ctx);
    expect(isRedacted(denied)).toBe(true);
    // A different predicate the rule doesn't target stays visible.
    const [kept] = redactGatedCandidates(
      [factCandidate('preference')],
      ['brain:read'],
      ctx,
    );
    expect(kept.payload.object).toBe('secret value');
  });

  it('never touches non-fact candidates', () => {
    const entity: CandidateRow = {
      id: 'candidate:e',
      runId: 'run:1',
      chunkSeq: 0,
      kind: 'entity',
      confidence: 0.9,
      status: 'pending',
      payload: { name: 'Acme Corp' },
    };
    const denyAll = ctxWith([
      {
        id: 'block-all',
        enabled: true,
        effect: 'deny',
        kind: 'source',
        match: [{ attr: 'predicate', op: 'prefix', value: '' }],
      },
    ]);
    const [c] = redactGatedCandidates([entity], ['brain:read'], denyAll);
    expect(c.payload.name).toBe('Acme Corp');
    expect(c.payload.redacted).toBeUndefined();
  });
});
