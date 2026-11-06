/**
 * #916 step 2: the safety reading's answer is checked like the affect
 * reading's; signals are served newest first with the last urgent one
 * flagged; the pack declaration is validated and consent-gated.
 */
import {
  SAFETY_READING_SYSTEM,
  parseSafetyReading,
  type SafetyTurn,
} from '../src/affect/safety-reading';
import { shapeSafetySignals } from '../src/entities/affect-signals';
import { validatePack } from '../src/ai/domain-packs/validate';
import { RELATIONSHIP_PACK } from '../src/ai/domain-packs/relationship.pack';
import {
  currentSafetyMonitoring,
  declaredModalitySection,
  modalitiesChecksum,
} from '../src/ai/domain-packs/modality-consent';

const turns: SafetyTurn[] = [
  { handle: 't1', speaker: 'coach', own: false, text: 'How are you holding up?', occurredAt: 'x' },
  {
    handle: 't2',
    speaker: 'Ana',
    own: true,
    text: "Honestly some nights I wish I just wouldn't wake up.",
    occurredAt: 'x',
  },
];

describe('parseSafetyReading', () => {
  it('keeps an own-turn signal with a verbatim quote', () => {
    const out = parseSafetyReading(
      {
        signals: [
          {
            turn: 't2',
            quote: "I wish I just wouldn't wake up",
            level: 'concern',
            confidence: 0.8,
          },
        ],
      },
      turns,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ level: 'concern', handle: 't2' });
  });

  it('drops context turns, invented quotes, unknown levels, out-of-range confidence', () => {
    for (const s of [
      { turn: 't1', quote: 'How are you holding up?', level: 'concern', confidence: 0.5 },
      { turn: 't2', quote: 'I want to die', level: 'urgent', confidence: 0.9 },
      { turn: 't2', quote: 'some nights', level: 'severe', confidence: 0.5 },
      { turn: 't2', quote: 'some nights', level: 'concern', confidence: 1.4 },
    ]) {
      expect(parseSafetyReading({ signals: [s] }, turns)).toEqual([]);
    }
  });

  it('the prompt names idioms, fiction and other people as not this person’s risk', () => {
    expect(SAFETY_READING_SYSTEM).toContain('killing me');
    expect(SAFETY_READING_SYSTEM).toContain("another person's risk");
  });
});

describe('shapeSafetySignals', () => {
  const now = new Date('2026-11-06T12:00:00Z');
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  it('last thirty days, newest first, the last urgent one flagged', () => {
    const s = shapeSafetySignals(
      [
        { id: 'r1', observedAt: ago(40), level: 'urgent', quote: 'old', confidence: 0.9 },
        { id: 'r2', observedAt: ago(5), level: 'urgent', quote: 'a', confidence: 0.9 },
        { id: 'r3', observedAt: ago(1), level: 'concern', quote: 'b', confidence: 0.6 },
      ],
      now,
    )!;
    expect(s.signals.map((x) => x.quote)).toEqual(['b', 'a']);
    expect(s.lastUrgentAt).toBe(ago(5));
  });
  it('nothing in the window → no section', () => {
    expect(
      shapeSafetySignals(
        [{ id: 'r1', observedAt: ago(40), level: 'urgent', quote: 'x', confidence: 1 }],
        now,
      ),
    ).toBeNull();
  });
});

describe('the safetyMonitoring declaration', () => {
  it('relationship declares it; it validates; only accepted consent turns it on', () => {
    expect(RELATIONSHIP_PACK.memoryModel?.safetyMonitoring).toEqual({
      basis: 'vital_interests',
      retentionDays: 180,
    });
    expect(() => validatePack(RELATIONSHIP_PACK)).not.toThrow();
    const section = declaredModalitySection(RELATIONSHIP_PACK);
    const row = {
      manifest: RELATIONSHIP_PACK,
      acceptedModalities: true,
      acceptedModalitiesChecksum: modalitiesChecksum(section),
    };
    expect(currentSafetyMonitoring([row])).toMatchObject({ basis: 'vital_interests' });
    expect(currentSafetyMonitoring([{ ...row, acceptedModalities: false }])).toBeNull();
  });
  it('the basis must be vital interests or a legal obligation', () => {
    const bad = {
      ...RELATIONSHIP_PACK,
      memoryModel: { safetyMonitoring: { basis: 'consent', retentionDays: 30 } as never },
    };
    expect(() => validatePack(bad)).toThrow(/vital_interests/);
  });
});
