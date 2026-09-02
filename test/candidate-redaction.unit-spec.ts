/**
 * The document candidates audit view (GET /v1/documents/:id/candidates)
 * must honor the SAME two gates the committed-fact read seam applies:
 *   1. the predicate scope gate (a `dob`/`address` candidate needs
 *      brain:read_pii) — redact object AND the verbatim `clause`.
 *   2. the ABAC row verdict when a PolicyContext is active — a source
 *      deny rule on the predicate redacts the fact candidate too.
 * Entity/relation candidates are never touched (byte-identical pin below).
 *
 * 0110 default-deny: any OTHER kind (scene/state_delta today, whatever a
 * future migration adds tomorrow) opens its full payload only under
 * brain:read_pii — plain brain:read sees the structural allowlist plus
 * `redacted: true`, nothing else.
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
    expect(c!.payload.object).toBe('secret value');
    expect(c!.payload.clause).toBe('the source sentence');
  });

  it('redacts object AND clause of a PII candidate without brain:read_pii', () => {
    const [c] = redactGatedCandidates([factCandidate('dob')], ['brain:read'], null);
    expect(isRedacted(c!)).toBe(true);
  });

  it('shows the PII candidate to a caller holding brain:read_pii', () => {
    const [c] = redactGatedCandidates(
      [factCandidate('dob')],
      ['brain:read', 'brain:read_pii'],
      null,
    );
    expect(c!.payload.object).toBe('secret value');
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
    expect(isRedacted(denied!)).toBe(true);
    // A different predicate the rule doesn't target stays visible.
    const [kept] = redactGatedCandidates([factCandidate('preference')], ['brain:read'], ctx);
    expect(kept!.payload.object).toBe('secret value');
  });

  it('never touches entity/relation candidates', () => {
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
    expect(c!.payload.name).toBe('Acme Corp');
    expect(c!.payload.redacted).toBeUndefined();
  });

  // ── 0110: byte-identical pin for the pre-existing kinds ────────────────
  it('the kind-dispatch rewrite is byte-identical for entity/fact/relation rows', () => {
    // Every pre-0110 shape through every gate combination: the dispatch
    // rewrite must return DEEP-EQUAL rows (and the SAME reference where
    // the old code passed rows through untouched).
    const relation: CandidateRow = {
      id: 'candidate:r',
      runId: 'run:1',
      chunkSeq: 0,
      kind: 'relation',
      confidence: 0.8,
      status: 'pending',
      payload: { fromEntityIndex: 0, toEntityIndex: 1, kind: 'works_at' },
    };
    const entity: CandidateRow = {
      id: 'candidate:e',
      runId: 'run:1',
      chunkSeq: 0,
      kind: 'entity',
      confidence: 0.9,
      status: 'pending',
      payload: { name: 'Acme Corp' },
    };
    const scopeSets = [['brain:read'], ['brain:read', 'brain:read_pii']];
    for (const scopes of scopeSets) {
      // Pass-through kinds: same REFERENCE out (the pre-0110 contract).
      const [e, r] = redactGatedCandidates([entity, relation], scopes, null);
      expect(e).toBe(entity);
      expect(r).toBe(relation);
      // Ungated fact: same reference; gated fact: the exact legacy shape.
      const openFact = factCandidate('tier');
      const [open] = redactGatedCandidates([openFact], scopes, null);
      expect(open).toBe(openFact);
      const gated = factCandidate('dob');
      const [g] = redactGatedCandidates([gated], scopes, null);
      if (scopes.includes('brain:read_pii')) {
        expect(g).toBe(gated);
      } else {
        expect(g).toEqual({
          ...gated,
          payload: {
            predicate: 'dob',
            object: '[redacted]',
            clause: '[redacted]',
            redacted: true,
          },
        });
      }
    }
  });

  // ── 0110: default-deny for episodic/unknown kinds ──────────────────────
  const sceneCandidate = (): CandidateRow => ({
    id: 'candidate:s',
    runId: 'run:1',
    chunkSeq: 0,
    kind: 'scene',
    confidence: 0.7,
    status: 'pending',
    payload: {
      sceneIndex: 0,
      schemaId: 'viewing',
      label: 'Property viewing at 12 Elm St',
      gist: 'Client toured the house and mentioned their diabetes diagnosis',
      indexerId: 'realty',
      packVersion: '1.0.0',
      executionMode: 'external',
      model: null,
    },
  });

  it('denies scene content under plain brain:read — structural allowlist only', () => {
    const [c] = redactGatedCandidates([sceneCandidate()], ['brain:read'], null);
    expect(c!.payload).toEqual({
      redacted: true,
      sceneIndex: 0,
      schemaId: 'viewing',
      indexerId: 'realty',
      packVersion: '1.0.0',
      executionMode: 'external',
      model: null,
    });
    expect(c!.payload.label).toBeUndefined();
    expect(c!.payload.gist).toBeUndefined();
  });

  it('opens scene content under brain:read_pii (the includeText precedent)', () => {
    const scene = sceneCandidate();
    const [c] = redactGatedCandidates([scene], ['brain:read', 'brain:read_pii'], null);
    expect(c).toBe(scene);
  });

  it('default-denies a kind the dispatcher has never heard of', () => {
    const future = {
      ...sceneCandidate(),
      kind: 'hologram' as CandidateRow['kind'],
      payload: { secret: 'leaks unless denied', indexerId: 'realty' },
    };
    const [c] = redactGatedCandidates([future], ['brain:read'], null);
    expect(c!.payload).toEqual({ redacted: true, indexerId: 'realty' });
  });

  it('denies state_delta subject/states under plain brain:read', () => {
    const delta: CandidateRow = {
      id: 'candidate:d',
      runId: 'run:1',
      chunkSeq: 0,
      kind: 'state_delta',
      confidence: 0.7,
      status: 'pending',
      payload: {
        sceneIndex: 0,
        stateModelId: 'deal',
        subject: 'the Smith purchase',
        from: 'open',
        to: 'under_offer',
        indexerId: 'realty',
        packVersion: '1.0.0',
        executionMode: 'external',
        model: null,
      },
    };
    const [c] = redactGatedCandidates([delta], ['brain:read'], null);
    expect(c!.payload.subject).toBeUndefined();
    expect(c!.payload.from).toBeUndefined();
    expect(c!.payload.to).toBeUndefined();
    expect(c!.payload.stateModelId).toBe('deal');
    expect(c!.payload.redacted).toBe(true);
  });
});
