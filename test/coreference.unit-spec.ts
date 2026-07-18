import {
  isFirstPersonSelfReference,
  isSecondPersonReference,
  matchesParticipantName,
} from '../src/common/coreference';
import { buildConversationContext } from '../src/ai/extractor-internals/prompts';

describe('coreference helpers', () => {
  it('recognizes first-person-singular self-references (case/punct insensitive)', () => {
    for (const t of ['I', 'i', 'me', 'My', 'mine', 'myself', 'I.', ' me ']) {
      expect(isFirstPersonSelfReference(t)).toBe(true);
    }
  });

  it('does NOT treat first-person PLURAL as a self-reference (ambiguous)', () => {
    for (const t of ['we', 'us', 'our', 'ours', 'ourselves']) {
      expect(isFirstPersonSelfReference(t)).toBe(false);
    }
  });

  it('does not misfire on real names or common words containing the letters', () => {
    for (const t of ['Ivan', 'Mya', 'Mike', 'Melanie', 'informant']) {
      expect(isFirstPersonSelfReference(t)).toBe(false);
    }
  });

  it('recognizes second-person references', () => {
    for (const t of ['you', 'Your', 'yours', 'yourself']) {
      expect(isSecondPersonReference(t)).toBe(true);
    }
    expect(isSecondPersonReference('Melanie')).toBe(false);
  });

  it('matches a participant display name case-insensitively, else not', () => {
    expect(matchesParticipantName('caroline', 'Caroline')).toBe(true);
    expect(matchesParticipantName('Caroline.', 'Caroline')).toBe(true);
    expect(matchesParticipantName('Melanie', 'Caroline')).toBe(false);
    // Guards against undefined on either side.
    expect(matchesParticipantName(undefined, 'Caroline')).toBe(false);
    expect(matchesParticipantName('I', undefined)).toBe(false);
  });
});

describe('buildConversationContext', () => {
  it('is empty (byte-identical extractor input) when no speaker is known', () => {
    expect(buildConversationContext({})).toBe('');
    expect(buildConversationContext({ addresseeName: 'Bob' })).toBe('');
  });

  it('frames the speaker and resolves first-person to them', () => {
    const ctx = buildConversationContext({ speakerName: 'Caroline' });
    expect(ctx).toContain('spoken by "Caroline"');
    expect(ctx).toContain('First-person');
    expect(ctx).toContain('NEVER a bare "I"/"me" node');
    // No addressee → no second-person clause.
    expect(ctx).not.toContain('Second-person');
  });

  it('adds the addressee for second-person resolution when known', () => {
    const ctx = buildConversationContext({
      speakerName: 'Caroline',
      addresseeName: 'Melanie',
    });
    expect(ctx).toContain('addressing "Melanie"');
    expect(ctx).toContain('Second-person');
    expect(ctx).toContain('"Melanie"');
  });
});
