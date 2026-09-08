/**
 * Source-version stamps and drift-based staleness — the pure seams.
 *
 * THE PRINCIPLE UNDER TEST. Code has an external system of record (git)
 * that is better than our copy: exact, versioned, cheap, never wrong
 * about the past. So memory MATERIALIZES what is not derivable (a
 * decision, its rationale, a gotcha, an invariant — prose that is lost
 * without us) and merely POINTS AT what is derivable (who owns a file,
 * which version a dependency is pinned to, what a flag defaults to —
 * re-derivable at any moment, and a lie waiting to happen if stored as
 * timeless truth).
 *
 * Two things follow, and both are pinned here:
 *
 *   1. a derivable fact must carry the revision it was READ at, all the
 *      way from the indexer's candidate to the committed fact's
 *      `source`;
 *   2. staleness for that class is DRIFT, not calendar age — and the
 *      split between the two classes is DECLARED by the pack, not
 *      pattern-matched by the engine.
 */
import { BadRequestException } from '@nestjs/common';
import {
  parseSourceVersionStamp,
  readSourceVersionStamp,
  sameSourceLine,
  type SourceVersionStamp,
} from '../src/common/source-version';
import { packSourceVersionStalenessEnabled } from '../src/common/pack-projection-flags';
import { resolveSourceVersion } from '../src/documents/external-candidates.service';
import { mergeCandidates } from '../src/documents/candidate-merge';
import { sourceVersionOf } from '../src/documents/commit-writer.service';
import {
  SourceDriftStalenessService,
  SOURCE_DRIFT_REASON,
} from '../src/documents/source-drift-staleness.service';
import { toCandidatePayload } from '../src/code-memory/repo-indexer/bundle';
import { CODE_MEMORY_PACK } from '../src/ai/domain-packs/code-memory.pack';
import { validateMemoryModel } from '../src/ai/domain-packs/validate-memory-model';
import type { DomainPackManifest, PackMemoryModel } from '../src/ai/domain-packs/manifest';
import type { CandidateRow } from '../src/documents/candidate-store.service';
import type { IdentifiedRepoFact } from '../src/code-memory/repo-indexer/types';
import type { SubmitCandidatesDto } from '../src/documents/dto/submit-candidates.dto';

const STAMP: SourceVersionStamp = {
  system: 'git',
  ref: 'main',
  version: 'abc123',
  readAt: '2026-09-08T00:00:00.000Z',
};

// ── the stamp shape ──────────────────────────────────────────────────

