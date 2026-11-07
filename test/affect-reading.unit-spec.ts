/**
 * #909 step 4: the affect reading's answer is checked before anything is
 * written — only the person's own turns, their exact words, values in
 * range, abstention honoured — and the pack declaration that turns the
 * reader on is validated and consent-gated.
 */
import {
  AFFECT_READING_SCHEMA,
  affectReadingUser,
  parseAffectReading,
  type AffectTurn,
} from '../src/affect/affect-reading';
import { validatePack } from '../src/ai/domain-packs/validate';
import { RELATIONSHIP_PACK } from '../src/ai/domain-packs/relationship.pack';
import {
  currentAffectInference,
  declaredModalitySection,
  hasCurrentModalityConsent,
  modalitiesChecksum,
  modalityConsentRequired,
} from '../src/ai/domain-packs/modality-consent';

const turns: AffectTurn[] = [
  { handle: 't1', speaker: 'coach', own: false, text: "How's the week going?", occurredAt: 'x' },
  {
    handle: 't2',
    speaker: 'Ana',
    own: true,
    text: 'Honestly I dread the weigh-in on Friday. Ça va 🙂',
    occurredAt: 'x',
  },
  { handle: 't3', speaker: 'coach', own: false, text: "I'm thrilled for you!", occurredAt: 'x' },
];

const obs = (o: Record<string, unknown>) => ({
  turn: 't2',
  quote: 'I dread the weigh-in on Friday',
  valence: -0.6,
  label: 'fear',
  target: 'the weigh-in',
  confidence: 0.8,
  ...o,
});

describe('parseAffectReading', () => {
  it('keeps a reading of the own turn, with its code-point span', () => {
    const [d] = parseAffectReading({ observations: [obs({})] }, turns);
    expect(d).toMatchObject({ handle: 't2', label: 'fear', target: 'the weigh-in' });
    expect(turns[1]!.text.slice(d!.spanStart, d!.spanEnd)).toBe('I dread the weigh-in on Friday');
  });

  it('drops a reading of a context turn (someone else’s words)', () => {
    expect(
      parseAffectReading(
        { observations: [obs({ turn: 't3', quote: "I'm thrilled for you!" })] },
        turns,
      ),
    ).toEqual([]);
  });

  it('drops a quote the turn does not contain — never repaired', () => {
    expect(parseAffectReading({ observations: [obs({ quote: 'I hate Fridays' })] }, turns)).toEqual(
      [],
    );
  });

  it('drops out-of-range values and unknown labels', () => {
    for (const bad of [
      { valence: 1.5 },
      { confidence: -0.1 },
      { label: 'anxious' },
      { turn: 't9' },
    ]) {
      expect(parseAffectReading({ observations: [obs(bad)] }, turns)).toEqual([]);
    }
  });

  it('a neutral label with no valence is abstention, not an observation', () => {
    expect(
      parseAffectReading({ observations: [obs({ label: 'neutral', valence: 0 })] }, turns),
    ).toEqual([]);
  });

  it('dedupes a span and caps a turn at three', () => {
    const four = ['Honestly', 'I dread', 'the weigh-in', 'on Friday'].map((q) => obs({ quote: q }));
    expect(parseAffectReading({ observations: [obs({}), obs({})] }, turns)).toHaveLength(1);
    expect(parseAffectReading({ observations: four }, turns)).toHaveLength(3);
  });

  it('a malformed answer yields nothing', () => {
    expect(parseAffectReading(null, turns)).toEqual([]);
    expect(parseAffectReading({ observations: 'x' }, turns)).toEqual([]);
  });

  it('the request marks OWN turns and the schema asks for no arousal', () => {
    expect(affectReadingUser('Ana', turns)).toContain('[t2] OWN · Ana');
    expect(affectReadingUser('Ana', turns)).toContain('[t1] context · coach');
    expect(JSON.stringify(AFFECT_READING_SCHEMA)).not.toContain('arousal');
  });
});

describe('the affectInference declaration', () => {
  it('the relationship pack declares text inference, 90 days, and validates', () => {
    expect(RELATIONSHIP_PACK.memoryModel?.affectInference).toEqual({
      from: 'text',
      retentionDays: 90,
    });
    expect(() => validatePack(RELATIONSHIP_PACK)).not.toThrow();
  });

  it('voice is not declarable; retention must be 1..3650 days', () => {
    const withAffect = (affectInference: unknown) => ({
      ...RELATIONSHIP_PACK,
      memoryModel: { affectInference: affectInference as never },
    });
    expect(() => validatePack(withAffect({ from: 'voice', retentionDays: 90 }))).toThrow(
      /biometric/,
    );
    expect(() => validatePack(withAffect({ from: 'text', retentionDays: 0 }))).toThrow(/1\.\.3650/);
  });

  it('it needs operator consent at install, and only current consent turns it on', () => {
    const section = declaredModalitySection(RELATIONSHIP_PACK);
    expect(section?.affectInference).toBeDefined();
    expect(
      modalityConsentRequired({
        packId: 'relationship',
        version: '0.3.0',
        declared: section,
        accepted: undefined,
        priorAccepted: false,
        priorChecksum: null,
      }),
    ).toMatch(/infers how a person feels/);
    const accepted = {
      manifest: RELATIONSHIP_PACK,
      acceptedModalities: true,
      acceptedModalitiesChecksum: modalitiesChecksum(section),
    };
    expect(currentAffectInference([accepted])).toEqual({ from: 'text', retentionDays: 90 });
    expect(
      currentAffectInference([{ ...accepted, acceptedModalitiesChecksum: 'stale' }]),
    ).toBeNull();
    expect(currentAffectInference([{ ...accepted, acceptedModalities: false }])).toBeNull();
  });

  it('consent to reading words is not consent to serving media', () => {
    const section = declaredModalitySection(RELATIONSHIP_PACK);
    expect(
      hasCurrentModalityConsent([
        {
          manifest: RELATIONSHIP_PACK,
          acceptedModalities: true,
          acceptedModalitiesChecksum: modalitiesChecksum(section),
        },
      ]),
    ).toBe(false);
  });
});
