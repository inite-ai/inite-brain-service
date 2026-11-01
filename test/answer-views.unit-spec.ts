/**
 * synthesize / search_multi_hop / get_entity_profile / get_entity_timeline
 * as a model reads them by default (src/mcp/answer-views.ts,
 * src/mcp/compact-read.ts): the answer or the evidence, never the whole
 * retrieval. Measured on the memory-fitness memory (1986 raw tokens):
 * synthesize 11453, multi-hop 13110, profile 5197, timeline 22554 tokens
 * in their JSON shapes.
 */
import { multiHopView, synthesizeView } from '../src/mcp/answer-views';
import { renderProfile, renderTimeline } from '../src/mcp/compact-read';
import type { SynthesizeResult } from '../src/synthesize/synthesize.types';
import type { MultiHopResult } from '../src/multi-hop/multi-hop.types';
import type { EntityProfile, TimelineEvent } from '../src/entities/entities.service';

const hits = [{ entityId: 'e', canonicalName: 'x', facts: [{ factId: 'f', score: 1 }] }];

describe('synthesizeView', () => {
  it('keeps the answer and its citations and drops the retrieval', () => {
    const out = {
      answer: 'NATS JetStream [f1]',
      citations: [{ factId: 'f1' }],
      results: hits,
      decisionLog: [{}],
    } as unknown as SynthesizeResult;
    const view = synthesizeView(out, 'unused');
    expect(view).toEqual({ answer: 'NATS JetStream [f1]', citations: [{ factId: 'f1' }] });
  });

  it('hands the evidence when there is no answer (harness mode, abstention)', () => {
    const out = {
      answer: null,
      reason: 'harness_mode',
      citations: [],
      results: hits,
    } as unknown as SynthesizeResult;
    expect(synthesizeView(out, 'ledger-sync: queue_backend = NATS JetStream')).toEqual({
      answer: null,
      reason: 'harness_mode',
      citations: [],
      evidence: 'ledger-sync: queue_backend = NATS JetStream',
    });
  });
});

describe('multiHopView', () => {
  it('keeps each hop as its sub-query and how many it kept, plus the evidence', () => {
    const out = {
      isMultiHop: true,
      hops: [
        { hop: { subQuery: 'launching 2026-05-06' }, runningEntityIds: ['a', 'b'], hits },
        { hop: { subQuery: 'integrates with' }, runningEntityIds: ['a'], hits },
      ],
      finalEntityIds: ['a'],
      finalHits: hits,
      supportingFactIds: ['f'],
    } as unknown as MultiHopResult;
    expect(multiHopView(out, 'evidence')).toEqual({
      isMultiHop: true,
      hops: [
        { query: 'launching 2026-05-06', kept: 2 },
        { query: 'integrates with', kept: 1 },
      ],
      evidence: 'evidence',
    });
  });
});

describe('renderProfile', () => {
  it('one line per attribute, every current value with its day, no ids', () => {
    const p = {
      entityId: 'knowledge_entity:ls',
      type: 'project',
      canonicalName: 'ledger-sync',
      externalRefs: {},
      facts: [
        {
          factId: 'f1',
          predicate: 'service_port',
          object: '8443',
          confidence: 0.9,
          validFrom: '2026-03-02T09:00:00Z',
          status: 'active',
        },
        {
          factId: 'f2',
          predicate: 'service_port',
          object: '9464',
          confidence: 0.9,
          validFrom: '1970-01-01T00:00:00Z',
          status: 'active',
        },
        {
          factId: 'f3',
          predicate: 'payout_cutoff',
          object: '17:00 UTC',
          confidence: 0.9,
          validFrom: '2026-03-10T00:00:00Z',
          status: 'competing',
        },
      ],
    } as EntityProfile;
    expect(renderProfile(p)).toBe(
      'ledger-sync (project)\nservice_port: 8443 (2026-03-02) | 9464\npayout_cutoff: 17:00 UTC (2026-03-10) [competing]',
    );
  });
});

describe('renderTimeline', () => {
  it('a retraction names the value it ended and what replaced it', () => {
    const events = [
      {
        type: 'fact.recorded',
        at: '2026-10-29T00:00:00Z',
        validFrom: '2026-03-02T00:00:00Z',
        factId: 'f1',
        predicate: 'queue_backend',
        object: 'Redis Streams',
      },
      {
        type: 'fact.recorded',
        at: '2026-10-29T00:00:00Z',
        validFrom: '2026-03-18T00:00:00Z',
        factId: 'f2',
        predicate: 'queue_backend',
        object: 'NATS JetStream',
      },
      {
        type: 'fact.retracted',
        at: '2026-03-18T00:00:00Z',
        factId: 'f1',
        reason: 'superseded',
        supersededBy: 'f2',
      },
    ] as unknown as TimelineEvent[];
    expect(renderTimeline({ entityId: 'e', events })).toBe(
      [
        '2026-03-02 + queue_backend = Redis Streams',
        '2026-03-18 + queue_backend = NATS JetStream',
        '2026-03-18 − queue_backend = Redis Streams → queue_backend = NATS JetStream',
      ].join('\n'),
    );
  });
});
