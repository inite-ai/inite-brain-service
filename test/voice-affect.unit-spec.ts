/**
 * #916 step 4: voice affect is gated by the deployment context (never at
 * work or in education), needs a pack that declares audio, and keeps only
 * well-formed segments from the operator's service.
 */
import { parseVoiceSegments } from '../src/affect/voice-affect-reader.service';
import {
  currentVoiceAffect,
  declaredModalitySection,
  modalitiesChecksum,
  voiceContextRefusal,
} from '../src/ai/domain-packs/modality-consent';
import { validatePack } from '../src/ai/domain-packs/validate';
import { RELATIONSHIP_PACK } from '../src/ai/domain-packs/relationship.pack';
import type { DomainPackManifest } from '../src/ai/domain-packs/manifest';

const voicePack: DomainPackManifest = {
  ...RELATIONSHIP_PACK,
  id: 'voice_coach',
  memoryModel: {
    modalities: ['text', 'audio'],
    voiceAffectInference: { retentionDays: 30 },
  },
};

describe('voice affect declaration', () => {
  it('needs audio among the modalities', () => {
    expect(() => validatePack(voicePack)).not.toThrow();
    expect(() =>
      validatePack({ ...voicePack, memoryModel: { voiceAffectInference: { retentionDays: 30 } } }),
    ).toThrow(/audio/);
  });

  it('is refused without a deployment context, and at work or in education', () => {
    expect(voiceContextRefusal(voicePack, undefined)).toMatch(/deploymentContext/);
    expect(voiceContextRefusal(voicePack, 'workplace')).toMatch(/prohibits/);
    expect(voiceContextRefusal(voicePack, 'education')).toMatch(/prohibits/);
    expect(voiceContextRefusal(voicePack, 'consumer')).toBeNull();
    expect(voiceContextRefusal(RELATIONSHIP_PACK, 'workplace')).toBeNull();
  });

  it('runs only for an accepted row in an allowed context', () => {
    const row = {
      manifest: voicePack,
      acceptedModalities: true,
      acceptedModalitiesChecksum: modalitiesChecksum(declaredModalitySection(voicePack)),
    };
    expect(currentVoiceAffect([{ ...row, deploymentContext: 'consumer' }])).toEqual({
      retentionDays: 30,
    });
    expect(currentVoiceAffect([{ ...row, deploymentContext: 'workplace' }])).toBeNull();
    expect(currentVoiceAffect([row])).toBeNull();
  });
});

describe('parseVoiceSegments', () => {
  it('keeps in-range segments, drops the rest', () => {
    expect(
      parseVoiceSegments({
        segments: [
          { startMs: 0, endMs: 4000, arousal: 0.7, confidence: 0.8 },
          { startMs: 5000, endMs: 4000, arousal: 0.5, confidence: 0.5 },
          { startMs: 0, endMs: 1000, arousal: 1.4, confidence: 0.5 },
          { startMs: 0, endMs: 1000, arousal: 0.2, valence: -1, confidence: 'x' },
        ],
      }),
    ).toEqual([{ startMs: 0, endMs: 4000, arousal: 0.7, confidence: 0.8 }]);
    expect(parseVoiceSegments(null)).toEqual([]);
  });
});
