/**
 * A rebuilt scene keeps what was paid for it when it is the same scene.
 * Before, every settle of a conversation re-enriched its whole history
 * (LLM spend audit, 2026-10-28).
 */
import { carrySceneEnrichment, sceneMemberHash } from '../src/admin/scene-carry';

const h = sceneMemberHash(['episode:1', 'episode:2']);

function fresh(id: string, memberHash: string, gist = 'Sasha bought a bike') {
  return { id, gist, source: { recorder: 'scene', memberHash } } as Record<string, unknown>;
}

const enriched = {
  id: 'memory_episode:a',
  gist: 'Sasha bought a bike',
  source: { recorder: 'scene', memberHash: h },
  enrichedGist: 'Sasha got a Kawasaki Ninja.',
  enrichmentVersion: 'v7|luna',
  enrichmentModel: 'gpt-6-luna',
  enrichedAt: new Date(0),
  gistEmbedding: [0.1, 0.2],
  consolidatedInto: ['knowledge_fact:x'],
  baselineRef: null,
};

describe('carrying scene enrichment across a rebuild', () => {
  it('an unchanged scene inherits its enrichment, gist vector and promotion link', () => {
    const rows = [fresh('memory_episode:a', h)];
    expect(carrySceneEnrichment(rows, [enriched])).toBe(1);
    expect(rows[0]).toMatchObject({
      enrichedGist: 'Sasha got a Kawasaki Ninja.',
      enrichmentVersion: 'v7|luna',
      gistEmbedding: [0.1, 0.2],
      consolidatedInto: ['knowledge_fact:x'],
    });
    // NULL never reaches a SCHEMAFULL option<> field.
    expect(rows[0]).not.toHaveProperty('baselineRef');
  });

  it('a scene whose members changed is new: nothing is carried, the enricher pays once', () => {
    const rows = [
      fresh('memory_episode:a', sceneMemberHash(['episode:1', 'episode:2', 'episode:3'])),
    ];
    expect(carrySceneEnrichment(rows, [enriched])).toBe(0);
    expect(rows[0]).not.toHaveProperty('enrichmentVersion');
  });

  it('a changed gist or a different id is not the same scene', () => {
    const regist = [fresh('memory_episode:a', h, 'Sasha sold the bike')];
    const moved = [fresh('memory_episode:b', h)];
    expect(carrySceneEnrichment(regist, [enriched])).toBe(0);
    expect(carrySceneEnrichment(moved, [enriched])).toBe(0);
  });

  it('a scene written before member hashes carries nothing (one re-enrichment, then stable)', () => {
    const legacy = { ...enriched, source: { recorder: 'scene' } };
    expect(carrySceneEnrichment([fresh('memory_episode:a', h)], [legacy])).toBe(0);
  });

  it('member order matters: the same turns in another order are another scene', () => {
    expect(sceneMemberHash(['a', 'b'])).not.toBe(sceneMemberHash(['b', 'a']));
  });
});
