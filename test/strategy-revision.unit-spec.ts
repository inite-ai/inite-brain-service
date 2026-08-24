/**
 * R3 P1 — active strategies are IMMUTABLE to distill/trajectory capture.
 *
 * The dedup-merge UPDATE arm used to call mergeUpdate() on WHATEVER row the
 * arbiter chose — including an already-serving `active` row — silently
 * changing what retrieve() serves and bypassing candidate→active review.
 * The fix: an `active` merge target is NEVER mutated in place; a new
 * `candidate` revision is proposed instead (carrying the merged content +
 * the experience bundle + a supersedesId pointer at the row it supersedes).
 * A `candidate` target (the review buffer, not served) still merges in place.
 *
 * This suite drives StrategyDistillService.distillFromTrajectory through a
 * STUBBED StrategyMemoryService so the merge target's status is controlled
 * exactly. (The real stub embedder's near-orthogonal vectors make the live
 * floor-0 neighbor lookup non-deterministic — the wrong harness for this
 * branch; the service-level DB guarantees are pinned in the e2e instead.)
 */
import { ConfigService } from '@nestjs/config';
import {
  StrategyDistillService,
  type TrajectoryRun,
} from '../src/strategy/strategy-distill.service';
import type {
  CreateStrategyArgs,
  ScoredStrategyItem,
  StrategyItem,
  StrategyMemoryService,
} from '../src/strategy/strategy-memory.service';
import type { ApiKeyService } from '../src/auth/api-key.service';

interface MergeCall {
  id: string;
  patch: Record<string, unknown>;
}

/** Stub store: findSimilar returns a scripted neighbor set; create/mergeUpdate record calls. */
function fakeStrategies(neighbors: ScoredStrategyItem[]) {
  const createCalls: CreateStrategyArgs[] = [];
  const mergeCalls: MergeCall[] = [];
  const svc = {
    isTrajectoriesEnabled: () => true,
    findSimilar: async () => neighbors,
    create: async (_companyId: string, args: CreateStrategyArgs): Promise<StrategyItem> => {
      createCalls.push(args);
      return {
        strategyId: 'strategy_memory:new',
        companyId: 'c1',
        title: args.title,
        situation: args.situation,
        strategy: args.strategy,
        polarity: args.polarity,
        status: args.status ?? 'candidate',
        evidence: args.evidence ?? {},
        scope: 'tenant',
        createdAt: '',
        updatedAt: '',
      } as StrategyItem;
    },
    mergeUpdate: async (
      _companyId: string,
      id: string,
      patch: Record<string, unknown>,
    ): Promise<StrategyItem> => {
      mergeCalls.push({ id, patch });
      return { strategyId: id } as StrategyItem;
    },
  };
  return { svc: svc as unknown as StrategyMemoryService, createCalls, mergeCalls };
}

function distillConfig(): ConfigService {
  const env: Record<string, string> = {
    OPENAI_API_KEY: 'sk-test',
    OPENAI_CHAT_MODEL: 'gpt-4o-mini',
  };
  return {
    get: (k: string, d?: string) => env[k] ?? d,
    getOrThrow: (k: string) => {
      const v = env[k];
      if (v === undefined) throw new Error(`missing ${k}`);
      return v;
    },
  } as unknown as ConfigService;
}

const apiKeysStub = { knownCompanyIds: () => ['c1'] } as unknown as ApiKeyService;