describe('source-version stamp', () => {
  it('is domain-agnostic — a DMS revision and an EHR study fit the same four fields', () => {
    for (const raw of [
      { system: 'dms', ref: 'matter/2026-114', version: 'rev-17', readAt: STAMP.readAt },
      { system: 'ehr', ref: 'patient/8812', version: 'study:1.2.840.113', readAt: STAMP.readAt },
    ]) {
      const parsed = parseSourceVersionStamp(raw);
      expect(parsed.ok).toBe(true);
    }
  });

  it('rejects a half-stamp — a claim that LOOKS version-bound but is not can never be swept', () => {
    const cases: Array<[unknown, string]> = [
      [{ ref: 'main', version: 'abc', readAt: STAMP.readAt }, 'system'],
      [{ system: 'git', version: 'abc', readAt: STAMP.readAt }, 'ref'],
      [{ system: 'git', ref: 'main', readAt: STAMP.readAt }, 'version'],
      [{ system: 'git', ref: 'main', version: 'abc' }, 'readAt'],
      [{ system: 'GIT', ref: 'main', version: 'abc', readAt: STAMP.readAt }, 'system'],
      [{ system: 'git', ref: 'main', version: 'abc', readAt: 'yesterday' }, 'readAt'],
      ['abc123', 'object'],
      [['abc123'], 'object'],
      [null, 'object'],
    ];
    for (const [raw, field] of cases) {
      const parsed = parseSourceVersionStamp(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain(field);
    }
  });

  it('re-fences a stored stamp on the way back out', () => {
    expect(readSourceVersionStamp(STAMP)).toEqual(STAMP);
    expect(readSourceVersionStamp({ system: 'git', ref: 'main' })).toBeNull();
    expect(readSourceVersionStamp(undefined)).toBeNull();
  });

  it('compares drift only within one system AND one line of it', () => {
    expect(sameSourceLine(STAMP, { ...STAMP, version: 'def456' })).toBe(true);
    // A fact read on release/2.x says nothing about main.
    expect(sameSourceLine(STAMP, { ...STAMP, ref: 'release/2.x' })).toBe(false);
    // A git commit is not comparable with a DMS revision at all.
    expect(sameSourceLine(STAMP, { ...STAMP, system: 'dms' })).toBe(false);
  });
});

// ── the derivable / interpretation split, as the pack declares it ─────

describe('the declared derivable class', () => {
  const memoryModel = CODE_MEMORY_PACK.memoryModel as PackMemoryModel;
  const rule = (memoryModel.verificationRules ?? []).find(
    (r) => r.requires === 'source_version_match',
  );

  it('code_memory declares exactly the re-derivable predicates', () => {
    expect(rule?.appliesTo?.slice().sort()).toEqual([
      'default_value',
      'depends_on_version',
      'owns',
    ]);
  });

  it('never lists an interpretation predicate — the past does not rot', () => {
    // decided / because / invariant / gotcha / superseded_by exist ONLY
    // in prose. A thousand commits later they are exactly as true.
    for (const interpretation of ['decided', 'because', 'invariant', 'gotcha', 'superseded_by']) {
      expect(rule?.appliesTo).not.toContain(interpretation);
    }
  });

  it('the pack minor is bumped for the new declaration', () => {
    expect(CODE_MEMORY_PACK.version).toBe('0.7.0');
  });

  it('a source_version_match rule MUST name its predicate class', () => {
    // Without appliesTo a drift sweep would either touch every claim the
    // pack ever recorded or none of them — both are wrong, so the
    // manifest validator refuses the rule outright.
    expect(() => validateRule({ requires: 'source_version_match' })).toThrow(
      /must declare appliesTo/,
    );
  });

  it('appliesTo cannot reference another pack’s vocabulary', () => {
    expect(() =>
      validateRule({ requires: 'source_version_match', appliesTo: ['legal__clause'] }),
    ).toThrow(/not a predicate of this pack/);
    expect(() =>
      validateRule({ requires: 'source_version_match', appliesTo: ['owns', 'owns'] }),
    ).toThrow(/twice/);
  });

  it('the pre-existing rule kinds still validate without appliesTo', () => {
    expect(() =>
      validateRule({ claimPattern: 'default', requires: 'recency_check' }),
    ).not.toThrow();
  });
});

/** Validate a memoryModel carrying exactly the one rule under test,
 *  against a minimal pack whose only predicate is `owns`. */
function validateRule(rule: Record<string, unknown>): void {
  const pack = {
    id: 'probe',
    version: '1.0.0',
    description: 'probe pack',
    predicates: [
      {
        localId: 'owns',
        label: 'owns',
        description: 'ownership',
        objectType: 'string',
        semantics: 'single_active',
      },
    ],
  } as unknown as DomainPackManifest;
  validateMemoryModel(pack, { verificationRules: [rule] });
}

// ── the stamp rides candidate → document → fact ──────────────────────

describe('the stamp rides from the indexer candidate to the committed fact', () => {
  const fact = (kind: string, subject: string, object: string): IdentifiedRepoFact =>
    ({
      candidateId: `cand-${kind}-${subject}`,
      producer: 'core:probe',
      subject,
      subjectType: 'asset',
      kind,
      object,
      derivation: 'probe',
      evidence: { path: 'package.json', startLine: 1, endLine: 1, excerpt: object },
      confidence: 0.9,
    }) as IdentifiedRepoFact;

  it('the indexer payload carries it, and omits the key entirely without one', () => {
    const facts = [fact('depends_on_version', 'left-pad', '2.0.0')];
    expect(toCandidatePayload(facts, 'code_memory', STAMP).sourceVersion).toEqual(STAMP);
    expect('sourceVersion' in toCandidatePayload(facts, 'code_memory')).toBe(false);
  });

  it('the merge carries it onto the fact’s contributors, and the writer onto source', () => {
    const merged = mergeCandidates([
      entityRow('e1', 'left-pad'),
      factRow('f1', 'code_memory__depends_on_version', '2.0.0', STAMP),
    ]);
    const [mf] = merged.facts;
    expect(mf?.contributors[0]?.sourceVersion).toEqual(STAMP);
    // "at commit abc123, left-pad is 2.0.0" — not the timeless, and
    // eventually false, "left-pad is 2.0.0".
    expect(sourceVersionOf(mf!)).toEqual({ sourceVersion: STAMP });
  });

  it('the LEADER’s reading wins when two runs read different revisions', () => {
    // A corroborating contributor from an older run read a DIFFERENT
    // commit; stamping the fact with ITS revision would misdescribe the
    // value the fact actually holds.
    const older: SourceVersionStamp = { ...STAMP, version: 'old999' };
    const merged = mergeCandidates([
      entityRow('e1', 'left-pad'),
      factRow('weak', 'code_memory__depends_on_version', '2.0.0', older, 0.4),
      factRow('leader', 'code_memory__depends_on_version', '2.0.0', STAMP, 0.9),
    ]);
    const [mf] = merged.facts;
    expect(mf?.leaderId).toBe('leader');
    expect(sourceVersionOf(mf!)).toEqual({ sourceVersion: STAMP });
  });

  it('LEGACY SAFETY: an unstamped fact’s source is byte-identical to today’s', () => {
    const merged = mergeCandidates([
      entityRow('e1', 'left-pad'),
      factRow('f1', 'code_memory__depends_on_version', '2.0.0', undefined),
    ]);
    const [mf] = merged.facts;
    expect(mf?.contributors[0]).not.toHaveProperty('sourceVersion');
    // {} — not `{ sourceVersion: null }`. A null key would change every
    // stored source object in the system.
    expect(sourceVersionOf(mf!)).toEqual({});
  });

  it('a malformed stored stamp is dropped rather than smuggled into the comparison', () => {
    const merged = mergeCandidates([
      entityRow('e1', 'left-pad'),
      factRow('f1', 'code_memory__depends_on_version', '2.0.0', {
        system: 'git',
        version: 'abc123',
      } as unknown as SourceVersionStamp),
    ]);
    expect(sourceVersionOf(merged.facts[0]!)).toEqual({});
  });
});

function entityRow(id: string, name: string): CandidateRow {
  return {
    id,
    runId: 'run1',
    chunkSeq: 0,
    kind: 'entity',
    confidence: 0.5,
    status: 'pending',
    payload: { entityIndex: 0, name, type: 'asset', indexerId: 'code_memory' },
  };
}

function factRow(
  id: string,
  predicate: string,
  object: string,
  sourceVersion: SourceVersionStamp | undefined,
  confidence = 0.9,
): CandidateRow {
  return {
    id,
    runId: 'run1',
    chunkSeq: 0,
    kind: 'fact',
    confidence,
    status: 'pending',
    payload: {
      entityIndex: 0,
      predicate,
      object,
      indexerId: 'code_memory',
      packVersion: '0.7.0',
      executionMode: 'external',
      model: null,
      ...(sourceVersion ? { sourceVersion } : {}),
    },
  };
}

// ── the submission fence ─────────────────────────────────────────────

describe('the submission fence', () => {
  const dto = (sourceVersion?: unknown): SubmitCandidatesDto =>
    ({
      indexerId: 'code_memory',
      entities: [],
      facts: [],
      ...(sourceVersion === undefined ? {} : { sourceVersion }),
    }) as unknown as SubmitCandidatesDto;

  afterEach(() => {
    delete process.env.PACK_SOURCE_VERSION_STALENESS;
  });

  it('FLAG OFF (default) rejects a stamp rather than silently stripping it', () => {
    expect(packSourceVersionStalenessEnabled()).toBe(false);
    expect(() => resolveSourceVersion(dto(STAMP))).toThrow(BadRequestException);
    expect(() => resolveSourceVersion(dto(STAMP))).toThrow(/PACK_SOURCE_VERSION_STALENESS/);
  });

  it('FLAG OFF: a submission that carries no stamp is untouched', () => {
    expect(resolveSourceVersion(dto())).toBeUndefined();
  });

  it('FLAG ON: a well-formed stamp resolves, a malformed one is a 400', () => {
    process.env.PACK_SOURCE_VERSION_STALENESS = '1';
    expect(resolveSourceVersion(dto(STAMP))).toEqual(STAMP);
    expect(() => resolveSourceVersion(dto({ system: 'git' }))).toThrow(BadRequestException);
  });
});

// ── the drift sweep ──────────────────────────────────────────────────

interface CapturedQuery {
  sql: string;
  vars: Record<string, unknown> | undefined;
}

function driftService(rows: unknown[][], model: PackMemoryModel | undefined) {
  const queries: CapturedQuery[] = [];
  let call = 0;
  const db = {
    query: (sql: string, vars?: Record<string, unknown>) => {
      queries.push({ sql, vars });
      return Promise.resolve([[], rows[call++] ?? []]);
    },
  };
  const surreal = {
    withCompany: <T>(_c: string, fn: (db: unknown) => Promise<T>): Promise<T> => fn(db),
  };
  const memoryModels = {
    installedMemoryModels: () =>
      Promise.resolve(
        model ? [{ packId: 'code_memory', packVersion: '0.7.0', memoryModel: model }] : [],
      ),
  };
  const service = new SourceDriftStalenessService(surreal as never, memoryModels as never);
  return { service, queries };
}

describe('drift sweep', () => {
  const model = CODE_MEMORY_PACK.memoryModel as PackMemoryModel;

  afterEach(() => {
    delete process.env.PACK_SOURCE_VERSION_STALENESS;
  });

  it('FLAG OFF: not a single query runs', async () => {
    const { service, queries } = driftService([], model);
    const out = await service.sweep({ companyId: 'c1', packId: 'code_memory', current: STAMP });
    expect(out).toEqual({ marked: 0, cleared: 0, predicates: [] });
    expect(queries).toHaveLength(0);
  });

  it('sweeps ONLY the pack’s declared derivable predicates', async () => {
    process.env.PACK_SOURCE_VERSION_STALENESS = '1';
    const { service } = driftService([], model);
    const predicates = await service.derivablePredicates('c1', 'code_memory');
    expect(predicates.slice().sort()).toEqual([
      'code_memory__default_value',
      'code_memory__depends_on_version',
      'code_memory__owns',
    ]);
    // The interpretation class is not merely deprioritised — it is not
    // in the query's parameter list at all.
    for (const interpretation of ['decided', 'because', 'invariant', 'gotcha']) {
      expect(predicates).not.toContain(`code_memory__${interpretation}`);
    }
  });

  it('a pack with no source_version_match rule never sweeps', async () => {
    process.env.PACK_SOURCE_VERSION_STALENESS = '1';
    const { service, queries } = driftService([], {
      verificationRules: [{ claimPattern: 'default', requires: 'recency_check' }],
    });
    const out = await service.sweep({ companyId: 'c1', packId: 'code_memory', current: STAMP });
    expect(out.marked).toBe(0);
    expect(queries).toHaveLength(0);
  });

  it('marks behind-stamp facts, clears re-read ones, and never touches an unstamped fact', async () => {
    process.env.PACK_SOURCE_VERSION_STALENESS = '1';
    const { service, queries } = driftService([[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }]], model);
    const out = await service.sweep({ companyId: 'c1', packId: 'code_memory', current: STAMP });
    expect(out).toEqual({
      marked: 2,
      cleared: 1,
      predicates: expect.arrayContaining(['code_memory__owns']),
    });

    const [mark, clear] = queries;
    // SurrealDB 3.2.4: LET-select-ids, then write BY id. An
    // UPDATE ... WHERE over the indexed staleAt/predicate fields is the
    // reproduced silent planner no-op.
    for (const q of [mark, clear]) {
      expect(q?.sql).toContain('LET $ids = (SELECT VALUE id FROM knowledge_fact');
      expect(q?.sql).toContain('UPDATE $ids SET');
      expect(q?.sql).not.toMatch(/UPDATE knowledge_fact\s+SET/);
      // LEGACY SAFETY, enforced by the query itself: a fact with no
      // stamp cannot satisfy an equality on source.sourceVersion.system,
      // so pre-stamp memory is untouchable by this sweep.
      expect(q?.sql).toContain('source.sourceVersion.system = $system');
      expect(q?.sql).toContain('source.sourceVersion.ref = $ref');
      expect(q?.vars?.['predicates']).toEqual(expect.arrayContaining(['code_memory__owns']));
    }
    // Behind the current revision ⇒ marked; back at it ⇒ cleared.
    expect(mark?.sql).toContain('source.sourceVersion.version != $version');
    expect(mark?.sql).toContain('staleAt IS NONE');
    expect(mark?.vars?.['reason']).toBe(SOURCE_DRIFT_REASON);
    expect(clear?.sql).toContain('source.sourceVersion.version = $version');
    // The clear leg touches ONLY marks this sweep wrote — a
    // derived-parent mark from fn::mark_derived_stale means something
    // else entirely and is a different pass's to clear.
    expect(clear?.sql).toContain('staleReason = $reason');
    expect(clear?.sql).toContain('staleAt = NONE, staleReason = NONE');
  });

  it('a sweep failure never fails the submission that has already staged', async () => {
    process.env.PACK_SOURCE_VERSION_STALENESS = '1';
    const surreal = {
      withCompany: (): Promise<never> => Promise.reject(new Error('planner said no')),
    };
    const memoryModels = {
      installedMemoryModels: () =>
        Promise.resolve([{ packId: 'code_memory', packVersion: '0.7.0', memoryModel: model }]),
    };
    const service = new SourceDriftStalenessService(surreal as never, memoryModels as never);
    await expect(
      service.sweep({ companyId: 'c1', packId: 'code_memory', current: STAMP }),
    ).resolves.toMatchObject({ marked: 0, cleared: 0 });
  });
});
