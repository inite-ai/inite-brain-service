import { profileGist, timelineEpisodes, timelineGist } from '../src/mcp/entity-views';
import type { EntityProfile, TimelineEvent } from '../src/entities/entities.service';
import type { BeliefReadResult } from '../src/beliefs/beliefs.service';
import type { SceneReadResult } from '../src/scenes/scenes.service';

const fact = (predicate: string, object: string, status = 'active') =>
  ({
    factId: `knowledge_fact:${predicate}${object}`,
    predicate,
    object,
    confidence: 0.9,
    validFrom: '2026-03-02T00:00:00Z',
    status,
  }) as EntityProfile['facts'][number];

const profile = (facts: EntityProfile['facts']): EntityProfile => ({
  entityId: 'knowledge_entity:ls',
  type: 'other',
  canonicalName: 'ledger-sync',
  externalRefs: {},
  facts,
});

const belief = (field: string, value: string, priorValue?: string): BeliefReadResult =>
  ({
    beliefId: `semantic_belief:${field}`,
    userId: 'u1',
    subject: 'ledger-sync',
    field,
    value,
    ...(priorValue ? { priorValue } : {}),
    statement: '',
    statementSource: 'template',
    confidence: 0.9,
    revision: 1,
    status: 'active',
    validFrom: '2026-03-18T10:30:00Z',
    sourceSceneIds: [],
    conversationIds: [],
    corroborationCount: 1,
    conversationCount: 1,
  }) as BeliefReadResult;

const recorded = (predicate: string, object: string, episodeIds: string[]): TimelineEvent => ({
  type: 'fact.recorded',
  at: '2026-03-18T10:30:00Z',
  validFrom: '2026-03-18T10:30:00Z',
  factId: `knowledge_fact:${predicate}`,
  predicate,
  object,
  source: { episodeIds },
  confidence: 0.9,
});

const scene = (episodeIds: string[], deltas: SceneReadResult['stateDeltas']): SceneReadResult =>
  ({
    sceneId: 'memory_episode:s1',
    userIds: ['u1'],
    sceneLabel: '',
    gist: 'composer gist',
    enrichedGist: 'At the review the queue moved to NATS JetStream.',
    occurredFrom: '2026-03-18T09:30:00Z',
    occurredTo: '2026-03-18T10:30:00Z',
    recordedAt: '2026-10-30T00:00:00Z',
    conversationIds: ['c3'],
    episodeIds,
    entityIds: [],
    factIds: [],
    unexpectedDetails: [],
    stateDeltas: deltas,
    confidence: 1,
    segmenterVersion: 'v1',
    enriched: true,
  }) as SceneReadResult;

describe('entity views at the gist level (ReadAgent)', () => {
  it('profile: current state from beliefs, disputes, and an index of every attribute', () => {
    const text = profileGist(
      profile([
        fact('queue_backend', 'NATS JetStream'),
        fact('invariant', 'a'),
        fact('invariant', 'b'),
        fact('payout_cutoff', '17:00 UTC', 'competing'),
        fact('payout_cutoff', '16:30 UTC', 'competing'),
      ]),
      [belief('queue_backend', 'NATS JetStream', 'Redis Streams')],
    )!;
    expect(text).toContain('queue_backend: NATS JetStream (was: Redis Streams) — since 2026-03-18');
    expect(text).toContain('payout_cutoff: 17:00 UTC | 16:30 UTC');
    expect(text).toContain(
      'recorded: 5 current facts — invariant ×2, payout_cutoff ×2, queue_backend',
    );
    // Fact values beyond the state are not repeated — they are one call away.
    expect(text).not.toContain('invariant: a');
  });

  it('profile: no belief → no gist (the caller lists the facts)', () => {
    expect(profileGist(profile([fact('a', 'b')]), [])).toBeNull();
  });

  it("timeline: each scene's gist with this entity's changes, then facts from no scene", () => {
    const events = [
      recorded('queue_backend', 'NATS JetStream', ['episode:t1']),
      recorded('feature_flag_prefix', 'LSYNC_', []),
    ];
    expect(timelineEpisodes(events)).toEqual(['episode:t1']);
    const text = timelineGist({ canonicalName: 'ledger-sync', events }, [
      scene(
        ['episode:t1'],
        [
          {
            subject: 'Ledger-Sync',
            field: 'queue_backend',
            from: 'Redis Streams',
            to: 'NATS JetStream',
          },
          { subject: 'meridian', field: 'cutoff', to: '16:30' },
        ],
      ),
    ])!;
    expect(text.split('\n')).toEqual([
      '2026-03-18 · At the review the queue moved to NATS JetStream.',
      '  queue_backend: Redis Streams → NATS JetStream',
      'not from a conversation:',
      '2026-03-18 + feature_flag_prefix = LSYNC_',
    ]);
  });

  it('timeline: no visible scene → no gist', () => {
    expect(timelineGist({ events: [recorded('a', 'b', ['episode:x'])] }, [])).toBeNull();
  });
});
