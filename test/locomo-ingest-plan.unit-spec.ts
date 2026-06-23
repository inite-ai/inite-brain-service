/**
 * Coverage for the ingest plan builder.
 *
 * The plan is a pure function over a NormalizedConversation — it tells
 * us, deterministically, what HTTP calls a full ingest would make.
 * Useful for dry-running cost estimates (turns × extractor calls)
 * before paying for a real run.
 */
import { planIngest } from '../test/eval/locomo/ingest';
import { normalizeSample } from '../test/eval/locomo/loader';
import type { LocomoSample } from '../test/eval/locomo/types';

const fixture: LocomoSample = {
  sample_id: 'conv-1',
  conversation: {
    speaker_a: 'Alice Smith',
    speaker_b: 'Bob',
    session_1: [
      { dia_id: 'D1:1', speaker: 'Alice Smith', text: 'hello' },
      { dia_id: 'D1:2', speaker: 'Bob', text: 'hi alice' },
    ],
    session_1_date_time: '2023-05-01T12:00:00Z',
    session_2: [
      { dia_id: 'D2:1', speaker: 'Alice Smith', text: 'how are you' },
    ],
    session_2_date_time: '2023-05-08T12:00:00Z',
  },
  qa: [],
};

describe('LoCoMo ingest planner', () => {
  it('registers both speakers up front, namespaced by sample id', () => {
    const plan = planIngest(normalizeSample(fixture));
    expect(plan.speakers).toHaveLength(2);
    expect(plan.speakers.map((s) => s.entityId)).toEqual([
      'conv_1__alice_smith',
      'conv_1__bob',
    ]);
    expect(plan.speakers.every((s) => s.validFrom.startsWith('2023-05-01')))
      .toBe(true);
  });

  it('emits one mention per turn with the session timestamp', () => {
    const plan = planIngest(normalizeSample(fixture));
    expect(plan.mentions).toHaveLength(3);
    expect(plan.mentions[0]).toMatchObject({
      speakerEntityId: 'conv_1__alice_smith',
      text: 'hello',
      validFrom: '2023-05-01T12:00:00.000Z',
      sourceMessageId: 'locomo:conv-1:D1:1',
    });
    expect(plan.mentions[2]).toMatchObject({
      speakerEntityId: 'conv_1__alice_smith',
      validFrom: '2023-05-08T12:00:00.000Z',
      sourceMessageId: 'locomo:conv-1:D2:1',
    });
  });

  it('sanitises and prefixes speaker names', () => {
    const plan = planIngest(
      normalizeSample({
        ...fixture,
        conversation: { ...fixture.conversation, speaker_a: 'M.A. Singer' },
      }),
    );
    expect(plan.speakers[0].entityId).toBe('conv_1__m_a_singer');
  });

  it('prefixes multiparty speakers under the same sample namespace', () => {
    // Sample where session_3 has a stranger speaker — should still land
    // under conv_1__ so cross-sample cross-talk stays impossible.
    const plan = planIngest(
      normalizeSample({
        ...fixture,
        conversation: {
          ...fixture.conversation,
          session_3: [
            { dia_id: 'D3:1', speaker: 'Carol', text: 'a third party' },
          ],
          session_3_date_time: '2023-05-15T12:00:00Z',
        },
      }),
    );
    const carol = plan.mentions.find((m) => m.text === 'a third party');
    expect(carol?.speakerEntityId).toBe('conv_1__carol');
  });
});