/** Script the distiller's two LLM calls in order: proposal, then merge decision. */
function mockDistillOpenAi(svc: StrategyDistillService, responses: string[]): void {
  let calls = 0;
  const stub = {
    chat: {
      completions: {
        create: async () => {
          const content = responses[calls] ?? responses[responses.length - 1] ?? '{}';
          calls++;
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
  (svc as unknown as { openai: typeof stub }).openai = stub;
}

const PROPOSAL = JSON.stringify({
  items: [
    {
      title: 'proposed lesson',
      situation: 'some situation',
      strategy: 'proposed strategy body',
      polarity: 'do',
    },
  ],
});

function neighbor(status: StrategyItem['status'], id: string): ScoredStrategyItem {
  return {
    strategyId: id,
    companyId: 'c1',
    title: 'existing lesson',
    situation: 'existing situation',
    strategy: 'existing strategy body',
    polarity: 'do',
    status,
    evidence: { nSupport: 3, nContradict: 0 },
    scope: 'tenant',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    similarity: 0.9,
  };
}

const RUN: TrajectoryRun = {
  task: 'do the thing',
  outcome: 'success',
  outcomeEvidenceRef: 'eval:ref#1',
  steps: [{ tool: 'lookup', args: { id: 1 }, result: { ok: true }, ok: true }],
};

function makeDistiller(neighbors: ScoredStrategyItem[]) {
  const { svc, createCalls, mergeCalls } = fakeStrategies(neighbors);
  const distiller = new StrategyDistillService(svc, apiKeysStub, distillConfig());
  return { distiller, createCalls, mergeCalls };
}

describe('R3 P1 — dedup-merge active-immutability branch', () => {
  it('active merge target → a NEW candidate revision (supersedesId + bundle); mergeUpdate is NEVER called', async () => {
    const { distiller, createCalls, mergeCalls } = makeDistiller([
      neighbor('active', 'strategy_memory:act1'),
    ]);
    mockDistillOpenAi(distiller, [
      PROPOSAL,
      JSON.stringify({
        action: 'UPDATE',
        targetId: 'strategy_memory:act1',
        strategy: 'MERGED strategy',
        situation: 'MERGED situation',
      }),
    ]);
    const stats = await distiller.distillFromTrajectory('c1', RUN, 'run-9');

    // The active row is untouched — no in-place merge happened.
    expect(mergeCalls).toHaveLength(0);
    // A revision candidate was created instead.
    expect(createCalls).toHaveLength(1);
    const rev = createCalls[0]!;
    expect(rev.status).toBe('candidate');
    expect(rev.supersedesId).toBe('strategy_memory:act1');
    expect(rev.strategy).toBe('MERGED strategy');
    expect(rev.situation).toBe('MERGED situation');
    // The experience bundle rode along onto the revision.
    expect(rev.verifiedOutcome).toBe('success');
    expect(rev.outcomeEvidenceRef).toBe('eval:ref#1');
    expect(rev.trajectory?.[0]?.tool).toBe('lookup');
    // Stats honestly report a revision, not an update.
    expect(stats).toMatchObject({ proposed: 1, added: 0, updated: 0, revised: 1, noop: 0 });
  });

  it('candidate merge target → in-place mergeUpdate (the review buffer); no revision created', async () => {
    const { distiller, createCalls, mergeCalls } = makeDistiller([
      neighbor('candidate', 'strategy_memory:cand1'),
    ]);
    mockDistillOpenAi(distiller, [
      PROPOSAL,
      JSON.stringify({
        action: 'UPDATE',
        targetId: 'strategy_memory:cand1',
        strategy: 'MERGED strategy',
        situation: 'MERGED situation',
      }),
    ]);
    const stats = await distiller.distillFromTrajectory('c1', RUN, 'run-9');

    // In-place merge of the candidate — exactly the pre-fix behavior.
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0]!.id).toBe('strategy_memory:cand1');
    expect(mergeCalls[0]!.patch.strategy).toBe('MERGED strategy');
    // No revision row for a candidate target.
    expect(createCalls).toHaveLength(0);
    expect(stats).toMatchObject({ proposed: 1, added: 0, updated: 1, revised: 0, noop: 0 });
  });

  it('empty table (no neighbors) → ADD, and never a revision', async () => {
    const { distiller, createCalls, mergeCalls } = makeDistiller([]);
    mockDistillOpenAi(distiller, [PROPOSAL]);
    const stats = await distiller.distillFromTrajectory('c1', RUN);
    expect(mergeCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.status).toBe('candidate');
    expect(createCalls[0]!.supersedesId).toBeUndefined();
    expect(stats).toMatchObject({ added: 1, updated: 0, revised: 0, noop: 0 });
  });
});
